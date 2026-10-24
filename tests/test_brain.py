import json
import math
from datetime import datetime, timezone

import pytest

from arbbot.brain import Brain

TOKENS = {"A": "a", "B": "b", "C": "c", "D": "d"}
T0 = int(datetime(2026, 10, 4, 14, tzinfo=timezone.utc).timestamp() * 1000)


@pytest.fixture
def path(tmp_path):
    return str(tmp_path / "brain.json")


def test_tries_every_token_then_focuses_on_edge(path):
    b = Brain(path, 20, tokens_per_cycle=2, explore_rate=0)
    for _ in range(20):
        b.observe_scan("A", -30)
        b.observe_scan("B", 15)
        b.observe_scan("C", -40)
        b.observe_scan("D", 5)
    assert sorted(b.pick_tokens(TOKENS)) == ["B", "D"]


def test_pickier_after_failures_looser_after_wins_within_bounds(path):
    b = Brain(path, 20)
    b.observe_trade("A", "failed", -0.001)
    assert b.min_profit_bps == 25
    for _ in range(50):
        b.observe_trade("A", "filled", 0.01)
    assert b.min_profit_bps == 10  # floor = base / 2
    for _ in range(50):
        b.observe_trade("A", "failed", -0.001)
    assert b.min_profit_bps == 80  # ceiling = base * 4


def test_remembers_across_restarts(path):
    b = Brain(path, 20)
    b.observe_trade("A", "failed", -0.001)
    b.save()
    assert Brain(path, 20).min_profit_bps == 25


def test_tries_each_size_then_sticks_with_best(path):
    b = Brain(path, 20, explore_rate=0)
    assert b.pick_size("A", 20)[1] == 0.25  # warm-up: untested sizes come first
    net = {0.25: -0.001, 0.5: 0.004, 1: -0.01}
    for _ in range(10):
        _, bucket = b.pick_size("A", 20)
        b.observe_scan("A", 0, net[bucket], bucket, 0)
    assert b.pick_size("A", 20) == (10, 0.5)


def test_never_picks_size_below_1(path):
    assert Brain(path, 20).pick_size("A", 2) == (2, 1)


def test_scans_faster_near_a_gap(path):
    b = Brain(path, 20, min_ms_per_request=1_000)
    assert b.next_interval_ms(18, 15_000, 0, 0, 6) == 7_998
    assert b.next_interval_ms(5, 15_000, 0, 0, 6) == 15_000
    assert b.next_interval_ms(-50, 15_000, 0, 0, 6) == 22_500


def test_learns_good_hours(path):
    b = Brain(path, 20)
    for h in range(8):
        b.observe_scan("A", -20 - h, 0, 1, h)
    b.observe_scan("A", 10, 0, 1, 14)
    assert b.is_good_hour(14) is True
    assert b.is_good_hour(7) is False
    assert b.is_good_hour(20) is None
    assert b.next_interval_ms(5, 15_000, 14) == 12_000


def test_discovered_tokens(path):
    b = Brain(path, 20)
    configured = {"SOL": "sol-mint"}
    added = b.learn_tokens({"SOL": "sol-mint", "NEW": "new-mint", "MORE": "more-mint"}, configured, 2)
    assert added == ["NEW"]
    assert sorted(b.token_pool(configured)) == ["NEW", "SOL"]
    for _ in range(60):
        b.observe_scan("NEW", -50)
    b.learn_tokens({"MORE": "more-mint"}, configured, 2)
    assert sorted(b.token_pool(configured)) == ["MORE", "SOL"]


def test_upgrades_old_brain_file(path):
    with open(path, "w") as f:
        json.dump({"tokens": {"A": {"scans": 5, "avgEdgeBps": -3, "fills": 0, "failures": 0, "pnlUsd": 0}}, "minProfitBps": 25, "totalScans": 5}, f)
    b = Brain(path, 20)
    assert b.min_profit_bps == 25
    assert len(b.state["hourEdgeBps"]) == 24
    b.pick_size("A", 20)
    assert "A: edge -3.0bps" in b.summary()


def test_quote_only_wins_dont_loosen(path):
    b = Brain(path, 20)
    for _ in range(10):
        b.observe_trade("A", "filled", 0.01, False)
    assert b.min_profit_bps == 20
    assert b.state["tokens"]["A"]["fills"] == 10
    b.observe_trade("A", "filled", 0.01, True)
    assert b.min_profit_bps == 19


