import asyncio

import httpx
import pytest

from arbbot.brain import Brain
from arbbot.poolwatch import PoolWatcher, WatchOptions
from arbbot.pricewatch import MAX_IDS, fetch_prices, parse_prices, requests_needed


def test_parses_v3_and_v2_and_skips_junk():
    assert parse_prices({"A": {"usdPrice": 1.5, "blockId": 1}, "B": {"usdPrice": None}, "C": {"usdPrice": -1}, "D": "x"}) == {"A": 1.5}
    assert parse_prices({"data": {"A": {"id": "A", "price": "2.25"}}, "timeTaken": 0.01}) == {"A": 2.25}
    assert parse_prices([]) == {} and parse_prices(None) == {}


def test_one_request_per_50_tokens_with_the_key_in_a_header():
    calls = []

    def handler(req: httpx.Request):
        ids = req.url.params["ids"].split(",")
        calls.append((len(ids), req.headers.get("x-api-key")))
        return httpx.Response(200, json={i: {"usdPrice": 1.0} for i in ids})

    counted = []

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await fetch_prices(c, "https://api.jup.ag/price/v3", [f"m{i}" for i in range(60)] + ["m0"], "k1", lambda: counted.append(1))

    prices = asyncio.run(go())
    assert len(prices) == 60
    assert calls == [(MAX_IDS, "k1"), (10, "k1")]
    assert len(counted) == 2 == requests_needed(60)
    assert requests_needed(30) == 1


def test_price_errors_are_raised_for_the_caller():
    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(429, text="slow down"))) as c:
            await fetch_prices(c, "https://x/price/v3", ["a"])

    with pytest.raises(RuntimeError, match="Jupiter price 429"):
        asyncio.run(go())


def test_a_price_jump_makes_a_token_hot(tmp_path):
    b = Brain(str(tmp_path / "brain.json"), 20, tokens_per_cycle=1, explore_rate=0)
    t0 = 1_000_000
    assert b.observe_market_price("WIF", 2.00, t0) is None
    assert b.observe_market_price("WIF", 2.001, t0 + 15_000) == pytest.approx(5)  # noise
    assert not b.is_hot("WIF", t0 + 15_000)
    assert b.observe_market_price("WIF", 2.02, t0 + 30_000) == pytest.approx(94.95, abs=0.1)
    assert b.is_hot("WIF", t0 + 30_000)
    assert list(b.pick_tokens({"SOL": "s", "WIF": "w"}, t0 + 31_000)) == ["WIF"]
    assert b.state["hotEvents"] == 1
    # Kept apart from the scan's own per-size rates.
    assert b.observe_price("WIF", 1, 0.5, t0 + 32_000) is None


def test_watcher_reports_pending_pool_changes():
    class Sub:
        def __init__(self):
            self.cbs = {}

        def subscribe(self, account, cb):
            self.cbs[account] = cb
            return len(self.cbs)

        def unsubscribe(self, i):
            pass

    t = {"now": 1_000}
    sub = Sub()
    w = PoolWatcher(sub, WatchOptions(max_pools=4, daily_event_cap=100, debounce_ms=0, busy_per_min=30), now=lambda: t["now"])
    asyncio.run(w.watch([("JTO", ["p1"]), ("WIF", ["p2"])]))
    assert not w.pending()
    sub.cbs["p1"](1)
    assert w.pending() and w.pending({"JTO"}) and not w.pending({"WIF"})
    assert w.pending(since=999) and not w.pending(since=1_000)
    assert w.pending()  # still there: pending() doesn't take it
    assert w.take("WIF") is None and w.take("JTO") == 1_000 and not w.pending()
    sub.cbs["p2"](1)
    assert w.take_dirty() == [("WIF", 1_000)] and not w.pending()
