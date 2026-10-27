import asyncio
import base64
import json
import time

import httpx
import pytest

from arbbot.budget import RequestBudget
from arbbot.http import make_client
from arbbot.jito import JitoClient, JitoError
from arbbot.jupiter import JupiterClient
from arbbot.solana.keys import Keypair, associated_token_address
from arbbot.solana.rpc import Rpc, RpcError
from arbbot.solana.ws import RpcWebSocket, ws_url_from
from arbbot.wallet import BalanceCache, get_balances, token_amount_from_data, wallet_value_usd
from arbbot.config import USDC_MINT, USDT_MINT


def run(coro):
    return asyncio.run(coro)


# --- request budget -------------------------------------------------------------

def test_budget_says_exactly_how_long_to_wait():
    b = RequestBudget(5)
    for t in range(5):
        b.record(t * 1000)
    assert b.used(4_000) == 5
    assert b.wait_for(1, 4_000) == 56_100
    assert b.wait_for(2, 4_000) == 57_100
    assert b.wait_for(1, 60_001) == 0
    assert b.used(60_001) == 4


def test_budget_never_exceeds_any_window_when_respected():
    b = RequestBudget([(60_000, 58), (10_000, 9)])
    sent, now = [], 0.0
    for _ in range(400):
        now += b.wait_for(2, now)
        b.record(now)
        b.record(now + 300)
        sent += [now, now + 300]
        now += 300
    for t in sent:
        assert sum(1 for x in sent if t - 10_000 < x <= t) <= 9
        assert sum(1 for x in sent if t - 60_000 < x <= t) <= 58
    assert len(sent) / (sent[-1] - sent[0]) * 60_000 > 45


def test_budget_free_room_now():
    b = RequestBudget([(60_000, 10), (10_000, 3)])
    assert b.available(1_000) == 3
    b.record(1_000)
    b.record(2_000)
    assert b.available(2_000) == 1
    b.record(3_000)
    assert b.available(3_000) == 0
    assert b.available(13_500) == 3
    assert RequestBudget(5).available(0) == 5


# --- Jupiter, Jito, RPC ------------------------------------------------------------

def test_jupiter_key_goes_in_a_header_and_requests_are_counted():
    calls = []

    def handler(req: httpx.Request):
        calls.append(req)
        body = {"inAmount": "1", "outAmount": "1", "routePlan": []} if "/quote" in req.url.path else {"swapInstruction": {}}
        return httpx.Response(200, json=body)

    async def go():
        counted = []
        async with make_client(transport=httpx.MockTransport(handler)) as c:
            jup = JupiterClient("https://api.jup.ag/swap/v1", c, "secret-key-123", on_request=lambda: counted.append(1))
            await jup.quote("A", "B", 1, 0, max_accounts=28)
            await jup.swap_instructions({}, "owner")
            plain = JupiterClient("https://lite-api.jup.ag/swap/v1", c)
            await plain.quote("A", "B", 1, 0)
        return counted

    assert len(run(go())) == 2
    for c in calls[:2]:
        assert c.headers["x-api-key"] == "secret-key-123"
        assert "secret-key-123" not in str(c.url)
    assert calls[0].url.params["maxAccounts"] == "28"
    assert calls[0].url.params["restrictIntermediateTokens"] == "true"
    assert "x-api-key" not in calls[2].headers


def test_a_hung_request_times_out():
    async def hang(req):
        await asyncio.sleep(5)
        return httpx.Response(200)

    async def go():
        async with make_client(timeout_s=0.05, transport=httpx.MockTransport(hang)) as c:
            started = time.time()
            with pytest.raises(Exception):
                await asyncio.wait_for(c.get("https://x"), 0.2)
            return time.time() - started

    assert run(go()) < 2


def test_jito_errors_are_clear_refusals():
    def handler(req):
        if "getTipAccounts" in req.url.path:
            return httpx.Response(200, json={"result": ["tip1"]})
        return httpx.Response(429, text="rate limited")

    async def go():
        async with make_client(transport=httpx.MockTransport(handler)) as c:
            j = JitoClient("https://jito", c)
            assert await j.get_tip_accounts() == ["tip1"]
            with pytest.raises(JitoError, match="Jito sendTransaction 429"):
                await j.send_transaction("AA==")

    run(go())