def test_fake_gaps_lower_trust_not_threshold(path):
    b = Brain(path, 20)
    for sym in ("A", "B"):
        for _ in range(20):
            b.observe_scan(sym, 0)
    for _ in range(5):
        b.observe_trade("A", "rejected", 0)
    assert b.score("A") < b.score("B")
    assert b.min_profit_bps == 20
    assert "5 fake gaps" in b.summary()


def test_gap_histogram(path):
    b = Brain(path, 20)
    for bps in (-30, -3, -2, 7):
        b.observe_cycle(bps)
    assert b.state["edgeHistogram"] == {"< -20": 1, "-5..0": 2, "5..10": 1}
    assert "-5..0: 50.0%" in b.summary()


def test_learns_quote_overstatement(path):
    b = Brain(path, 20, explore_rate=0)
    for _ in range(5):
        b.observe_reality("A", 25, 0)
    assert b.expected_net_bps("A", 25) < 5
    assert b.should_attempt("A", 25) is False
    assert b.should_attempt("B", 25) is True


def test_never_inflates_a_quote(path):
    b = Brain(path, 20)
    b.observe_reality("A", 20, 30)
    assert b.expected_net_bps("A", 20) == 20


def test_still_rechecks_discounted_token(path):
    b = Brain(path, 20, explore_rate=0.2, random=lambda: 0.1)
    for _ in range(5):
        b.observe_reality("A", 25, 0)
    assert b.should_attempt("A", 25) is True
    assert b.should_attempt("A", 10) is False


def test_hot_after_sudden_move(path):
    b = Brain(path, 20, tokens_per_cycle=1, explore_rate=0)
    for _ in range(10):
        b.observe_scan("A", 5)
        b.observe_scan("Z", -40)
    assert b.observe_price("Z", 1, 100, T0) is None
    assert b.observe_price("Z", 0.5, 101, T0 + 10_000) is None
    assert b.observe_price("Z", 1, 100.5, T0 + 20_000) == pytest.approx(50, abs=1e-6)
    assert b.is_hot("Z", T0 + 30_000)
    assert list(b.pick_tokens({"A": "a", "Z": "z"}, T0 + 30_000)) == ["Z"]
    assert b.next_interval_ms(5, 15_000, 0, T0 + 30_000) == 9_000
    assert not b.is_hot("Z", T0 + 3 * 60_000)
    assert b.state["hotEvents"] == 1


def test_ignores_small_moves_and_stale_comparisons(path):
    b = Brain(path, 20)
    b.observe_price("A", 1, 100, T0)
    b.observe_price("A", 1, 100.1, T0 + 10_000)
    b.observe_price("A", 1, 110, T0 + 20 * 60_000)
    assert not b.is_hot("A", T0 + 20 * 60_000)


def test_explains_itself(path):
    b = Brain(path, 20)
    b.observe_cycle(-3, "SOL", T0)
    b.observe_cycle(4.1, "WIF", T0 + 60_000)
    for _ in range(4):
        b.observe_reality("SOL", 22, 10)
    b.observe_price("JUP", 1, 100, T0)
    b.observe_price("JUP", 1, 101, T0 + 30_000)
    text = "\n".join(b.thoughts(20))
    assert "at least 20bps (0.20%)" in text
    assert "closest I've come is WIF at 4.1bps (10-04 14:01 UTC); I need 20." in text
    assert "SOL's quotes look ~12.0bps better" in text
    assert "JUP moving 1.00% within minutes" in text


def test_upgrades_previous_version(path):
    with open(path, "w") as f:
        json.dump(
            {
                "tokens": {"A": {"scans": 5, "avgEdgeBps": -3, "fills": 0, "failures": 0, "pnlUsd": 0, "phantoms": 2, "sizes": {}}},
                "minProfitBps": 20, "totalScans": 5, "hourEdgeBps": [None] * 24, "discovered": {}, "edgeHistogram": {}, "startedAt": 1,
            },
            f,
        )
    b = Brain(path, 20)
    assert b.expected_net_bps("A", 10) == 10
    assert b.state["hotEvents"] == 0
    assert b.thoughts(20)


def test_learns_fastest_safe_pace(path):
    b = Brain(path, 20, min_ms_per_request=1_035)
    assert b.ms_per_request == 1_333
    for _ in range(5):
        b.observe_pace(False)
    assert b.ms_per_request == 1_200
    b.observe_pace(True)
    assert b.ms_per_request == 2_400
    for _ in range(500):
        b.observe_pace(False)
    assert b.ms_per_request == 1_035
    assert b.scan_pace_ms(6) == 6_210
    assert b.scan_pace_ms(2) == 2_070


