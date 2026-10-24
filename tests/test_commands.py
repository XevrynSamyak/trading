import asyncio
import json
from datetime import datetime, timezone

import pytest

from arbbot.backtest import outcome_of, render_backtest, scenarios, size_policies, survival_by_age
from arbbot.benchmark import BenchDeps, BenchOptions, explain, run_benchmark, summarize
from arbbot.check import limits_line, mask_url
from arbbot.config import load_config
from arbbot.gate import GateResult, Verdict
from arbbot.probes import ProbeLog
from arbbot.report import ReportData, build_report_data, render_report, risk_status
from arbbot.stats import LearningStats

T0 = int(datetime(2026, 10, 5, 10, tzinfo=timezone.utc).timestamp() * 1000)
DAY = 86_400_000


def rec(**o):
    r = {
        "id": "opp_x", "ts": T0, "mode": "paper", "kind": "two-leg", "symbol": "SOL", "tokens": ["SOL"], "route": "A | B", "sizeUsd": 20,
        "quoted": {"netUsd": 0.05, "netBps": 25, "grossBps": 30}, "expected": {"pSuccess": 0.5, "evUsd": 0.02, "assumed": []},
        "costs": {"baseFeeUsd": 0, "priorityFeeUsd": 0, "tipUsd": 0, "tipLamports": 0, "bufferUsd": 0, "totalUsd": 0, "dexFeeBps": 0, "priceImpactBps": 5},
        "result": "filled", "t": {"quoteStart": T0, "quoteEnd": T0 + 300, "decision": T0 + 301},
        "lat": {"quoteMs": 300, "quoteToDecisionMs": 1, "totalMs": 301},
    }
    r.update(o)
    return r


def stale(**o):
    return rec(stage="quoted", result="stale", **o)


def sim(net, **o):
    return rec(**{"stage": "simulated", "simulated": {"netUsd": net, "netBps": net * 500, "ok": True},
                  "executable": {"netUsd": net, "netBps": 5, "grossBps": 9}, **o})


def real(net, result="filled"):
    return rec(mode="micro", stage="submitted" if result == "timeout" else "profitable" if net > 0 else "landed", result=result,
               realized={"netUsd": net, "netBps": net * 500, "landed": result != "timeout", "signature": "sig"})


# ---- backtest -------------------------------------------------------------------------

def test_outcome_prefers_realized_then_simulated_never_quotes():
    o = outcome_of([stale(), sim(0.01), sim(-0.002)])
    assert (o.acted, o.executable, o.simulated_ok, o.landed, o.money_basis) == (3, 2, 2, 0, "simulated")
    assert o.money_usd == pytest.approx(0.008)
    assert o.quoted_usd == pytest.approx(0.15)
    r = outcome_of([rec(mode="micro", stage="profitable", realized={"netUsd": 0.004, "netBps": 2, "landed": True}), sim(1)])
    assert (r.money_basis, r.landed, r.profitable) == ("realized", 1, 1)
    assert r.money_usd == pytest.approx(0.004)
    assert outcome_of([stale()]).money_basis == "none"


def test_scenarios():
    opps = [
        sim(0.02, quoted={"netUsd": 0.2, "netBps": 120, "grossBps": 130}, symbol="JUP"),
        sim(-0.01, symbol="WIF"),
        sim(-0.01, symbol="WIF", kind="triangle"),
        stale(t={"market": T0 - 50, "quoteStart": T0, "quoteEnd": T0 + 300, "decision": T0 + 301}),
    ]
    assert [s.name for s in scenarios(opps)] == [
        "as recorded", "quoted net >= 30bps", "quoted net >= 50bps", "quoted net >= 100bps", "expected value >= $0.005",
        "expected value >= $0.02", "price impact <= 10bps", "price impact <= 30bps", "quote <= 500ms old at decision",
        "two-leg only", "triangle only", "event-triggered only", "polled only", "without WIF",
    ]
    strict = next(s for s in scenarios(opps) if s.name == "quoted net >= 100bps")
    assert outcome_of([r for r in opps if strict.keep(r)]).money_usd == pytest.approx(0.02)


