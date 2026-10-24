import asyncio
import json
from datetime import datetime, timezone

import httpx
import pytest

from arbbot.funnel import FunnelReader
from arbbot.gate import GateInput, GateResult, GateThresholds, go_live_verdict, load_gate_input
from arbbot.killswitch import disable_trading
from arbbot.notify import make_notifier
from arbbot.risk import RiskDecision, RiskLimits, RiskManager

LIMITS = RiskLimits(loss_floor_usd=17.5, daily_loss_limit_usd=2, max_consecutive_failures=3, max_consecutive_losses=3,
                    failure_cooldown_ms=60_000, unexpected_loss_usd=0.05)
T0 = int(datetime(2026, 10, 5, 10, tzinfo=timezone.utc).timestamp() * 1000)
DAY = 86_400_000


def test_halts_at_loss_floor():
    d = RiskManager(LIMITS).check(17.4, 0)
    assert not d.ok and d.halt
    assert d.reason == "wallet value $17.40 hit loss floor $17.50"


def test_daily_loss_pauses_not_halts():
    d = RiskManager(LIMITS).check(24, -2.1)
    assert not d.ok and not d.halt


def test_never_blocks_on_profit():
    assert RiskManager(LIMITS).check(1_000_000, 50_000) == RiskDecision(True)


def test_cooldown_after_failures():
    r = RiskManager(LIMITS)
    for _ in range(3):
        r.record_result("failed", 0)
    assert not r.check(25, 0, 1_000).ok
    assert r.check(25, 0, 61_000).ok


def test_pauses_after_losing_streak_and_win_resets():
    r = RiskManager(LIMITS)
    for net in (-0.01, -0.01, 0.02, -0.01, -0.01):
        r.record_result("filled", 0, net)
    assert r.check(25, 0, 1).ok
    r.record_result("failed", 0, -0.002)
    d = r.check(25, 0, 1)
    assert not d.ok and not d.halt
    assert "3 losing trades in a row" in d.reason


def test_unexpected_outcomes():
    r = RiskManager(LIMITS)
    assert "could not be confirmed" in r.unexpected("timeout", 0)
    assert r.unexpected("filled", -0.2) == "a single trade lost $0.2000, more than UNEXPECTED_LOSS_USD $0.05"
    assert r.unexpected("failed", -0.002) is None
    assert r.unexpected("stale", 0) is None


# ---- go-live gate ----------------------------------------------------------------

def rec(**o):
    r = {
        "id": "opp_x", "ts": T0, "mode": "paper", "kind": "two-leg", "symbol": "SOL", "tokens": ["SOL"], "route": "A | B", "sizeUsd": 20,
        "quoted": {"netUsd": 0.05, "netBps": 25, "grossBps": 30}, "expected": {"pSuccess": 0.5, "evUsd": 0.02, "assumed": []},
        "costs": {}, "result": "filled", "t": {"quoteStart": T0, "quoteEnd": T0 + 300, "decision": T0 + 301},
        "lat": {"quoteMs": 300, "quoteToDecisionMs": 1, "totalMs": 301},
    }
    r.update(o)
    return r


def sim(net, ok=True):
    return rec(stage="simulated" if ok else "executable", result="filled" if ok else "rejected",
               simulated={"netUsd": net, "netBps": net * 500, "ok": ok})


def real(net, result="filled"):
    return rec(mode="micro", stage="submitted" if result == "timeout" else "profitable" if net > 0 else "landed", result=result,
               realized={"netUsd": net, "netBps": net * 500, "landed": result != "timeout", "signature": "sig"})


T = GateThresholds(3, 30, 0.3, 20, 0.7)
GOOD_PAPER = [sim(0.01) for _ in range(30)] + [sim(0, False) for _ in range(10)]


def inp(**o):
    args = dict(paper=[], micro=[], paper_days=5)
    args.update(o)
    return GateInput(**args)


def test_gate_says_no_without_evidence():
    v = go_live_verdict(inp(paper_days=0.5), T)
    assert not v.micro.ok
    assert "no trades simulated on-chain yet" in v.micro.reasons[0]
    assert "only 0.5 days of paper data (need 3)" in v.micro.reasons
    assert v.live == GateResult(False, ["Insufficient real execution sample: 0 MICRO trades landed (need 20)"])


