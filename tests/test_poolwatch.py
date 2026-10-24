import asyncio
from datetime import datetime, timezone

from arbbot import poolwatch
from arbbot.poolwatch import PoolWatcher, WatchOptions

OPTS = dict(max_pools=3, daily_event_cap=1_000, debounce_ms=1_000, busy_per_min=30)
T0 = int(datetime(2026, 10, 5, 12, tzinfo=timezone.utc).timestamp() * 1000)


class FakeSubscriber:
    """Fake WebSocket: records subscriptions and lets the test fire pool updates."""

    def __init__(self):
        self.next = 1
        self.live = {}

    def subscribe(self, account, cb):
        i = self.next
        self.next += 1
        self.live[i] = (account, cb)
        return i

    def unsubscribe(self, i):
        self.live.pop(i, None)

    def fire(self, account):
        for acc, cb in list(self.live.values()):
            if acc == account:
                cb(1)

    def watched(self):
        return sorted(acc for acc, _ in self.live.values())


def test_watches_most_promising_pools_up_to_limit():
    async def run():
        f = FakeSubscriber()
        w = PoolWatcher(f, WatchOptions(**OPTS), now=lambda: T0)
        await w.watch([("JUP", ["p1", "p2"]), ("WIF", ["p3", "p4"])])
        assert f.watched() == ["p1", "p2", "p3"]
        await w.watch([("WIF", ["p4"]), ("JUP", ["p1"])])
        assert f.watched() == ["p1", "p4"]
        assert w.stats().watching == 2

    asyncio.run(run())


def test_marks_dirty_with_debounce_and_wakes():
    async def run():
        f = FakeSubscriber()
        t = {"now": T0}
        wakes = []
        w = PoolWatcher(f, WatchOptions(**OPTS), on_dirty=lambda: wakes.append(1), now=lambda: t["now"])
        await w.watch([("JUP", ["shared"]), ("WIF", ["shared", "w1"])])
        f.fire("shared")
        assert len(wakes) == 1
        t["now"] += 300
        f.fire("w1")
        assert len(wakes) == 1
        assert sorted(w.take_dirty()) == [("JUP", T0), ("WIF", T0)]
        assert w.take_dirty() == []
        t["now"] += 1_000
        f.fire("w1")
        assert w.take_dirty() == [("WIF", T0 + 1_300)]
        w.remark("WIF", T0 + 1_300)
        assert w.take_dirty() == [("WIF", T0 + 1_300)]

    asyncio.run(run())


def test_drops_busy_pool_for_a_while():
    async def run():
        f = FakeSubscriber()
        t = {"now": T0}
        w = PoolWatcher(f, WatchOptions(**{**OPTS, "busy_per_min": 5, "busy_cooldown_ms": 3_600_000}), now=lambda: t["now"])
        await w.watch([("SOL", ["busy", "calm"])])
        for _ in range(6):
            t["now"] += 2_000
            f.fire("busy")
        assert f.watched() == ["calm"]
        assert w.stats().too_busy == 1
        await w.watch([("SOL", ["busy", "calm"])])
        assert f.watched() == ["calm"]
        t["now"] += 3_600_001
        await w.watch([("SOL", ["busy", "calm"])])
        assert f.watched() == ["busy", "calm"]

    asyncio.run(run())


def test_daily_event_cap():
    async def run():
        f = FakeSubscriber()
        t = {"now": T0}
        warnings = []
        w = PoolWatcher(f, WatchOptions(**{**OPTS, "daily_event_cap": 3, "debounce_ms": 0}), now=lambda: t["now"], on_warn=warnings.append)
        await w.watch([("JUP", ["p1"])])
        for _ in range(3):
            t["now"] += 10_000
            f.fire("p1")
        await asyncio.sleep(0)
        s = w.stats()
        assert s.capped and s.events_today == 3
        assert f.watched() == []
        assert "paused until tomorrow" in warnings[0]
        await w.watch([("JUP", ["p1"])])
        assert f.watched() == []
        t["now"] += 86_400_000
        await w.watch([("JUP", ["p1"])])
        assert f.watched() == ["p1"]
        s = w.stats()
        assert not s.capped and s.events_today == 0

    asyncio.run(run())


def test_skips_pool_it_cannot_subscribe_to():
    class Sub:
        def subscribe(self, account, cb):
            if account == "bad":
                raise ConnectionError("socket closed")
            return 7

        def unsubscribe(self, i):
            pass

    async def run():
        warnings = []
        w = PoolWatcher(Sub(), WatchOptions(**OPTS), now=lambda: T0, on_warn=warnings.append)
        await w.watch([("JUP", ["bad", "good"])])
        assert w.stats().watching == 1
        assert "could not watch pool bad" in warnings[0]

    asyncio.run(run())


def test_never_waits_for_unsubscribe_reply():
    class Sub:
        live = 0

        def subscribe(self, account, cb):
            Sub.live += 1
            return Sub.live

        def unsubscribe(self, i):
            return asyncio.get_running_loop().create_future()  # half-dead socket: no reply, ever

    async def run():
        w = PoolWatcher(Sub(), WatchOptions(**OPTS), now=lambda: T0)
        await w.watch([("JUP", ["p1", "p2"])])
        await asyncio.wait_for(w.watch([("JUP", ["p3"])]), 0.5)
        assert w.stats().watching == 1

    asyncio.run(run())


def test_gives_up_on_subscribe_that_never_answers(monkeypatch):
    monkeypatch.setattr(poolwatch, "SUBSCRIBE_TIMEOUT_S", 0.05)

    class Sub:
        def subscribe(self, account, cb):
            return asyncio.get_running_loop().create_future()

        def unsubscribe(self, i):
            pass

    async def run():
        warnings = []
        w = PoolWatcher(Sub(), WatchOptions(**OPTS), now=lambda: T0, on_warn=warnings.append)
        await w.watch([("JUP", ["p1"])])
        assert w.stats().watching == 0
        assert "no answer" in warnings[0]

    asyncio.run(run())
