import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from arbbot.costs import Costs, Valuation
from arbbot.cycle import Cycle
from arbbot.executor import ExecResult
from arbbot.funnel import Funnel, build_opp_record, latencies, stage_of
from arbbot.probes import GapMemory, ProbeBudget, ProbeLog, gap_bucket, held, probe_from_opp, venues_of
from arbbot.sizer import evaluate_ladder, ladder_sizes, make_point, pick_best_size
from arbbot.stats import LearningStats, score_opportunity, size_bucket


def ms(*args) -> int:
    return int(datetime(*args, tzinfo=timezone.utc).timestamp() * 1000)


T0 = ms(2026, 10, 5, 10)


def rec(**o) -> dict:
    r = {
        "id": "opp_x", "ts": T0, "mode": "paper", "kind": "two-leg", "symbol": "SOL", "tokens": ["SOL"], "route": "A | B", "sizeUsd": 20,
        "quoted": {"netUsd": 0.05, "netBps": 25, "grossBps": 30}, "expected": {"pSuccess": 0.5, "evUsd": 0.02, "assumed": []},
        "costs": {"baseFeeUsd": 0, "priorityFeeUsd": 0, "tipUsd": 0, "tipLamports": 0, "bufferUsd": 0, "totalUsd": 0, "dexFeeBps": 0, "priceImpactBps": 0},
        "result": "filled", "t": {"quoteStart": T0, "quoteEnd": T0 + 300, "decision": T0 + 301},
        "lat": {"quoteMs": 300, "quoteToDecisionMs": 1, "totalMs": 301},
    }
    r.update(o)
    return r


# ---- funnel -----------------------------------------------------------------

def test_funnel_daily_ids_continue_after_restart(tmp_path):
    path = str(tmp_path / "opps-paper.jsonl")
    f = Funnel(path)
    assert f.next_id(T0) == "opp_20261005_000001"
    id2 = f.next_id(T0)
    f.record(rec(id=id2, stage="quoted"))
    assert Funnel(path).next_id(T0) == "opp_20261005_000003"
    assert Funnel(path).next_id(T0 + 86_400_000) == "opp_20261006_000001"
    assert len(Funnel.read(path)) == 1


def test_stage_of():
    r = lambda **o: ExecResult(**{"status": "filled", **o})  # noqa: E731
    assert stage_of(r(status="stale"), False) == "quoted"
    assert stage_of(r(status="filled", verified=False), False) == "executable"
    assert stage_of(r(status="rejected", verified=True), False) == "executable"
    assert stage_of(r(status="filled", verified=True), False) == "simulated"
    assert stage_of(r(status="rejected", signature="s"), True) == "submitted"
    assert stage_of(r(status="failed", signature="s"), True) == "landed"
    assert stage_of(r(status="filled", signature="s", net_usd=0.02), True) == "profitable"
    assert stage_of(r(status="filled", signature="s", net_usd=-0.01), True) == "landed"


def test_latencies():
    lat = latencies({"market": 0, "quoteStart": 50, "quoteEnd": 250, "decision": 260, "submitted": 900, "landed": 1700})
    assert lat == {"marketToQuoteMs": 250, "quoteMs": 200, "quoteToDecisionMs": 10, "decisionToSubmitMs": 640, "submitToLandingMs": 800, "totalMs": 1700}


def test_timeline_starts_at_detecting_quote():
    cycle = Cycle("two-leg", "SOL", ["SOL"], [], in_atoms=20_000_000, out_atoms=20_050_000, quote_started_at=T0 + 2_000,
                  quoted_at=T0 + 2_400, routes="A | B", price_impact_bps=1, dex_fee_bps=30)
    val = Valuation(20, 20.05, 0.05, 25, Costs(5000, 1000, 1000, 0.001, 0, 0.001, 0.002), 0.04, 20)
    opp = build_opp_record(
        id="opp_1", mode="paper", cycle=cycle, val=val, decision_ts=T0 + 2_500,
        detected=SimpleNamespace(quote_started_at=T0, quoted_at=T0 + 300, market_ts=None),
        result=ExecResult("stale", t={"requoteStart": T0 + 2_510, "requoteEnd": T0 + 2_900}),
        expected={"pSuccess": 0.5, "evUsd": 0.02, "assumed": []}, sol_price_usd=150,
    )
    assert opp["lat"]["quoteMs"] == 300
    assert opp["lat"]["quoteToDecisionMs"] == 2_200
    assert opp["lat"]["totalMs"] == 2_900
    assert opp["stage"] == "quoted" and opp["result"] == "stale"
    assert "market" not in opp["t"] and "executable" not in opp and "realized" not in opp
    assert opp["costs"]["baseFeeUsd"] == pytest.approx(5000 / 1e9 * 150)


