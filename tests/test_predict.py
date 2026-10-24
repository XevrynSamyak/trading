import json
import math
import random

import pytest

from arbbot.gappredict import MIN_EXAMPLES, GapPredictor
from arbbot.predict import Linear, Logistic, Scorecard
from arbbot.trend import HISTORY, MINUTE_MS, Trend, features

# ---- the maths -------------------------------------------------------------------------------


def test_logistic_and_linear_learn_simple_patterns():
    rnd = random.Random(1)
    lg, ln = Logistic(2, lr=0.3, l2=0.001), Linear(2, lr=0.05, l2=0.0)
    for _ in range(3000):
        f = rnd.uniform(-1, 1)
        lg.update([1.0, f], int(f > 0))
        ln.update([1.0, f], 0.5 + 1.5 * f)
    assert lg.predict([1.0, 1.0]) > 0.9 and lg.predict([1.0, -1.0]) < 0.1
    assert ln.predict([1.0, 0.5]) == pytest.approx(1.25, abs=0.05)


def test_scorecard_compares_with_always_the_average():
    good, dumb = Scorecard(), Scorecard()
    for i in range(400):
        y = int(i % 4 == 0)  # 25% yes
        good.record(0.9 if y else 0.1, y)
        dumb.record(dumb.base_rate(), y)
    assert good.skill() > 0.5 and abs(dumb.skill()) < 0.02
    assert good.accuracy() == 1.0 and good.accuracy_base() == pytest.approx(0.75, abs=0.01)
    rows = {r["range"]: r for r in good.calibration()}
    assert rows["10-20%"]["actual_pct"] == 0 and rows["90-100%"]["actual_pct"] == 100
    again = Scorecard.from_dict(json.loads(json.dumps(good.to_dict())))
    assert again.skill() == pytest.approx(good.skill()) and again.n == 400
    assert Scorecard.from_dict({"n": "x"}).n == 0


# ---- gap predictor --------------------------------------------------------------------------------

T0 = 1_792_000_000_000


def recheck(i, quoted, fresh, symbol="JUP", venues=("Whirlpool",), age=400, event=False):
    return {"ts": T0 + i * 1000, "symbol": symbol, "kind": "two-leg", "venues": list(venues), "sizeUsd": 20,
            "quotedBps": quoted, "freshBps": fresh, "ageMs": age, "event": event}


def history(n=300, seed=2):
    """Small gaps are usually real; big quoted gaps are almost always stale."""
    rnd = random.Random(seed)
    out = []
    for i in range(n):
        if i % 2:
            out.append(recheck(i, 3.0, 2.5 if rnd.random() < 0.7 else -4.0))
        else:
            out.append(recheck(i, 60.0, 50.0 if rnd.random() < 0.05 else -30.0))
    return out


def test_gap_predictor_learns_which_gaps_are_real():
    g = GapPredictor.from_records(history())
    small, _ = g.predict(recheck(0, 3.0, 0))
    big, big_size = g.predict(recheck(0, 60.0, 0))
    assert small > 0.55 and big < 0.2
    assert big_size < 30  # expects a big quoted gap to shrink a lot
    assert g.skilled() and g.score.skill() > 0.2
    assert g.factor(recheck(0, 60.0, 0)) < 0.6 and 1.0 < g.factor(recheck(0, 3.0, 0)) <= 1.5
    text = "\n".join(g.thoughts())
    assert "better than assuming the average" in text and "so I now use them to decide" in text
    s = g.summary()
    assert s["size_err_bps"] < s["size_err_quote_bps"]  # better than taking quotes at face value
    assert g.memory.global_.n == 300


def test_gap_predictor_stays_out_of_decisions_until_proven():
    g = GapPredictor.from_records(history(MIN_EXAMPLES - 10))
    assert not g.skilled()
    assert g.factor(recheck(0, 60.0, 0)) == 1  # venue trust, with too little data to judge
    assert "don't rely on them yet" in " ".join(g.thoughts())
    assert GapPredictor.from_records([{"bad": 1}, recheck(1, 3, 2)]).score.n == 1
    assert GapPredictor().thoughts() == []


def test_gap_predictor_uses_reque_quoted_opportunities_too():
    opp = {"ts": T0, "symbol": "WIF", "kind": "two-leg", "route": "A | B", "sizeUsd": 20, "quoted": {"netBps": 44.1},
           "executable": {"netBps": -30.3}, "t": {"quoteEnd": T0, "requoteEnd": T0 + 846}}
    g = GapPredictor.from_records([], [opp, {**opp, "executable": None}])
    assert g.score.n == 1 and g.memory.by_token["WIF"].n == 1