def test_pace_across_restarts(path, tmp_path):
    b = Brain(path, 20, min_ms_per_request=1_000)
    b.observe_pace(True)
    b.save()
    assert Brain(path, 20, min_ms_per_request=2_000).ms_per_request == 2_666
    assert Brain(path, 20, min_ms_per_request=1_000).ms_per_request == 1_500

    old = str(tmp_path / "old.json")
    with open(old, "w") as f:
        json.dump({"tokens": {}, "minProfitBps": 20, "totalScans": 0, "paceFloorMs": 12_800}, f)
    upgraded = Brain(old, 20, min_ms_per_request=2_000)
    assert upgraded.ms_per_request == pytest.approx(2_133.33, abs=0.05)
    assert "paceFloorMs" not in upgraded.state


def test_focus_mode_rechecks_moving_token(path):
    b = Brain(path, 20, explore_rate=0, min_ms_per_request=1_035)
    b.observe_price("D", 1, 100, T0)
    b.observe_price("D", 1, 101, T0 + 5_000)
    t = T0 + 6_000
    assert b.planned_requests(t) == 2
    assert list(b.pick_tokens(TOKENS, t)) == ["D"]
    assert list(b.pick_tokens(TOKENS, t)) == ["D"]
    assert b.planned_requests(t) == 6
    assert len(b.pick_tokens(TOKENS, t)) == 3
    assert list(b.pick_tokens(TOKENS, t)) == ["D"]
    assert b.next_interval_ms(-3, 1_000, 0, t, 2) == 2_666
    assert b.next_interval_ms(-3, 1_000, 0, t, 6) == 7_998


def test_focus_on_near_gap(path):
    b = Brain(path, 20, explore_rate=0)
    b.observe_cycle(16, "B", T0)
    assert b.is_hot("B", T0 + 59_000)
    assert list(b.pick_tokens(TOKENS, T0 + 1_000)) == ["B"]
    assert not b.is_hot("B", T0 + 61_000)
    b.observe_cycle(10, "C", T0)
    assert not b.is_hot("C", T0 + 1_000)
    assert b.state["hotEvents"] == 0


def test_normal_scans_when_nothing_hot(path):
    b = Brain(path, 20, explore_rate=0)
    assert b.planned_requests(T0) == 6
    assert len(b.pick_tokens(TOKENS, T0)) == 3


def test_reads_typescript_brain_file(path):
    """A brain file written by the TypeScript bot loads and keeps its numbers."""
    ts_file = {
        "tokens": {"SOL": {"scans": 40, "avgEdgeBps": -12.5, "fills": 0, "failures": 0, "pnlUsd": 0, "phantoms": 3,
                            "haircutBps": 4.2, "realityChecks": 3, "sizes": {"1": {"n": 5, "avgNetUsd": -0.01}, "0.25": {"n": 3, "avgNetUsd": 0.002}}}},
        "minProfitBps": 31.3, "totalScans": 40, "hourEdgeBps": [None] * 23 + [-11.2], "discovered": {"WIF": "wif"},
        "edgeHistogram": {"-20..-5": 40}, "startedAt": T0, "bestGap": {"symbol": "SOL", "bps": 4, "at": T0},
        "msPerRequest": 1100, "hotEvents": 2, "lastHot": {"symbol": "SOL", "bps": 41.5, "at": T0},
    }
    with open(path, "w") as f:
        json.dump(ts_file, f)
    b = Brain(path, 20, min_ms_per_request=1_000)
    assert b.state["msPerRequest"] == 1100
    assert b.pick_size("SOL", 100) == (50, 0.5)  # 0.5 still warming up
    s = b.summary()
    assert "profit threshold: 31.3bps" in s
    assert "best size 25%" in s
    text = "\n".join(b.thoughts(20))
    assert "at least 31.3bps (0.31%) after fees, stricter than at the start" in text
    assert "closest I've come is SOL at 4bps (10-04 14:00 UTC); I need 31.3" in text
    b.save()
    assert json.load(open(path))["minProfitBps"] == 31.3


def test_survives_a_corrupted_file(path):
    b = Brain(path, 20)
    b.observe_trade("A", "failed", -0.001)
    b.save()
    b.save()  # the second save keeps the first as .bak
    with open(path, "w") as f:
        f.write('{"tokens": {"A": ')  # power cut mid-write
    again = Brain(path, 20)
    assert again.restored_from_backup
    assert again.min_profit_bps == 25
    with open(path + ".bak", "w") as f:
        f.write("garbage")
    fresh = Brain(path, 20)
    assert fresh.min_profit_bps == 20 and not fresh.restored_from_backup