def test_survival_and_size_policies():
    def at(age, still):
        t = {"quoteStart": T0, "quoteEnd": T0 + 300, "decision": T0 + 301, "requoteEnd": T0 + 300 + age}
        return sim(0.01, t=t) if still else stale(t=t)

    opps = [at(100, True), at(150, True), at(400, False), at(3_000, False), at(3_500, True)]
    assert survival_by_age(opps) == [
        {"bucket": "< 250 ms", "n": 2, "still_there": 2},
        {"bucket": "250-500 ms", "n": 1, "still_there": 0},
        {"bucket": "2000-5000 ms", "n": 2, "still_there": 1},
    ]
    laddered = rec(stage="executable", quoted={"netUsd": 0.03, "netBps": 15, "grossBps": 20}, ladder=[
        {"sizeUsd": 10, "netUsd": 0.01, "netBps": 10, "evUsd": 0.005, "impactBps": 1},
        {"sizeUsd": 20, "netUsd": 0.03, "netBps": 15, "evUsd": 0.015, "impactBps": 2},
        {"sizeUsd": 50, "netUsd": 0.02, "netBps": 4, "evUsd": 0.01, "impactBps": 8},
    ])
    assert size_policies([laddered]) == [
        {"name": "size the ladder chose", "n": 1, "quoted_usd": 0.03},
        {"name": "always the smallest size", "n": 1, "quoted_usd": 0.01},
        {"name": "always the largest size", "n": 1, "quoted_usd": 0.02},
    ]


def test_render_backtest_honestly():
    import re
    assert "Nothing recorded yet" in render_backtest([])
    quote_only = render_backtest([stale(), rec(stage="executable")])
    assert "No on-chain results yet" in quote_only
    assert re.search(r"as recorded\s+2\s+50%\s+0\s+0\s+n/a\s+\+\$0\.1000", quote_only)
    assert "Looser rules can't be judged" in quote_only


def test_backtest_probe_section(tmp_path):
    import re
    path = str(tmp_path / "probes-paper.jsonl")
    log = ProbeLog(path)
    probe = {"ts": T0, "symbol": "JUP", "kind": "two-leg", "venues": ["Whirlpool"], "sizeUsd": 20, "quotedBps": 4, "freshBps": -8, "ageMs": 400, "event": False}
    log.append(probe)
    log.append({**probe, "quotedBps": 8, "freshBps": 7})
    text = render_backtest([], ProbeLog.read(path))
    assert "Gaps below the bar, re-checked by probes (2; learning only, nothing traded)" in text
    assert re.search(r"quoted 0\.\.5\s+bps:\s+0% still there\s+\(n=1\)", text)
    assert re.search(r"quoted 5\.\.10\s+bps:\s+100% still there\s+\(n=1\)", text)


# ---- benchmark --------------------------------------------------------------------------

def test_benchmark_statistics():
    assert summarize([300, 100, 200, 400], 1) == {"n": 4, "errors": 1, "medianMs": 250, "p90Ms": 400, "minMs": 100, "maxMs": 400}
    assert summarize([5])["medianMs"] == 5 and summarize([5])["p90Ms"] == 5
    assert summarize([], 3) == {"n": 0, "errors": 3, "medianMs": None, "p90Ms": None, "minMs": None, "maxMs": None}


def fake_deps(quote_ms, rpc_ms, fail_rpc=False, with_quotes=True):
    clock = {"t": 0}
    calls = []

    async def take(ms):
        clock["t"] += ms

    async def sleep(ms):
        calls.append(f"sleep {ms}")
        clock["t"] += ms

    async def rpc_slot():
        await take(rpc_ms)
        if fail_rpc:
            raise RuntimeError("401")

    async def rpc_blockhash():
        await take(rpc_ms * 2)

    async def quote(in_mint, out_mint, amount):
        calls.append(f"quote {in_mint[:4]}")
        await take(quote_ms)
        return {"outAmount": "166000000", "routePlan": [{"swapInfo": {"ammKey": "Pool1111111111111111111111111111111111111111", "label": "X"}}]}

    async def watch_account(account, ms):
        calls.append(f"watch {account[:5]}")
        clock["t"] += ms
        return 50, 300

    async def watch_slots(ms):
        clock["t"] += ms
        return 12, 400

    deps = BenchDeps(now=lambda: clock["t"], sleep=sleep, rpc_slot=rpc_slot, rpc_blockhash=rpc_blockhash,
                     quote=quote if with_quotes else None, watch_account=watch_account, watch_slots=watch_slots)
    return deps, calls