# ---- price direction (paper only) ----------------------------------------------------------------


def trending_prices(minutes, seed=3, start=100.0):
    """Moves in runs of 40 minutes, up or down 0.15%/minute, plus noise: a pattern momentum can catch."""
    rnd = random.Random(seed)
    p, drift, out = start, 0.0, []
    for m in range(minutes):
        if m % 40 == 0:
            drift = 0.0015 if rnd.random() < 0.5 else -0.0015
        p *= math.exp(drift + rnd.gauss(0, 0.0005))
        out.append(p)
    return out


def feed(tr, prices, sym="WIF", cost=10.0, start_minute=1000, size=20.0):
    events = []
    for k, p in enumerate(prices):
        m = start_minute + k
        events += tr.on_prices({sym: p}, m * MINUTE_MS + 5_000, lambda s: cost, size)
        events += tr.on_prices({sym: p}, m * MINUTE_MS + 50_000, lambda s: cost, size)
    return events


def test_features_are_scaled_by_volatility():
    flat = [100.0 * (1 + 0.0001 * (i % 2)) for i in range(HISTORY)]
    up = [100.0 * math.exp(0.001 * i + 0.0001 * (i % 2)) for i in range(HISTORY)]
    assert len(features(up)) == 8
    assert features(up)[3] > 1 and features(up)[5] > 0  # 15-min move and fast-vs-slow average point up
    assert abs(features(flat)[3]) < 1


def test_trend_predicts_paper_trades_and_reports_honestly(tmp_path):
    tr = Trend(str(tmp_path), horizon_min=15, enter_prob=0.6, max_positions=1, warmup=100)
    events = feed(tr, trending_prices(1500))
    assert tr.score.n > 1000
    assert tr.score.skill() > 0  # momentum is real in this made-up market
    trades = [json.loads(l) for l in open(tmp_path / "trend-paper.jsonl")]
    assert trades and all(t["paper"] and t["side"] == "long" for t in trades)
    for t in trades:
        assert t["netBps"] == pytest.approx(t["grossBps"] - t["costBps"])
        assert t["netUsd"] == pytest.approx(t["sizeUsd"] * t["netBps"] / 10_000)
    assert any("trend (paper): bought WIF" in e for e in events)
    assert any("paper only" in e for e in events)
    st = tr.status()
    assert st["trades"] == len(trades) and st["predictions"] == tr.score.n and st["tokens"] == 1
    text = " ".join(tr.thoughts())
    assert "price predictions" in text and "Paper trades on them" in text
    assert "paper" in tr.evidence() or "evidence" in tr.evidence()


def test_trend_waits_for_an_hour_of_history_and_the_warmup(tmp_path):
    tr = Trend(str(tmp_path), warmup=10_000)
    feed(tr, [100.0] * 30)
    assert tr.score.n == 0 and "collecting 1-minute prices" in tr.thoughts()[0]
    feed(tr, trending_prices(200), start_minute=1030)
    assert tr.score.n > 0
    assert not (tmp_path / "trend-paper.jsonl").exists()  # still warming up: no paper trades
    assert "start after 10000 checked predictions" in " ".join(tr.thoughts())


def test_trend_stop_loss_and_restart(tmp_path):
    tr = Trend(str(tmp_path), stop_pct=1.5, warmup=0)
    tr.positions.append({"symbol": "WIF", "openedAt": 0, "minute": 10**9, "entry": 100.0, "sizeUsd": 20, "pUp": 0.7, "costBps": 30})
    events = tr.on_prices({"WIF": 98.0}, 10**9 * MINUTE_MS + 1_000, lambda s: 30, 20)
    assert "sold WIF (stop loss): -200.0bps before costs, -230.0bps after (-$0.4600, paper only)" in events[0]
    assert tr.positions == []
    # Learning and prices survive a restart.
    feed(tr, trending_prices(120), start_minute=10**9 + 1)
    weights, n = list(tr.model.w), tr.score.n
    again = Trend(str(tmp_path), stop_pct=1.5, warmup=0)
    assert again.model.w == pytest.approx(weights) and again.score.n == n
    assert len(again.closes["WIF"]) >= HISTORY
    # A different horizon is a different question: it starts over.
    assert Trend(str(tmp_path), horizon_min=30).score.n == 0
