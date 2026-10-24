"""
Probes: in paper mode, a positive gap that is below the trading bar is
re-quoted once (both legs, nothing built or sent) to see whether it was still
there. That costs two quotes and no money, and gives the brain far more
examples of which gaps are real than the few that clear the bar.

Probes live in their own file (data/probes-<mode>.jsonl), so they never count
toward the go-live gate, P&L or the trading funnel.

A probe record (camelCase JSON, same as the TypeScript bot):
  ts, symbol, kind, venues (DEXes the route went through), sizeUsd,
  quotedBps (net after costs at the scan), freshBps (net at the re-check),
  ageMs (scan quote finished -> re-check finished), event (pool-change scan)
"""

import math
import os
import re
from collections import deque
from dataclasses import dataclass

from .jsonl import append_jsonl, read_jsonl
from .util import js_round, now_ms, to_fixed


def venues_of(routes: str) -> list[str]:
    """Distinct venue labels in a route string like "Obsidian>Whirlpool | Bonkswap>BisonFi"."""
    out: list[str] = []
    for s in re.split(r"\s*[|>]\s*", routes):
        s = s.strip()
        if s and s != "?" and s not in out:
            out.append(s)
    return out


def held(p: dict) -> bool:
    """A gap "held" if, at the re-check, it was still positive and at least half its quoted size."""
    return p["freshBps"] > 0 and p["freshBps"] >= p["quotedBps"] / 2


class ProbeLog:
    def __init__(self, path: str):
        self.path = path
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)

    def append(self, r: dict) -> None:
        append_jsonl(self.path, r)

    @staticmethod
    def read(path: str) -> list[dict]:
        return read_jsonl(path)


@dataclass
class Tally:
    n: int = 0
    held: int = 0
    #: Sum of (quoted - fresh) bps: how much the gap shrank by the re-check.
    decay: float = 0


GAP_BUCKETS: list[tuple[str, float]] = [("0..5", 5), ("5..10", 10), ("10..20", 20), ("20..50", 50), ("50+", math.inf)]


def gap_bucket(bps: float) -> str:
    return next((b for b, hi in GAP_BUCKETS if bps < hi), "50+")


AGE_BUCKETS: list[tuple[str, float]] = [("< 0.5 s", 500), ("0.5–1 s", 1_000), ("1–2 s", 2_000), ("2 s+", math.inf)]


def age_bucket(ms: float) -> str:
    return next((b for b, hi in AGE_BUCKETS if ms < hi), "2 s+")


def probe_from_opp(o: dict) -> dict | None:
    """Funnel records with a fresh re-quote count as examples too (same "held" test)."""
    t = o.get("t") or {}
    if not o.get("executable") or t.get("requoteEnd") is None:
        return None
    return {
        "ts": o["ts"],
        "symbol": o["symbol"],
        "kind": o["kind"],
        "venues": venues_of(o["route"]),
        "sizeUsd": o["sizeUsd"],
        "quotedBps": o["quoted"]["netBps"],
        "freshBps": o["executable"]["netBps"],
        "ageMs": t["requoteEnd"] - t["quoteEnd"],
        "event": t.get("market") is not None,
    }


#: Enough examples in a group to say something about it.
MIN_SAMPLES = 10


def _pct(t: Tally) -> str:
    return f"{js_round(t.held / t.n * 100)}%"


