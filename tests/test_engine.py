"""The main loop against in-process fake Jupiter and RPC services (nothing leaves this machine)."""

import asyncio
import json
import os

import httpx
import pytest

from arbbot import engine as engine_mod
from arbbot.config import USDC_MINT, load_config
from arbbot.engine import EXIT_REFUSED, Engine
from arbbot.killswitch import disable_trading
from arbbot.solana.keys import Keypair

GAP = Keypair.generate().public_key
FLAT = Keypair.generate().public_key


def handler(seen: list):
    def handle(req: httpx.Request) -> httpx.Response:
        if req.url.host == "jup.mock":
            p = req.url.params
            amount = int(p["amount"])
            seen.append(("quote", p["inputMint"], p["outputMint"]))
            if p["inputMint"] == USDC_MINT:
                out = amount * 2
            elif p["inputMint"] == GAP:
                out = amount * 101 // 200  # a 1% gap
            else:
                out = amount * 997 // 2000
            return httpx.Response(200, json={
                "inputMint": p["inputMint"], "outputMint": p["outputMint"], "inAmount": str(amount), "outAmount": str(out),
                "otherAmountThreshold": str(out), "slippageBps": 0, "priceImpactPct": "0",
                "routePlan": [{"percent": 100, "swapInfo": {"label": "Mock", "ammKey": "Pool" + p["outputMint"][:8]}}],
            })
        body = json.loads(req.content)
        seen.append(("rpc", body["method"]))
        if body["method"] == "getMultipleAccounts":
            mint = {"data": {"program": "spl-token", "parsed": {"type": "mint", "info": {"decimals": 6, "mintAuthority": None, "freezeAuthority": None}}}}
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": {"context": {"slot": 1}, "value": [mint for _ in body["params"][0]]}})
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": 1})

    return handle


def config(tmp_path, **extra):
    env = {
        "DATA_DIR": str(tmp_path), "TOKENS": f"GAP:{GAP},FLAT:{FLAT}", "TOKEN_DISCOVERY": "off", "EVENT_TRIGGERS": "off",
        "TRIANGLES": "off", "SCAN_INTERVAL_MS": "10", "MIN_SCAN_INTERVAL_MS": "10", "JUPITER_RPM": "6000",
        "JUPITER_API": "https://jup.mock/swap/v1", "RPC_URL": "https://rpc.mock",
    }
    env.update(extra)
    return load_config(env)


def run_engine(cfg, monkeypatch, until, timeout_s=10.0):
    seen: list = []
    monkeypatch.setattr(engine_mod, "make_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler(seen))))

    async def go():
        e = Engine(cfg)

        async def stopper():
            deadline = asyncio.get_running_loop().time() + timeout_s
            while not until() and asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(0.05)
            e.stop()

        task = asyncio.create_task(stopper())
        code = await e.run()
        await task
        return code

    return asyncio.run(go()), seen


def read_jsonl(path):
    return [json.loads(l) for l in open(path)] if os.path.exists(path) else []


def test_paper_quote_only_acts_on_gap_records_everything_and_never_builds(tmp_path, monkeypatch):
    cfg = config(tmp_path)
    opps_path = tmp_path / "opps-paper.jsonl"
    code, seen = run_engine(cfg, monkeypatch, lambda: len(read_jsonl(opps_path)) >= 2)
    assert code == 0
    opps = read_jsonl(opps_path)
    assert len(opps) >= 2
    assert {o["symbol"] for o in opps} == {"GAP"}
    o = opps[0]
    assert o["id"].startswith("opp_") and o["stage"] == "executable" and o["result"] == "filled"
    assert o["executable"]["netBps"] > 0 and o["lat"]["totalMs"] >= 0
    trades = read_jsonl(tmp_path / "trades-paper.jsonl")
    assert trades and all(t["basis"] == "quoted" and t["verified"] is False for t in trades)
    # Quote-only paper mode builds and sends nothing.
    assert not any(s[0] == "rpc" and s[1] in ("sendTransaction", "simulateTransaction") for s in seen)
    status = json.load(open(tmp_path / "status.json"))
    assert status["state"] == "stopped" and status["mode"] == "paper"
    brain = json.load(open(tmp_path / "brain-paper.json"))
    assert brain["totalScans"] > 0 and "GAP" in brain["tokens"]
    assert json.load(open(tmp_path / "token-safety.json"))[GAP]["chain"]["program"] == "spl-token"


def test_kill_switch_stops_trading_until_reenabled(tmp_path, monkeypatch):
    cfg = config(tmp_path)
    disable_trading(cfg.data_dir, "test stop")
    status_path = tmp_path / "status.json"

    def disabled_seen():
        return status_path.exists() and json.load(open(status_path)).get("state") == "disabled"

    code, seen = run_engine(cfg, monkeypatch, disabled_seen)
    assert code == 0
    assert not (tmp_path / "opps-paper.jsonl").exists()
    # Only the SOL price was quoted; no scan ran while trading was disabled.
    assert sum(1 for s in seen if s[0] == "quote") == 1


def test_refuses_live_without_proof_and_honours_halt(tmp_path, monkeypatch):
    key = Keypair.generate().secret_base58()
    cfg = config(tmp_path, MODE="live", LIVE_TRADING_CONFIRM="yes", PRIVATE_SIGNING_KEY=key)
    monkeypatch.setenv("PRIVATE_SIGNING_KEY", key)
    code, seen = run_engine(cfg, monkeypatch, lambda: True)
    assert code == EXIT_REFUSED and seen == []

    (tmp_path / "HALTED").write_text("loss floor hit\n")
    code, seen = run_engine(config(tmp_path), monkeypatch, lambda: True)
    assert code == EXIT_REFUSED and seen == []


def test_stop_cuts_sleep_short():
    async def go():
        e = Engine(config_for_sleep())
        t = asyncio.get_running_loop().time()
        asyncio.get_running_loop().call_later(0.05, e.stop)
        await e.sleep(5_000, idle=True)
        await e.sleep(5_000)  # already stopping: returns at once
        return asyncio.get_running_loop().time() - t

    assert asyncio.run(go()) < 1


def config_for_sleep():
    return load_config({"DATA_DIR": "/nonexistent-unused"})