OPTS = BenchOptions(rpc_samples=4, quote_samples=4, jupiter_gap_ms=2_000, watch_ms=20_000, amount_atoms=20_000_000)


def test_benchmark_run():
    deps, calls = fake_deps(250, 40)
    lines = []
    r = asyncio.run(run_benchmark(deps, OPTS, lines.append))
    assert r["rpcSlot"]["medianMs"] == 40
    assert r["rpcBlockhash"]["medianMs"] == 80
    assert r["quoteLeg"]["medianMs"] == 250
    assert r["quoteRoundTrip"]["medianMs"] == 500
    assert r["minGapLifetimeMs"] == 1_000
    assert r["pool"]["events"] == 50 and r["pool"]["perMin"] == 150 and r["pool"]["firstMs"] == 300
    assert r["slotsPerSec"] == pytest.approx(2.4)
    first = calls.index("quote EPjF")
    assert calls[first:first + 3] == ["quote EPjF", "sleep 2000", "quote EPjF"]
    assert "watch Pool1" in calls
    assert "median 500 ms" in next(l for l in lines if l.startswith("Jupiter round trip"))
    json.dumps(r)


def test_benchmark_failures_and_bot_running():
    import re
    deps, _ = fake_deps(250, 40, fail_rpc=True, with_quotes=False)
    lines = []
    r = asyncio.run(run_benchmark(deps, OPTS, lines.append))
    assert (r["rpcSlot"]["n"], r["rpcSlot"]["errors"], r["rpcSlot"]["medianMs"]) == (0, 4, None)
    assert re.match(r"RPC getSlot\s+FAILED", lines[0])
    assert "quoteLeg" not in r and r["minGapLifetimeMs"] is None and "pool" not in r
    assert re.search(r"Jupiter\s+skipped: the bot is running", "\n".join(lines))


def test_benchmark_explains():
    text = "\n".join(explain({"ts": 0, "rpcSlot": summarize([40]), "rpcBlockhash": summarize([80]), "quoteRoundTrip": summarize([500]),
                              "minGapLifetimeMs": 1_000, "pool": {"account": "p", "seconds": 20, "events": 50, "perMin": 150, "firstMs": 300}}))
    assert "at least ~1000 ms" in text
    assert "too busy to be a useful trigger" in text


# ---- check ---------------------------------------------------------------------------------

def test_mask_url():
    assert mask_url("https://mainnet.helius-rpc.com/?api-key=abcd1234-5678-efgh") == "https://mainnet.helius-rpc.com/?api-key=abcd…efgh"
    assert mask_url("https://api.mainnet-beta.solana.com") == "https://api.mainnet-beta.solana.com"


def test_limits_line():
    from types import SimpleNamespace
    base = dict(mode="paper", trade_size_pct=0.8, max_trade_usd=0, micro_max_trade_usd=5, loss_floor_usd=17.5, daily_loss_limit_usd=2)
    assert limits_line(SimpleNamespace(**base)) == (
        "per trade at most 80% of the USDC on hand; stops for good at $17.5, pauses for the day after -$2; no profit cap"
    )
    assert "80% of the USDC on hand, $10 (MAX_TRADE_USD), $5 (MICRO cap)" in limits_line(SimpleNamespace(**{**base, "mode": "micro", "max_trade_usd": 10}))


# ---- report ----------------------------------------------------------------------------------

VERDICT_NO = Verdict(GateResult(False, ["only 4 trades simulated on-chain (need 30)"]),
                     GateResult(False, ["Insufficient real execution sample: 0 MICRO trades landed (need 20)"]))