def test_real_money_record_keeps_signature_and_realized():
    cycle = Cycle("two-leg", "SOL", ["SOL"], [], quote_started_at=T0, quoted_at=T0 + 200, routes="A | B")
    val = Valuation(20, 20.05, 0.05, 25, Costs(5000, 0, 0, 0.001, 0, 0, 0.001), 0.049, 24.5)
    res = ExecResult("filled", net_usd=0.03, signature="sig", verified=True, executable=val,
                     t={"requoteStart": T0 + 210, "requoteEnd": T0 + 400, "built": T0 + 420, "submitted": T0 + 430, "landed": T0 + 1200})
    opp = build_opp_record(id="opp_2", mode="micro", cycle=cycle, val=val, decision_ts=T0 + 205, result=res,
                           expected={"pSuccess": 0.2, "evUsd": 0.01, "assumed": ["landing"]}, sol_price_usd=150)
    assert opp["stage"] == "profitable"
    assert opp["realized"] == {"netUsd": 0.03, "netBps": pytest.approx(15), "landed": True, "signature": "sig"}
    assert opp["lat"]["submitToLandingMs"] == 770 and opp["lat"]["totalMs"] == 1200


# ---- learning engine ----------------------------------------------------------

def test_learns_fake_rate_per_token_shrunk_to_global():
    records = [rec(symbol="BONK", stage="quoted", result="stale", executable={"netUsd": -0.01, "netBps": -5, "grossBps": 0}) for _ in range(20)]
    records += [rec(symbol="JUP", stage="executable", executable={"netUsd": 0.03, "netBps": 15, "grossBps": 20}) for _ in range(20)]
    s = LearningStats.from_records(records)
    bonk = s.probabilities("BONK", None, "paper", False)
    jup = s.probabilities("JUP", None, "paper", False)
    fresh = s.probabilities("NEW", None, "paper", False)
    assert bonk.executable < 0.15
    assert jup.executable > 0.85
    assert fresh.executable == pytest.approx(0.5, abs=0.05)
    assert bonk.assumed == []


def test_labelled_assumptions():
    s = LearningStats.from_records([rec(stage="simulated", simulated={"netUsd": 0.04, "netBps": 20, "ok": True})])
    p = s.probabilities("SOL", None, "micro", True)
    assert "landing" in p.assumed
    assert p.landing == 0.5
    assert p.success == pytest.approx(p.executable * p.simulation * p.landing * p.profit)


def test_realized_results_and_ev():
    s = LearningStats.from_records([
        rec(mode="micro", stage="profitable", realized={"netUsd": 0.03, "netBps": 15, "landed": True, "signature": "a"}),
        rec(mode="micro", stage="landed", result="failed", realized={"netUsd": -0.002, "netBps": -1, "landed": True, "signature": "b"}),
    ])
    assert s.global_.landed == 2
    assert s.global_.profitable == 1
    assert s.global_.realized_usd == pytest.approx(0.028)
    p = s.probabilities("SOL", None, "micro", True)
    ev = s.expected_value(0.05, 0.002, p, "micro", True)
    reach = p.executable * p.simulation * p.landing
    assert ev == pytest.approx(reach * (p.profit * 0.05 - (1 - p.profit) * 0.002))
    row = s.table()[0]
    assert (row["symbol"], row["n"], row["real_kind"]) == ("SOL", 2, "realized")


def test_route_history_blends_in_after_5_samples():
    records = [rec(route="X | Y", stage="quoted", result="stale") for _ in range(6)] + [rec(route="A | B", stage="executable") for _ in range(6)]
    s = LearningStats.from_records(records)
    assert s.probabilities("SOL", "X | Y", "paper", False).executable < s.probabilities("SOL", "A | B", "paper", False).executable


