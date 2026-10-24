"""
Event triggers. Instead of only re-quoting tokens in turn, the bot listens
(over the RPC's WebSocket) to the pool accounts its routes use. A change in a
pool means someone traded there, which is when one venue's price can drift
from another's; the token is then marked "dirty" and quoted right away.

Costs are capped:
 - at most `max_pools` pools are watched (the most promising tokens' routes)
 - a pool that changes nearly every slot carries no signal ("always moving")
   and costs the most traffic: it is dropped for an hour
 - at most `daily_event_cap` notifications a day (each carries the pool's data)
 - each token is marked dirty at most once per `debounce_ms`
"""

import asyncio
import inspect
from collections import deque
from dataclasses import dataclass, field
from typing import Callable

from .util import now_ms

DAY_MS = 86_400_000
SUBSCRIBE_TIMEOUT_S = 5.0


class RpcSubscriber:
    """The RPC WebSocket (accountSubscribe / accountUnsubscribe) as a subscriber."""

    def __init__(self, ws):
        self.ws = ws

    def subscribe(self, account: str, on_change: Callable[[int], None]) -> int:
        return self.ws.account_subscribe(account, on_change, "processed")

    def unsubscribe(self, sub_id: int) -> None:
        self.ws.unsubscribe(sub_id)


@dataclass
class WatchOptions:
    max_pools: int
    daily_event_cap: int
    debounce_ms: float
    #: A pool with more notifications than this in a minute is dropped for `busy_cooldown_ms`.
    busy_per_min: int
    busy_cooldown_ms: float = 60 * 60_000


@dataclass
class WatchStats:
    watching: int
    events_today: int
    capped: bool
    too_busy: int


@dataclass
class _Sub:
    id: int | None
    tokens: set[str]
    times: deque = field(default_factory=deque)


_background: set = set()


def _fire_and_forget(result) -> None:
    """Run an unsubscribe reply in the background and never wait for it."""
    if not inspect.isawaitable(result):
        return
    task = asyncio.ensure_future(result)
    _background.add(task)

    def done(t):
        _background.discard(t)
        if not t.cancelled():
            t.exception()  # mark as retrieved: an error here is harmless

    task.add_done_callback(done)


class PoolWatcher:
    def __init__(
        self,
        sub,
        opts: WatchOptions,
        on_dirty: Callable[[], None] = lambda: None,
        now: Callable[[], float] = now_ms,
        on_warn: Callable[[str], None] = lambda msg: None,
    ):
        self.sub = sub
        self.opts = opts
        #: Called when a token becomes dirty (wakes the main loop).
        self.on_dirty = on_dirty
        self.now = now
        self.on_warn = on_warn
        #: pool -> subscription id and the tokens whose routes use it
        self._subs: dict[str, _Sub] = {}
        self._too_busy: dict[str, float] = {}
        self._dirty: dict[str, float] = {}
        self._last_marked: dict[str, float] = {}
        self._day = -1
        self._events_today = 0
        self._capped = False

    async def watch(self, wanted: list[tuple[str, list[str]]]) -> None:
        """
        Watch the pools of these (symbol, pools) tokens, most promising first,
        up to `max_pools`. Pools no longer wanted are unsubscribed.
        """
        self._roll_day()
        if self._capped:
            return
        now = self.now()
        plan: dict[str, set[str]] = {}
        for symbol, pools in wanted:
            for pool in pools:
                if self._too_busy.get(pool, 0) > now:
                    continue
                if pool not in plan and len(plan) >= self.opts.max_pools:
                    continue
                plan.setdefault(pool, set()).add(symbol)
        for pool, s in list(self._subs.items()):
            if pool not in plan:
                self._drop(pool, s.id)
        for pool, tokens in plan.items():
            existing = self._subs.get(pool)
            if existing:
                existing.tokens = tokens
                continue
            entry = _Sub(None, tokens)
            self._subs[pool] = entry
            try:
                sub_id = self.sub.subscribe(pool, lambda _slot, pool=pool: self._on_event(pool))
                if inspect.isawaitable(sub_id):
                    try:
                        sub_id = await asyncio.wait_for(sub_id, SUBSCRIBE_TIMEOUT_S)
                    except asyncio.TimeoutError:
                        raise TimeoutError(f"no answer in {int(SUBSCRIBE_TIMEOUT_S * 1000)} ms") from None
                entry.id = sub_id
            except Exception as err:  # noqa: BLE001 - one bad pool must not stop the others
                self._subs.pop(pool, None)
                self.on_warn(f"could not watch pool {pool[:8]}…: {str(err)[:100]}")

    def _drop(self, pool: str, sub_id: int | None) -> None:
        self._subs.pop(pool, None)
        if sub_id is None:
            return
        # Never wait for the reply: on a half-dropped phone connection it never
        # comes, which froze the whole TypeScript bot once.
        try:
            _fire_and_forget(self.sub.unsubscribe(sub_id))
        except Exception:  # noqa: BLE001 - already gone (e.g. the socket reconnected)
            pass

    def _roll_day(self) -> None:
        day = int(self.now() // DAY_MS)
        if day != self._day:
            self._day = day
            self._events_today = 0
            self._capped = False

    def _on_event(self, pool: str) -> None:
        self._roll_day()
        s = self._subs.get(pool)
        if not s or self._capped:
            return
        now = self.now()
        self._events_today += 1
        if self._events_today >= self.opts.daily_event_cap:
            self._capped = True
            self.on_warn(f"event triggers paused until tomorrow (UTC): {self.opts.daily_event_cap} pool updates today")
            self.unwatch_all()
            return
        s.times.append(now)
        while s.times and s.times[0] <= now - 60_000:
            s.times.popleft()
        if len(s.times) > self.opts.busy_per_min:
            # Changes nearly every slot: no signal in it, and the most traffic. Rest it.
            self._too_busy[pool] = now + self.opts.busy_cooldown_ms
            self._drop(pool, s.id)
            return
        marked = False
        for token in s.tokens:
            if now - self._last_marked.get(token, 0) < self.opts.debounce_ms:
                continue
            self._last_marked[token] = now
            self._dirty[token] = now
            marked = True
        if marked:
            self.on_dirty()

    def take_dirty(self) -> list[tuple[str, float]]:
        """Dirty tokens and when their pool changed, newest first; clears them."""
        out = sorted(self._dirty.items(), key=lambda x: -x[1])
        self._dirty.clear()
        return out

    def remark(self, symbol: str, ts: float) -> None:
        """Put a dirty token back (e.g. it could not be quoted this time)."""
        self._dirty.setdefault(symbol, ts)

    def stats(self) -> WatchStats:
        self._roll_day()
        now = self.now()
        return WatchStats(len(self._subs), self._events_today, self._capped, sum(1 for t in self._too_busy.values() if t > now))

    def unwatch_all(self) -> None:
        for pool, s in list(self._subs.items()):
            self._drop(pool, s.id)
