"""
`benchmark`: measures, from this device, how long each step the bot depends
on really takes. Nothing is signed or sent. Results go to data/benchmark.json
(same camelCase fields as before) so the report can quote measured numbers,
not guesses.
"""

import asyncio
import math
import os
import sys
from dataclasses import dataclass
from typing import Awaitable, Callable

from .atomic import write_json_atomic
from .config import SOL_MINT, USDC_MINT, is_real_money, jupiter_ms_per_request
from .util import js_round, now_ms, to_fixed


def summarize(ms: list[float], errors: int = 0) -> dict:
    if not ms:
        return {"n": 0, "errors": errors, "medianMs": None, "p90Ms": None, "minMs": None, "maxMs": None}
    s = sorted(ms)
    mid = len(s) // 2
    return {
        "n": len(s),
        "errors": errors,
        "medianMs": s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2,
        "p90Ms": s[min(len(s) - 1, math.ceil(0.9 * len(s)) - 1)],
        "minMs": s[0],
        "maxMs": s[-1],
    }


@dataclass
class BenchDeps:
    now: Callable[[], float]
    sleep: Callable[[float], Awaitable[None]]  # milliseconds
    rpc_slot: Callable[[], Awaitable]
    rpc_blockhash: Callable[[], Awaitable]
    #: None while the bot runs: it already uses the whole Jupiter limit.
    quote: Callable[[str, str, int], Awaitable[dict]] | None = None
    #: Jito round trip (no sending); None when not using Jito.
    jito_tips: Callable[[], Awaitable] | None = None
    #: Subscribe to an account for `ms`; returns (notifications seen, ms to the first one).
    watch_account: Callable[[str, float], Awaitable[tuple[int, float | None]]] | None = None
    #: Subscribe to new slots for `ms` (WebSocket health check).
    watch_slots: Callable[[float], Awaitable[tuple[int, float | None]]] | None = None


@dataclass
class BenchOptions:
    rpc_samples: int
    quote_samples: int
    #: Spacing between Jupiter requests (stay inside the rate limit).
    jupiter_gap_ms: float
    watch_ms: float
    #: USDC amount for test quotes (atoms).
    amount_atoms: int


async def _sample(n: int, fn, now, sleep, gap_ms: float = 0) -> dict:
    ms: list[float] = []
    errors = 0
    for i in range(n):
        if i and gap_ms:
            await sleep(gap_ms)
        t0 = now()
        try:
            await fn()
            ms.append(now() - t0)
        except Exception:  # noqa: BLE001 - counted as an error
            errors += 1
    return summarize(ms, errors)


async def run_benchmark(d: BenchDeps, o: BenchOptions, progress: Callable[[str], None] = lambda line: None) -> dict:
    def say(name: str, s: dict) -> None:
        timing = "FAILED" if s["medianMs"] is None else f"median {js_round(s['medianMs'])} ms, p90 {js_round(s['p90Ms'])} ms"
        errors = f", {s['errors']} errors" if s["errors"] else ""
        progress(f"{name.ljust(30)} {timing}  (n={s['n']}{errors})")

    rpc_slot = await _sample(o.rpc_samples, d.rpc_slot, d.now, d.sleep)
    say("RPC getSlot", rpc_slot)
    rpc_blockhash = await _sample(max(1, math.ceil(o.rpc_samples / 2)), d.rpc_blockhash, d.now, d.sleep)
    say("RPC getLatestBlockhash", rpc_blockhash)

    last_quote: dict | None = None
    quote_leg = quote_round_trip = None
    if d.quote:
        quote = d.quote

        async def one_leg():
            nonlocal last_quote
            last_quote = await quote(USDC_MINT, SOL_MINT, o.amount_atoms)

        quote_leg = await _sample(o.quote_samples, one_leg, d.now, d.sleep, o.jupiter_gap_ms)
        say("Jupiter quote (one leg)", quote_leg)
        # A full round trip: buy, then sell exactly what was bought, back to back (what a scan does).
        await d.sleep(o.jupiter_gap_ms)

        async def round_trip():
            buy = await quote(USDC_MINT, SOL_MINT, o.amount_atoms)
            await quote(SOL_MINT, USDC_MINT, int(buy["outAmount"]))

        quote_round_trip = await _sample(max(1, math.ceil(o.quote_samples / 2)), round_trip, d.now, d.sleep, o.jupiter_gap_ms * 2)
        say("Jupiter round trip (2 legs)", quote_round_trip)
    else:
        progress(f"{'Jupiter'.ljust(30)} skipped: the bot is running and uses the whole request limit (it times its own quotes: see npm run status)")

    jito = None
    if d.jito_tips:
        jito = await _sample(3, d.jito_tips, d.now, d.sleep)
        say("Jito block engine", jito)

    slots_per_sec = None
    if d.watch_slots:
        try:
            events, first = await d.watch_slots(5_000)
            slots_per_sec = events / 5
            progress(
                f"{'WebSocket (new blocks)'.ljust(30)} {to_fixed(slots_per_sec, 1)}/s"
                + (f", first after {js_round(first)} ms" if first is not None else " (none: the WebSocket may be blocked)")
            )
        except Exception as err:  # noqa: BLE001
            progress(f"{'WebSocket (new blocks)'.ljust(30)} FAILED: {str(err)[:100]}")

    pool = None
    route = (last_quote or {}).get("routePlan") or []
    account = (route[0].get("swapInfo") or {}).get("ammKey") if route else None
    if d.watch_account and account:
        progress(f"Watching the SOL/USDC pool Jupiter routed through, for {js_round(o.watch_ms / 1000)}s...")
        try:
            events, first = await d.watch_account(account, o.watch_ms)
            seconds = o.watch_ms / 1000
            seconds = int(seconds) if float(seconds).is_integer() else seconds
            pool = {"account": account, "seconds": seconds, "events": events, "perMin": events / o.watch_ms * 60_000, "firstMs": first}
            progress(f"{'Pool updates (WebSocket)'.ljust(30)} {events} in {seconds}s (~{to_fixed(pool['perMin'], 0)}/min)")
        except Exception as err:  # noqa: BLE001
            progress(f"{'Pool updates (WebSocket)'.ljust(30)} FAILED: {str(err)[:100]}")

    rt_median = (quote_round_trip or {}).get("medianMs")
    result = {
        "ts": d.now(),
        "rpcSlot": rpc_slot,
        "rpcBlockhash": rpc_blockhash,
        "quoteLeg": quote_leg,
        "quoteRoundTrip": quote_round_trip,
        "jito": jito,
        "pool": pool,
        "slotsPerSec": slots_per_sec,
        "minGapLifetimeMs": None if rt_median is None else rt_median * 2,
    }
    return {k: v for k, v in result.items() if v is not None or k == "minGapLifetimeMs"}