class GapMemory:
    """
    What re-checks taught: how often a gap is still there, by gap size, token,
    venue, re-check delay and trigger. Rates are (held + 1) / (n + 2), so a
    handful of examples can't produce 0 % or 100 %.
    """

    def __init__(self):
        self.global_ = Tally()
        self.by_gap: dict[str, Tally] = {}
        self.by_token: dict[str, Tally] = {}
        self.by_venue: dict[str, Tally] = {}
        self.by_age: dict[str, Tally] = {}
        self.by_trigger: dict[str, Tally] = {}

    @staticmethod
    def from_records(probes, opps=()) -> "GapMemory":
        m = GapMemory()
        for p in probes:
            m.observe(p)
        for o in opps:
            p = probe_from_opp(o)
            if p:
                m.observe(p)
        return m

    def observe(self, p: dict) -> None:
        groups = [
            self.global_,
            self.by_gap.setdefault(gap_bucket(p["quotedBps"]), Tally()),
            self.by_token.setdefault(p["symbol"], Tally()),
            self.by_age.setdefault(age_bucket(p["ageMs"]), Tally()),
            self.by_trigger.setdefault("event" if p.get("event") else "poll", Tally()),
            *(self.by_venue.setdefault(v, Tally()) for v in p.get("venues", [])),
        ]
        h = held(p)
        for t in groups:
            t.n += 1
            if h:
                t.held += 1
            t.decay += p["quotedBps"] - p["freshBps"]

    @staticmethod
    def rate(t: Tally) -> float:
        return (t.held + 1) / (t.n + 2)

    def venue_trust(self, venues: list[str]) -> float:
        """
        How much less often gaps through these venues hold than gaps overall, as
        a factor in [0.25, 1]. Only venues with enough examples count; it never
        raises trust above average (unproven venues stay at 1).
        """
        if self.global_.n < MIN_SAMPLES * 2:
            return 1
        g = GapMemory.rate(self.global_)
        factor = 1.0
        for v in venues:
            t = self.by_venue.get(v)
            if not t or t.n < MIN_SAMPLES * 2:
                continue
            factor = min(factor, GapMemory.rate(t) / g)
        return max(0.25, min(1, factor))

    def thoughts(self) -> list[str]:
        """Plain-language lessons, only where there are enough examples."""
        out: list[str] = []
        g = self.global_
        if g.n < MIN_SAMPLES:
            if g.n:
                out.append(f"I've re-checked {g.n} gap(s) so far; I need {MIN_SAMPLES}+ to judge them.")
            return out
        out.append(
            f"I re-checked {g.n} gaps: {_pct(g)} were still there, and on average they shrank "
            f"{to_fixed(g.decay / g.n, 1)}bps by the re-check."
        )
        for b in ("20..50", "50+"):
            t = self.by_gap.get(b)
            if t and t.n >= MIN_SAMPLES and t.held / t.n < 0.2:
                out.append(f"Big quoted gaps (20+ bps) held only {_pct(t)} of the time: most are stale quotes, not real chances.")
                break
        venues = sorted(
            ((v, t) for v, t in self.by_venue.items() if t.n >= MIN_SAMPLES * 2), key=lambda e: GapMemory.rate(e[1])
        )
        if len(venues) >= 2:
            (worst, wt), (best, bt) = venues[0], venues[-1]
            if GapMemory.rate(bt) - GapMemory.rate(wt) > 0.1:
                out.append(f"Gaps through {worst} held {_pct(wt)} vs {_pct(bt)} through {best}, so I trust {worst} less.")
        ev, poll = self.by_trigger.get("event"), self.by_trigger.get("poll")
        if ev and poll and ev.n >= MIN_SAMPLES and poll.n >= MIN_SAMPLES:
            out.append(f"Gaps found right after a pool change held {_pct(ev)}; found by routine scans, {_pct(poll)}.")
        fast = self.by_age.get("< 0.5 s")
        slow = self.by_age.get("1–2 s") or self.by_age.get("2 s+")
        if fast and slow and fast.n >= MIN_SAMPLES and slow.n >= MIN_SAMPLES:
            out.append(f"Re-checked within half a second, {_pct(fast)} held; after a second or more, {_pct(slow)}.")
        return out

    def table(self) -> list[dict]:
        """Rows for the report: survival by gap size."""
        return [
            {"bucket": b, "n": t.n, "held_pct": t.held / t.n * 100, "avg_decay_bps": t.decay / t.n}
            for b, _ in GAP_BUCKETS
            if (t := self.by_gap.get(b)) and t.n > 0
        ]


class ProbeBudget:
    """Probe pacing: at most `per_hour` probes in any rolling hour."""

    def __init__(self, per_hour: int):
        self.per_hour = per_hour
        self._times: deque[float] = deque()

    def has(self, now: float | None = None) -> bool:
        """Is there room for a probe this hour? (does not use it up)"""
        now = now_ms() if now is None else now
        while self._times and self._times[0] <= now - 3_600_000:
            self._times.popleft()
        return len(self._times) < self.per_hour

    def allow(self, now: float | None = None) -> bool:
        """Uses up one probe if there is room."""
        now = now_ms() if now is None else now
        if not self.has(now):
            return False
        self._times.append(now)
        return True