def test_rpc_calls_and_errors():
    owner = Keypair.generate().public_key
    seen = []

    def handler(req):
        body = json.loads(req.content)
        seen.append(body)
        m = body["method"]
        if m == "getBalance":
            return httpx.Response(200, json={"result": {"context": {"slot": 1}, "value": 50_000_000}})
        if m == "getTokenAccountsByOwner":
            acc = lambda mint, amt: {"pubkey": "x", "account": {"lamports": 2_039_280, "data": {"parsed": {"info": {"mint": mint, "tokenAmount": {"amount": amt}}}}}}  # noqa: E731
            return httpx.Response(200, json={"result": {"value": [acc(USDC_MINT, "25000000"), acc("Other", "5"),
                                                                  acc(USDT_MINT, "3000000")]}})
        if m == "sendTransaction":
            return httpx.Response(200, json={"error": {"code": -32002, "message": "Transaction simulation failed"}})
        if m == "getAccountInfo":
            data = bytes(56) + bytes(range(32))
            return httpx.Response(200, json={"result": {"value": {"data": [base64.b64encode(data).decode(), "base64"]}}})
        return httpx.Response(500, text="boom")

    async def go():
        async with make_client(transport=httpx.MockTransport(handler)) as c:
            rpc = Rpc("https://rpc", c)
            b = await get_balances(rpc, owner)
            usdt = await get_balances(rpc, owner, USDT_MINT)
            with pytest.raises(RpcError, match="simulation failed"):
                await rpc.send_transaction(b"\0")
            with pytest.raises(RuntimeError, match="RPC getSlot 500"):
                await rpc.get_slot()
            table = await rpc.get_address_lookup_table("T")
            cache = BalanceCache(rpc, owner)
            await cache.get(0)
            await cache.get(30_000)
            n = len(seen)
            await cache.get(60_000)
            return b, usdt, table, len(seen) - n

    b, usdt, table, refreshed = run(go())
    assert (b.lamports, b.base_atoms, b.rent_lamports, b.other_stable_atoms) == (50_000_000, 25_000_000, 6_117_840, 3_000_000)
    # Both stablecoins count toward the wallet's value; only the base is traded.
    assert wallet_value_usd(b, 100) == pytest.approx(28 + 0.05611784 * 100)
    assert (usdt.base_atoms, usdt.other_stable_atoms) == (3_000_000, 25_000_000)
    assert wallet_value_usd(usdt, 100) == pytest.approx(wallet_value_usd(b, 100))
    assert len(table.addresses) == 1
    assert refreshed == 2  # cache refreshed after a minute (balance + token accounts)
    assert token_amount_from_data(bytes(64) + (123).to_bytes(8, "little")) == 123
    with pytest.raises(ValueError):
        token_amount_from_data(bytes(10))


# --- WebSocket ----------------------------------------------------------------

def test_ws_url_like_web3js():
    assert ws_url_from("https://mainnet.helius-rpc.com/?api-key=k") == "wss://mainnet.helius-rpc.com/?api-key=k"
    assert ws_url_from("http://127.0.0.1:18890") == "ws://127.0.0.1:18891"


def test_websocket_subscribes_reconnects_and_never_waits_for_replies():
    import websockets

    async def go():
        connections = []
        state = {"answer_unsubscribe": False}

        async def server(ws):
            connections.append(ws)
            async for raw in ws:
                m = json.loads(raw)
                if m["method"] in ("accountSubscribe", "slotSubscribe"):
                    sid = 100 + len(connections) * 10 + m["id"]
                    await ws.send(json.dumps({"jsonrpc": "2.0", "result": sid, "id": m["id"]}))
                    note = "accountNotification" if m["method"] == "accountSubscribe" else "slotNotification"
                    result = {"context": {"slot": 7}, "value": {}} if note == "accountNotification" else {"slot": 8}
                    await ws.send(json.dumps({"jsonrpc": "2.0", "method": note, "params": {"subscription": sid, "result": result}}))
                elif m["method"].endswith("Unsubscribe") and state["answer_unsubscribe"]:
                    await ws.send(json.dumps({"jsonrpc": "2.0", "result": True, "id": m["id"]}))
                # otherwise: never answer (a half-dead server)

        async with websockets.serve(server, "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            ws = RpcWebSocket(f"ws://127.0.0.1:{port}", backoff_max_s=0.2)
            got = []
            a = ws.account_subscribe("Pool111", lambda slot: got.append(("acct", slot)))
            ws.slot_subscribe(lambda slot: got.append(("slot", slot)))
            for _ in range(50):
                if len(got) >= 2:
                    break
                await asyncio.sleep(0.05)
            t0 = time.time()
            ws.unsubscribe(a)  # the server never answers: must return at once
            assert time.time() - t0 < 0.05
            # Server drops the connection: the client reconnects and resubscribes the rest.
            await connections[0].close()
            for _ in range(80):
                if len(connections) >= 2 and got.count(("slot", 8)) >= 2:
                    break
                await asyncio.sleep(0.05)
            await ws.close()
            return got, len(connections)

    got, conns = run(go())
    assert ("acct", 7) in got
    assert got.count(("slot", 8)) >= 2
    assert conns >= 2
    assert got.count(("acct", 7)) == 1  # the unsubscribed account was not resubscribed
