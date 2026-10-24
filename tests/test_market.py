import asyncio
import json
from datetime import datetime, timezone
from types import SimpleNamespace

import httpx
import pytest

from arbbot.config import USDC_MINT
from arbbot.costs import CostSettings, estimate_costs, revalue, value_cycle
from arbbot.cycle import CycleSpec, leg_fee_bps, two_leg_spec
from arbbot.discovery import discover_tokens, parse_token_facts, parse_top_tokens
from arbbot.executor import plan_floor
from arbbot.jupiter import JupiterClient
from arbbot.scanner import scan_cycles
from arbbot.triangles import Rotation, triangle_specs

SOL = 100  # $ per SOL: 1 lamport = $1e-7
BASE = CostSettings(priority_fee_lamports=1_000, send_via="jito", tip_share=0.25, min_tip_lamports=1_000,
                    max_tip_lamports=2_000_000, safety_buffer_bps=3, safety_buffer_usd=0.001)


def usdc(usd):
    return int(usd * 1e6 + 0.5)


def cyc(in_usd, out_usd):
    return SimpleNamespace(in_atoms=usdc(in_usd), out_atoms=usdc(out_usd))


def val(in_usd, out_usd, s=BASE):
    return value_cycle(cyc(in_usd, out_usd), SOL, s)


# ---- costs ------------------------------------------------------------------------

def test_real_gap_profitable_after_costs():
    v = val(100, 101)
    assert v.gross_usd == pytest.approx(1)
    assert v.net_usd > 0.5
    assert v.net_usd == pytest.approx(v.gross_usd - v.costs.total_usd, abs=1e-12)


def test_negative_round_trip_unprofitable():
    assert val(100, 99.9).net_usd < 0


def test_fees_eliminate_tiny_edge():
    v = val(10, 10.0005)
    assert v.gross_usd > 0 and v.net_usd < 0


def test_slippage_eliminates_profit():
    quoted = cyc(10, 10.05)
    v = value_cycle(quoted, SOL, BASE)
    plan = plan_floor(quoted, v.costs, 20, 100)
    slipped = cyc(10, 10.01)
    assert slipped.out_atoms < plan.required
    assert revalue(slipped, v.costs).net_usd < v.net_usd


def test_high_minimum_tip_eliminates_profit():
    expensive = CostSettings(**{**BASE.__dict__, "min_tip_lamports": 1_000_000})
    assert val(10, 10.05).net_usd > 0
    assert val(10, 10.05, expensive).net_usd < 0


def test_tip_scales_but_capped():
    small = estimate_costs(0.1, 10, SOL, BASE)
    big = estimate_costs(10, 1000, SOL, BASE)
    assert big.tip_lamports > small.tip_lamports
    room = 0.1 - small.network_usd + small.tip_usd - small.buffer_usd
    assert small.tip_usd <= room * 0.25 + 1e-9
    assert estimate_costs(1_000, 100_000, SOL, BASE).tip_lamports == 2_000_000


def test_no_tip_via_rpc():
    assert estimate_costs(1, 100, SOL, CostSettings(**{**BASE.__dict__, "send_via": "rpc"})).tip_lamports == 0


def test_buffer_grows_with_size():
    assert estimate_costs(1, 1000, SOL, BASE).buffer_usd == pytest.approx(0.3 + 0.001)


def test_leg_fee_from_hops():
    q = {"routePlan": [
        {"percent": 100, "swapInfo": {"inputMint": "A", "outputMint": "B", "inAmount": "1000000", "outAmount": "990000", "feeAmount": "2500", "feeMint": "A"}},
        {"percent": 100, "swapInfo": {"inputMint": "B", "outputMint": "C", "inAmount": "990000", "outAmount": "980000", "feeAmount": "0", "feeMint": "B"}},
    ]}
    assert leg_fee_bps(q) == pytest.approx(25)


# ---- triangles --------------------------------------------------------------------

def test_triangle_specs_both_directions():
    specs = triangle_specs({"SOL": "sol", "JUP": "jup", "WIF": "wif"}, "SOL")
    assert [s.symbol for s in specs] == ["SOL>JUP", "JUP>SOL", "SOL>WIF", "WIF>SOL"]
    assert specs[0] == CycleSpec("triangle", "SOL>JUP", ["SOL", "JUP"], [USDC_MINT, "sol", "jup", USDC_MINT])
    assert triangle_specs({"JUP": "jup", "WIF": "wif"}, "SOL") == []


def test_rotation():
    r = Rotation()
    items = ["a", "b", "c", "d", "e"]
    assert r.take(items, 2) == ["a", "b"]
    assert r.take(items, 2) == ["c", "d"]
    assert r.take(items, 2) == ["e", "a"]
    assert r.take(["x"], 3) == ["x"]
    assert r.take([], 2) == []


# ---- discovery --------------------------------------------------------------------

def test_discovery_keeps_verified_liquid_non_stables():
    found = parse_top_tokens([
        {"id": "good-mint", "symbol": "GOOD", "liquidity": 5_000_000, "isVerified": True},
        {"id": "thin-mint", "symbol": "THIN", "liquidity": 10_000, "isVerified": True},
        {"id": "scam-mint", "symbol": "SCAM", "liquidity": 9_000_000, "isVerified": False},
        {"id": USDC_MINT, "symbol": "USDC", "liquidity": 1e9, "isVerified": True},
        {"id": "tag-mint", "symbol": "$Tag!", "liquidity": 2_000_000, "tags": ["verified"]},
        {"id": "dupe-mint", "symbol": "GOOD", "liquidity": 3_000_000, "isVerified": True},
    ], 1_000_000, 10)
    assert found == {"GOOD": "good-mint", "TAG": "tag-mint", "GOOD-dupe": "dupe-mint"}