def test_report_keeps_bases_apart():
    import re
    opps = [
        rec(stage="quoted", result="stale", executable={"netUsd": -0.01, "netBps": -5, "grossBps": 0}),
        rec(stage="simulated", simulated={"netUsd": 0.01, "netBps": 5, "ok": True}, executable={"netUsd": 0.01, "netBps": 6, "grossBps": 10}),
    ]
    text = render_report(ReportData("paper", 1234, opps, LearningStats.from_records(opps), 0.5, VERDICT_NO,
                                    {"level": "GREEN", "reasons": []}, ["thinking"], "Bills: ..."))
    assert "ARBITRAGE BOT REPORT" in text
    assert "Scanned round trips:          1,234" in text
    assert "Realized P&L (real money):    +$0.0000" in text
    assert "Quoted-only results:          +$0.5000  (quotes alone; NOT profit)" in text
    assert re.search(r"quoted \(not profit\)\s+0\.25%\s+0\.25%\s+2", text)
    assert re.search(r"executable \(fresh re-quote\)\s+0\.01%\s+0\.01%\s+2", text)
    assert re.search(r"simulated on-chain\s+0\.05%\s+0\.05%\s+1", text)
    assert re.search(r"realized\s+n/a\s+n/a\s+0", text)
    assert "Best token (simulated):" in text
    assert "MICRO LIVE: NO" in text and "FULL LIVE:  NO" in text
    assert "LIVE: Insufficient real execution sample: 0 MICRO trades landed (need 20)" in text
    none = render_report(ReportData("paper", 0, [], LearningStats.from_records([]), 0, VERDICT_NO, {"level": "GREEN", "reasons": []}, [], ""))
    assert "Best token (no evidence yet): n/a" in none


def test_risk_levels():
    base = dict(kill_switch=None, halted=None, today_money_pnl_usd=0, daily_loss_limit_usd=2, timeouts_today=0, wallet_value_usd=25, loss_floor_usd=17.5)
    assert risk_status(**base) == {"level": "GREEN", "reasons": []}
    assert risk_status(**{**base, "today_money_pnl_usd": -1.2})["level"] == "AMBER"
    assert risk_status(**{**base, "timeouts_today": 1})["reasons"] == ["1 unconfirmed landing(s) today"]
    assert risk_status(**{**base, "wallet_value_usd": 18})["level"] == "AMBER"
    red = risk_status(**{**base, "kill_switch": "stopped by hand", "timeouts_today": 1})
    assert red == {"level": "RED", "reasons": ["trading disabled: stopped by hand", "1 unconfirmed landing(s) today"]}


def test_report_gathers_every_mode(tmp_path):
    (tmp_path / "opps-paper.jsonl").write_text("".join(json.dumps(r) + "\n" for r in [sim(0.01), sim(0.02)]))
    (tmp_path / "opps-micro.jsonl").write_text(json.dumps(real(0.003)) + "\n")

    def trade(**o):
        return json.dumps({"ts": T0, "mode": "paper", "symbol": "SOL", "status": "filled", "inUsd": 20, "netUsd": 0.01, "feeUsd": 0, **o})

    (tmp_path / "trades-paper.jsonl").write_text(trade(basis="quoted", netUsd=0.4, verified=False) + "\n" + trade(basis="simulated", verified=True) + "\n")
    (tmp_path / "brain-paper.json").write_text(json.dumps({"totalScans": 700, "startedAt": T0 - DAY}))
    (tmp_path / "brain-micro.json").write_text(json.dumps({"totalScans": 50, "startedAt": T0}))
    d = build_report_data(load_config({"DATA_DIR": str(tmp_path)}), T0 + 1000)
    assert d.scans == 750
    assert len(d.opps) == 3
    assert d.quoted_only_usd == pytest.approx(0.4)
    assert "simulated on-chain only; NOT real money" in d.bills_line
    assert d.verdict.live.reasons[0] == "Insufficient real execution sample: 1 MICRO trades landed (need 20)"
    text = render_report(d)
    assert "Real trades (MICRO/LIVE):     1 sent, 1 landed, 1 profitable, 0 failed" in text
    assert "Token safety" in text