def test_size_buckets():
    assert size_bucket(20) == "<=25"
    assert size_bucket(742) == "<=1000"
    assert size_bucket(9_000) == ">5000"


def test_opportunity_score():
    base = dict(ev_usd=1, quote_age_ms=0, expected_latency_ms=0, price_impact_bps=0, max_impact_bps=100, discovered=False)
    assert score_opportunity(**base) == 1
    assert score_opportunity(**{**base, "quote_age_ms": 1_000}) == pytest.approx(0.5)
    assert score_opportunity(**{**base, "expected_latency_ms": 2_000}) == pytest.approx(0.5)
    assert score_opportunity(**{**base, "price_impact_bps": 50}) == pytest.approx(0.5)
    assert score_opportunity(**{**base, "discovered": True}) == pytest.approx(0.8)
    assert score_opportunity(**{**base, "price_impact_bps": 150}) == 0
    assert score_opportunity(**{**base, "ev_usd": -0.1}) == -0.1


# ---- size ladder --------------------------------------------------------------

LADDER = [10, 25, 50, 100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000]


def fake(size_usd, net_usd, impact_bps=0):
    return SimpleNamespace(price_impact_bps=impact_bps), SimpleNamespace(in_usd=size_usd, net_usd=net_usd, net_bps=net_usd / size_usd * 10_000)


def test_ladder_within_limits():
    assert ladder_sizes(LADDER, 20.04, 1, 4) == [10, 20.04]
    assert ladder_sizes(LADDER, 5, 1, 4) == [5]
    assert ladder_sizes(LADDER, 0.5, 1, 4) == []


def test_ladder_thins_and_keeps_quoted_size():
    sizes = ladder_sizes(LADDER, 5000, 1, 4, 750)
    assert len(sizes) == 4
    assert 10 in sizes and 5000 in sizes and 750 in sizes
    assert ladder_sizes(LADDER, 5000, 1, 1, 750) == [750]
    assert ladder_sizes(LADDER, 5000, 1, 5) == [10, 50, 250, 1000, 5000]


def test_takes_larger_size_when_profit_rises():
    pts = [make_point(*fake(s, p), p, 100) for s, p in ((100, 1), (500, 4), (1000, 7))]
    assert pick_best_size(pts).size_usd == 1000


def test_picks_the_peak():
    curve = [(100, 1.4), (500, 7.2), (1000, 12.3), (1500, 15.2), (2000, 15.8), (3000, 12.4)]
    assert pick_best_size([make_point(*fake(s, p), p, 100) for s, p in curve]).size_usd == 2000


def test_maximises_ev_not_raw_profit():
    reliable = make_point(*fake(500, 5), 5 * 0.9, 100)
    unlikely = make_point(*fake(3000, 30), 30 * 0.05, 100)
    assert pick_best_size([reliable, unlikely]).size_usd == 500


def test_rejects_high_impact_or_negative_ev():
    too_big = make_point(*fake(5000, 50, 180), 50, 100)
    losing = make_point(*fake(100, -0.1), -0.1, 100)
    assert not too_big.feasible and too_big.reason == "price impact 180bps > 100"
    assert not losing.feasible
    assert pick_best_size([too_big, losing]) is None


def test_evaluates_each_size_once_reusing_quote():
    asked = []

    async def quote_at(usd):
        asked.append(usd)
        return fake(usd, usd * 0.002)

    pts = asyncio.run(evaluate_ladder([10, 20], quote_at, lambda c, v: v.net_usd, 100, fake(20, 0.05)))
    assert asked == [10]
    assert [p.size_usd for p in pts] == [10, 20]
    assert pick_best_size(pts).size_usd == 20


def test_ladder_skips_failed_quotes():
    errors = []

    async def quote_at(usd):
        if usd == 10:
            raise RuntimeError("429")
        return fake(usd, 0.01)

    pts = asyncio.run(evaluate_ladder([10, 25], quote_at, lambda c, v: v.net_usd, 100, on_error=lambda s, e: errors.append(s)))
    assert [p.size_usd for p in pts] == [25] and errors == [10]