def explain(r: dict) -> list[str]:
    """Plain-language reading of the numbers."""
    out: list[str] = []
    if r.get("minGapLifetimeMs") is not None:
        out.append(
            f"A gap must last at least ~{js_round(r['minGapLifetimeMs'])} ms for this bot to even confirm it "
            "(a 2-leg quote, then a fresh re-quote), before building, simulating and sending."
        )
        out.append(
            "Solana makes a block every ~400 ms; professional bots act within the same block, "
            "so gaps that close faster than that are out of reach."
        )
    p = r.get("pool")
    if p:
        if p["events"] == 0:
            out.append(
                f"No updates arrived for the SOL/USDC pool in {p['seconds']}s: it was quiet, or the WebSocket is blocked "
                "(then event triggers can't work here; EVENT_TRIGGERS=off saves the connection)."
            )
        elif p["perMin"] > 30:
            out.append(
                f"The SOL/USDC pool changed ~{to_fixed(p['perMin'], 0)} times a minute: too busy to be a useful trigger "
                "(the bot rests pools like this)."
            )
        else:
            out.append(f"The SOL/USDC pool changed ~{to_fixed(p['perMin'], 0)} times a minute.")
    if r.get("slotsPerSec") is not None and r["slotsPerSec"] < 1:
        out.append("The WebSocket delivered few or no new-block notices: event triggers will not work well over this connection.")
    return out


async def _watch(ws, subscribe, ms: float) -> tuple[int, float | None]:
    started = now_ms()
    seen = {"n": 0, "first": None}

    def on_event(_slot):
        seen["n"] += 1
        if seen["first"] is None:
            seen["first"] = now_ms() - started

    sub_id = subscribe(on_event)
    await asyncio.sleep(ms / 1000)
    ws.unsubscribe(sub_id)
    return seen["n"], seen["first"]


async def _main(cfg) -> None:
    from .http import make_client
    from .jito import JitoClient
    from .jupiter import JupiterClient
    from .solana.rpc import Rpc
    from .solana.ws import RpcWebSocket, ws_url_from
    from .status_file import is_alive, read_status

    async with make_client() as http:
        rpc = Rpc(cfg.rpc_url, http)
        jup = JupiterClient(cfg.jupiter_api, http, cfg.jupiter_api_key)
        ws = RpcWebSocket(cfg.rpc_ws_url or ws_url_from(cfg.rpc_url))
        live = read_status(os.path.join(cfg.data_dir, "status.json"))
        bot_running = bool(live) and live.get("state") != "stopped" and is_alive(live.get("pid"))
        print("Measuring latency from this device. Nothing is signed or sent; this takes about a minute.\n")

        async def sleep_ms(ms: float) -> None:
            await asyncio.sleep(ms / 1000)

        try:
            result = await run_benchmark(
                BenchDeps(
                    now=now_ms,
                    sleep=sleep_ms,
                    rpc_slot=rpc.get_slot,
                    rpc_blockhash=rpc.get_latest_blockhash,
                    quote=None if bot_running else (lambda i, o, a: jup.quote(i, o, a, 50)),
                    jito_tips=(lambda: JitoClient(cfg.jito_url, http).get_tip_accounts())
                    if cfg.send_via == "jito" or is_real_money(cfg.mode) else None,
                    watch_account=lambda account, ms: _watch(ws, lambda cb: ws.account_subscribe(account, cb), ms),
                    watch_slots=lambda ms: _watch(ws, ws.slot_subscribe, ms),
                ),
                # Twice the bot's own spacing, so a running bot and the benchmark together stay under the limit.
                BenchOptions(rpc_samples=10, quote_samples=6, jupiter_gap_ms=jupiter_ms_per_request(cfg.jupiter_rpm) * 2,
                             watch_ms=20_000, amount_atoms=20_000_000),
                print,
            )
        finally:
            await ws.close()
    print("")
    for line in explain(result):
        print(f"- {line}")
    path = os.path.join(cfg.data_dir, "benchmark.json")
    write_json_atomic(path, result, pretty=True)
    print(f"\nSaved to {path} (npm run report shows it).")


def main(load_cfg) -> int:
    try:
        asyncio.run(_main(load_cfg()))
        return 0
    except Exception as err:  # noqa: BLE001
        print(str(err), file=sys.stderr)
        return 1