def test_micro_needs_simulated_successes_that_made_money():
    assert go_live_verdict(inp(paper=GOOD_PAPER), T).micro == GateResult(True, [])
    assert "only 10 trades simulated on-chain (need 30)" in go_live_verdict(inp(paper=GOOD_PAPER[:10]), T).micro.reasons
    reverts = GOOD_PAPER[:5] + [sim(0, False) for _ in range(40)]
    assert "only 11% of simulated trades succeeded" in ",".join(go_live_verdict(inp(paper=reverts), T).micro.reasons)
    losers = [sim(-0.002) for _ in range(30)]
    assert "lose money on average" in ",".join(go_live_verdict(inp(paper=losers), T).micro.reasons)
    quote_only = [rec(stage="executable") for _ in range(100)]
    assert not go_live_verdict(inp(paper=quote_only), T).micro.ok


def test_live_needs_profitable_micro_trades():
    micro = [real(0.004) for _ in range(16)] + [real(-0.001) for _ in range(4)]
    assert go_live_verdict(inp(paper=GOOD_PAPER, micro=micro), T).live == GateResult(True, [])
    assert "Insufficient real execution sample: 12 MICRO trades landed (need 20)" in go_live_verdict(inp(micro=micro[:12]), T).live.reasons
    unprofitable = [real(0.004) for _ in range(10)] + [real(-0.001) for _ in range(10)]
    assert "only 50% of MICRO trades were profitable (need 70%)" in go_live_verdict(inp(micro=unprofitable), T).live.reasons
    big_loss = micro + [real(-0.2)]
    assert "MICRO realized P&L is $-0.1400" in ",".join(go_live_verdict(inp(micro=big_loss), T).live.reasons)
    timeout = micro + [real(0, "timeout")]
    assert "1 MICRO trade(s) had an unconfirmed landing" in go_live_verdict(inp(micro=timeout), T).live.reasons


def test_gate_blocked_by_kill_switch_or_halt():
    micro = [real(0.004) for _ in range(20)]
    v = go_live_verdict(inp(paper=GOOD_PAPER, micro=micro, kill_switch="stopped by hand"), T)
    assert not v.micro.ok and not v.live.ok
    assert v.live.reasons[0] == "trading is disabled: stopped by hand"
    assert go_live_verdict(inp(paper=GOOD_PAPER, micro=micro, halted="loss floor"), T).live.reasons[0] == "the bot is halted: loss floor"


def test_gate_reads_data_folder(tmp_path):
    d = str(tmp_path)
    (tmp_path / "opps-paper.jsonl").write_text("".join(json.dumps(r) + "\n" for r in GOOD_PAPER))
    (tmp_path / "brain-paper.json").write_text(json.dumps({"startedAt": T0 - 4 * DAY}))
    g = load_gate_input(d, T0)
    assert len(g.paper) == 40 and len(g.micro) == 0
    assert g.paper_days == pytest.approx(4)
    assert g.kill_switch is None and g.halted is None
    disable_trading(d, "test stop", T0)
    (tmp_path / "HALTED").write_text("loss floor hit\n")
    g = load_gate_input(d, T0)
    assert g.kill_switch == "2026-10-05T10:00:00.000Z test stop"
    assert g.halted == "loss floor hit"


def test_funnel_reader_only_complete_lines(tmp_path):
    path = tmp_path / "opps-paper.jsonl"
    r = FunnelReader(str(path))
    assert r.read() == []
    path.write_text(json.dumps(rec(id="a")) + "\n" + json.dumps(rec(id="b")) + "\n")
    assert [x["id"] for x in r.read()] == ["a", "b"]
    c = json.dumps(rec(id="c"))
    with open(path, "a") as f:
        f.write(c[:40])
    assert len(r.read()) == 2
    with open(path, "a") as f:
        f.write(c[40:] + "\n")
    assert [x["id"] for x in r.read()] == ["a", "b", "c"]
    path.write_text(json.dumps(rec(id="z")) + "\n")
    assert [x["id"] for x in r.read()] == ["z"]


# ---- notifier ----------------------------------------------------------------------

def test_notifier_sends_redacted_text_and_never_raises():
    sent = []

    def handler(req: httpx.Request):
        sent.append((str(req.url), json.loads(req.content)))
        return httpx.Response(200, json={"ok": True})

    class Cfg:
        telegram_bot_token = "123456:ABCdefGhIJKlmnoPQRstuVWxyz0123456789"
        telegram_chat_id = "42"

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await make_notifier(Cfg, client)("hello api-key=secret123")
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: (_ for _ in ()).throw(httpx.ConnectError("down")))) as client:
            await make_notifier(Cfg, client)("still fine")

    asyncio.run(run())
    assert len(sent) == 1
    assert sent[0][0].endswith("/sendMessage")
    assert sent[0][1]["chat_id"] == "42"
    assert "secret123" not in sent[0][1]["text"]
