"""
Exact sliding-window request counter over one or more windows (per minute and
per 10 seconds). It tracks every Jupiter request the bot sends, so the bot can
use its allowance without ever going over any of the limits.
"""

import time

#: Extra wait after the oldest request leaves a window (timers can fire a little early).
SAFETY_MS = 100


def _now_ms() -> float:
    return time.time() * 1000


class RequestBudget:
    def __init__(self, limits):
        """`limits`: one per-minute limit (int), or [(window ms, limit), ...]."""
        self.windows: list[tuple[int, int]] = [(60_000, limits)] if isinstance(limits, int) else list(limits)
        self.times: list[float] = []

    def _prune(self, now: float) -> None:
        longest = max(ms for ms, _ in self.windows)
        while self.times and self.times[0] <= now - longest:
            self.times.pop(0)

    def record(self, now: float | None = None) -> None:
        self.times.append(_now_ms() if now is None else now)

    def used(self, now: float | None = None, window_ms: int = 60_000) -> int:
        now = _now_ms() if now is None else now
        self._prune(now)
        return sum(1 for t in self.times if t > now - window_ms)

    def available(self, now: float | None = None) -> int:
        """How many more requests fit in every window right now."""
        now = _now_ms() if now is None else now
        self._prune(now)
        room = [limit - sum(1 for t in self.times if t > now - ms) for ms, limit in self.windows]
        return max(0, min(room))

    def wait_for(self, n: int, now: float | None = None) -> float:
        """How long to wait (ms) before `n` more requests fit in every window."""
        now = _now_ms() if now is None else now
        self._prune(now)
        wait = 0.0
        for ms, limit in self.windows:
            in_window = [t for t in self.times if t > now - ms]
            need = min(n, limit)
            room = limit - len(in_window)
            if need <= room:
                continue
            must_expire = min(need - room, len(in_window))
            wait = max(wait, in_window[must_expire - 1] + ms - now + SAFETY_MS)
        return wait
