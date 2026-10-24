"""
Gap predictor: for every quoted gap, predicts the chance it will still be
there at the fresh re-check, and how big it will be then, from what earlier
re-checks showed (probes and re-quoted opportunities):

  gap size        bigger quoted gaps are more often stale quotes
  re-check delay  gaps die quickly
  trigger         right after a pool change, or a routine scan
  kind            round trip or triangle
  token, venue    how often their gaps held before (shrunk toward average)
  hour, size

Each prediction is scored before its outcome is learned, so the scorecard is
an honest test. The bot only lets the predictions change its decisions once
they have beaten "assume the average" over enough re-checks; until then it
uses the simpler venue trust (probes.GapMemory).
"""

import math
from collections import deque

from .predict import Linear, Logistic, Scorecard, clamp, logit
from .probes import GapMemory, held, probe_from_opp
from .util import to_fixed, utc_hour

N_FEATURES = 10
#: Re-checks needed, and how much better than average, before predictions change decisions.
MIN_EXAMPLES = 100
MIN_SKILL = 0.05
#: How far a prediction may move expected value: never below a quarter, at most 1.5x.
MIN_FACTOR, MAX_FACTOR = 0.25, 1.5


class GapPredictor:
    def __init__(self):
        #: What re-checks taught, by group (also used as token/venue features).
        self.memory = GapMemory()
        self.hold = Logistic(N_FEATURES, lr=0.1, l2=0.002)
        self.size = Linear(N_FEATURES + 1, lr=0.02, l2=0.01, clip=3.0)
        self.score = Scorecard()
        #: Size predictions: mean absolute error (bps), vs taking the quote at face value.
        self.size_n = 0
        self.size_err = 0.0
        self.size_err_quote = 0.0
        self._ages: deque[float] = deque(maxlen=50)

    @staticmethod
    def from_records(probes, opps=()) -> "GapPredictor":
        """Replays every re-check in time order, scoring each prediction before learning from it."""
        examples = [p for p in probes if isinstance(p, dict)]
        examples += [p for p in (probe_from_opp(o) for o in opps) if p]
        g = GapPredictor()
        for ex in sorted(examples, key=lambda e: e.get("ts", 0)):
            try:
                g.learn(ex)
            except (KeyError, TypeError, ValueError):
                continue  # a malformed old line
        return g

    # -- features ------------------------------------------------------------------------

    def _relative(self, tally) -> float:
        """How a group's hold rate compares with the overall rate, in log-odds (0 = no data)."""
        overall = self.memory.global_
        if not tally or tally.n == 0 or overall.n == 0:
            return 0.0
        return clamp(logit(GapMemory.rate(tally)) - logit(GapMemory.rate(overall)), -3, 3) / 3

    def expected_age_ms(self) -> float:
        """Typical time from a scan quote to its re-check, measured on this device."""
        if not self._ages:
            return 500.0
        s = sorted(self._ages)
        return s[len(s) // 2]

    def features(self, g: dict) -> list[float]:
        q = float(g["quotedBps"])
        hour = utc_hour(int(g.get("ts") or 0))
        venues = g.get("venues") or []
        venue = min((self._relative(self.memory.by_venue.get(v)) for v in venues), default=0.0)
        return [
            1.0,
            math.log1p(max(q, 0.0)) / 3,
            min(float(g.get("ageMs", self.expected_age_ms())), 5_000) / 2_000,
            1.0 if g.get("event") else 0.0,
            1.0 if g.get("kind") == "triangle" else 0.0,
            self._relative(self.memory.by_token.get(g.get("symbol"))),
            venue,
            0.5 * math.sin(2 * math.pi * hour / 24),
            0.5 * math.cos(2 * math.pi * hour / 24),
            math.log10(max(float(g.get("sizeUsd") or 1), 1.0)) / 2,
        ]

    def _size_features(self, x: list[float], q: float) -> list[float]:
        return x + [clamp(q / 100, -3, 3)]

    # -- predicting and learning -------------------------------------------------------------

    def predict(self, g: dict) -> tuple[float, float]:
        """(chance the gap is still there at the re-check, expected bps then)."""
        x = self.features(g)
        return self.hold.predict(x), self.size.predict(self._size_features(x, float(g["quotedBps"]))) * 100

    def learn(self, g: dict) -> None:
        """One re-check's outcome: score the prediction made without it, then learn from it."""
        q, fresh = float(g["quotedBps"]), float(g["freshBps"])
        x = self.features(g)
        xs = self._size_features(x, q)
        y = int(held(g))
        self.score.record(self.hold.predict(x), y)
        self.size_err += abs(self.size.predict(xs) * 100 - fresh)
        self.size_err_quote += abs(q - fresh)
        self.size_n += 1
        self.hold.update(x, y)
        self.size.update(xs, fresh / 100)
        self.memory.observe(g)
        if g.get("ageMs") is not None:
            self._ages.append(float(g["ageMs"]))

    def skilled(self) -> bool:
        """Have the predictions beaten "assume the average" over enough re-checks?"""
        return self.score.n >= MIN_EXAMPLES and self.score.skill() >= MIN_SKILL

    def factor(self, g: dict) -> float:
        """
        Multiplier for a gap's expected value. Before the predictions have proven
        themselves: venue trust only (never above 1). After: predicted chance
        relative to the average, between a quarter and 1.5x.
        """
        if not self.skilled():
            return self.memory.venue_trust(g.get("venues") or [])
        p, _ = self.predict(g)
        return clamp(p / self.score.base_rate(), MIN_FACTOR, MAX_FACTOR)

    # -- reporting -------------------------------------------------------------------------

    def thoughts(self) -> list[str]:
        n = self.score.n
        if n < 10:
            return [f"I'm learning to predict which gaps are real: {n} re-check(s) so far, I need 10+."] if n else []
        skill = self.score.skill() * 100
        base = self.score.base_rate() * 100
        verdict = (
            "so I now use them to decide." if self.skilled()
            else f"so I don't rely on them yet (I need {MIN_EXAMPLES}+ re-checks and a clear edge)."
        )
        out = [
            f"I predict whether a gap will still be there when I check again. Over {n} re-checks my predictions were "
            + (f"{to_fixed(skill, 0)}% better than" if skill > 0 else "no better than")
            + f" assuming the average ({to_fixed(base, 0)}% still there), {verdict}"
        ]
        if self.size_n >= 10:
            out.append(
                f"My guesses of a gap's real size at the re-check were off by {to_fixed(self.size_err / self.size_n, 1)}bps "
                f"on average; taking the quote at face value was off by {to_fixed(self.size_err_quote / self.size_n, 1)}bps."
            )
        return out

    def summary(self) -> dict:
        n = self.size_n
        return {
            "n": self.score.n,
            "skill_pct": self.score.skill() * 100,
            "accuracy_pct": self.score.accuracy() * 100,
            "accuracy_base_pct": self.score.accuracy_base() * 100,
            "base_rate_pct": self.score.base_rate() * 100,
            "used": self.skilled(),
            "size_err_bps": self.size_err / n if n else None,
            "size_err_quote_bps": self.size_err_quote / n if n else None,
            "calibration": self.score.calibration(),
        }