def test_discovery_market_facts():
    facts = parse_token_facts([
        {"id": "m1", "symbol": "A", "liquidity": 2_000_000, "holderCount": 5400, "isVerified": True,
         "firstPool": {"createdAt": "2026-09-01T00:00:00Z"}, "audit": {"topHoldersPercentage": 23.5}},
        {"id": "m2", "symbol": "B"},
    ])
    assert facts["m1"] == {"liquidityUsd": 2_000_000, "holders": 5400,
                           "poolCreatedAt": int(datetime(2026, 9, 1, tzinfo=timezone.utc).timestamp() * 1000),
                           "topHoldersPct": 23.5, "verified": True}
    assert facts["m2"] == {"liquidityUsd": None, "holders": None, "poolCreatedAt": None, "topHoldersPct": None, "verified": False}


def test_discovery_unexpected_body():
    assert parse_top_tokens({"error": "nope"}, 1_000_000, 10) == {}


def test_discovery_http_error_and_api_key():
    seen = {}

    def handler(req):
        seen["key"] = req.headers.get("x-api-key")
        return httpx.Response(429, text="rate limited") if "fail" in str(req.url) else httpx.Response(200, json=[])

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            with pytest.raises(RuntimeError, match="429"):
                await discover_tokens("https://fail", 1_000_000, 10, c)
            assert await discover_tokens("https://api.jup.ag/tokens/v2", 1_000_000, 10, c, "k123") == ({}, {})

    asyncio.run(run())
    assert seen["key"] == "k123"


# ---- scanner ------------------------------------------------------------------------

#: Old fixed-fee setup: 5000 base + 10000 priority lamports, no tip, no buffer.
FEES = CostSettings(10_000, "rpc", 0, 0, 0, 0, 0)


def specs(*syms):
    return [two_leg_spec(s, s) for s in syms]


def fake_jupiter(log=None, fail_mint=None):
    """Token X has a 1% gap, token Y loses 0.3%."""

    def handler(req: httpx.Request):
        p = req.url.params
        amount = int(p["amount"])
        if log is not None:
            log.append((p["inputMint"], p["outputMint"]))
        if p["outputMint"] == fail_mint:
            return httpx.Response(429, text="Too Many Requests")
        if p["inputMint"].startswith("EPjF"):
            out = amount * 2
        elif p["inputMint"] == "X":
            out = amount * 101 // 200
        else:
            out = amount * 997 // 2000
        return httpx.Response(200, json={
            "inputMint": p["inputMint"], "outputMint": p["outputMint"], "inAmount": str(amount), "outAmount": str(out),
            "otherAmountThreshold": str(out), "slippageBps": 0, "priceImpactPct": "0", "routePlan": [{"swapInfo": {"label": "Fake"}}],
        })

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_scan_ranks_by_net_after_fees():
    async def run():
        async with fake_jupiter() as c:
            return await scan_cycles(JupiterClient("https://fake", c), specs("Y", "X"), lambda s: 10_000_000, 200, FEES)

    opps = asyncio.run(run())
    assert [o.cycle.symbol for o in opps] == ["X", "Y"]
    assert opps[0].val.net_usd == pytest.approx(0.1 - 0.003, abs=1e-6)
    assert opps[1].val.net_usd < 0
    assert len(opps[0].cycle.legs) == 2
    assert opps[0].cycle.routes == "Fake | Fake"


def test_scan_reports_failures_and_keeps_the_rest():
    errors = []

    async def run():
        async with fake_jupiter(fail_mint="BAD") as c:
            return await scan_cycles(JupiterClient("https://fake", c), specs("X", "Y", "BAD"), lambda s: 10_000_000, 200, FEES,
                                     on_error=lambda s, e: errors.append(f"{s.symbol}: {e}"))

    opps = asyncio.run(run())
    assert [o.cycle.symbol for o in opps] == ["X", "Y"]
    assert errors[0].startswith("BAD: ") and " 429" in errors[0]


def test_scan_paces_each_cycle_and_keeps_legs_together():
    log, waits = [], []

    async def before(spec):
        waits.append(spec.symbol)

    async def run():
        async with fake_jupiter(log) as c:
            return await scan_cycles(JupiterClient("https://fake", c), specs("X", "Y"), lambda s: 10_000_000, 200, FEES, before_each=before)

    opps = asyncio.run(run())
    assert [o.cycle.symbol for o in opps] == ["X", "Y"]
    assert waits == ["X", "Y"]
    assert ["buy" if i.startswith("EPjF") else "sell" for i, _ in log] == ["buy", "sell", "buy", "sell"]


def test_failing_pacing_hook_skips_token():
    errors = []

    async def before(spec):
        raise RuntimeError("stopping")

    async def run():
        async with fake_jupiter() as c:
            return await scan_cycles(JupiterClient("https://fake", c), specs("X"), lambda s: 10_000_000, 200, FEES,
                                     on_error=lambda s, e: errors.append(s.symbol), before_each=before)

    assert asyncio.run(run()) == []
    assert errors == ["X"]


def test_scan_stops_at_first_candidate():
    log = []

    async def run():
        async with fake_jupiter(log) as c:
            return await scan_cycles(JupiterClient("https://fake", c), specs("Y", "X", "Z"), lambda s: 10_000_000, 200, FEES,
                                     stop_after=lambda s: s.val.net_usd > 0)

    opps = asyncio.run(run())
    assert [o.cycle.symbol for o in opps] == ["X", "Y"]
    assert [o for i, o in log if i.startswith("EPjF")] == ["Y", "X"]