# ---- probes and gap memory ---------------------------------------------------------

TP = ms(2026, 10, 24, 10)


def probe(**o) -> dict:
    p = {"ts": TP, "symbol": "JUP", "kind": "two-leg", "venues": ["Whirlpool"], "sizeUsd": 20, "quotedBps": 4, "freshBps": -8, "ageMs": 400, "event": False}
    p.update(o)
    return p


def test_venues_and_held():
    assert venues_of("Obsidian>Whirlpool | Bonkswap>Whirlpool") == ["Obsidian", "Whirlpool", "Bonkswap"]
    assert venues_of("GoonFi V2 | Raydium CLMM") == ["GoonFi V2", "Raydium CLMM"]
    assert venues_of("? | A") == ["A"]
    assert held({"quotedBps": 10, "freshBps": 6})
    assert not held({"quotedBps": 10, "freshBps": 4})
    assert not held({"quotedBps": 3, "freshBps": -1})
    assert gap_bucket(3) == "0..5" and gap_bucket(25) == "20..50" and gap_bucket(248) == "50+"


def test_probe_from_opp():
    opp = {"ts": TP, "symbol": "WIF", "kind": "two-leg", "route": "A | B", "sizeUsd": 20, "quoted": {"netBps": 44.1},
           "executable": {"netBps": -30.3}, "t": {"quoteEnd": TP, "requoteEnd": TP + 846, "market": TP - 20}}
    assert probe_from_opp(opp) == {"ts": TP, "symbol": "WIF", "kind": "two-leg", "venues": ["A", "B"], "sizeUsd": 20,
                                   "quotedBps": 44.1, "freshBps": -30.3, "ageMs": 846, "event": True}
    assert probe_from_opp({**opp, "executable": None}) is None


def test_venue_trust():
    probes = [probe(venues=["GoonFi V2"], freshBps=3 if i < 1 else -9) for i in range(30)]
    probes += [probe(venues=["Whirlpool"], freshBps=3 if i < 15 else -9) for i in range(30)]
    m = GapMemory.from_records(probes)
    assert m.venue_trust(["GoonFi V2"]) < 0.3
    assert m.venue_trust(["Whirlpool"]) == 1
    assert m.venue_trust(["Unknown DEX"]) == 1
    assert m.venue_trust(["Whirlpool", "GoonFi V2"]) < 0.3
    assert GapMemory.from_records(probes[:5]).venue_trust(["GoonFi V2"]) == 1
    text = "\n".join(m.thoughts())
    assert "I re-checked 60 gaps: 27% were still there" in text
    assert "Gaps through GoonFi V2 held 3% vs 50% through Whirlpool, so I trust GoonFi V2 less" in text


def test_big_gaps_stale_triggers_and_speed():
    m = GapMemory.from_records(
        [probe(quotedBps=60, freshBps=-10, ageMs=1_500) for _ in range(12)]
        + [probe(quotedBps=3, freshBps=2, event=True, ageMs=300) for _ in range(12)]
    )
    t = "\n".join(m.thoughts())
    assert "Big quoted gaps (20+ bps) held only 0% of the time" in t
    assert "right after a pool change held 100%; found by routine scans, 0%" in t
    assert "within half a second, 100% held; after a second or more, 0%" in t
    assert m.table() == [
        {"bucket": "0..5", "n": 12, "held_pct": 100, "avg_decay_bps": 1},
        {"bucket": "50+", "n": 12, "held_pct": 0, "avg_decay_bps": 70},
    ]
    assert GapMemory.from_records([probe()]).thoughts() == ["I've re-checked 1 gap(s) so far; I need 10+ to judge them."]


def test_probe_budget_and_log(tmp_path):
    b = ProbeBudget(2)
    assert [b.allow(TP), b.allow(TP + 1), b.allow(TP + 2)] == [True, True, False]
    assert b.allow(TP + 3_600_001)
    path = str(tmp_path / "probes-paper.jsonl")
    log = ProbeLog(path)
    log.append(probe())
    log.append(probe(quotedBps=8, freshBps=7))
    assert len(ProbeLog.read(path)) == 2
