"""
Prediction maths shared by the gap predictor and the price-direction
strategy: a small logistic model (chance of yes/no) and a linear model
(a number), both learned online by gradient steps, plus a scorecard that
checks every prediction against what then happened.

Every prediction is scored BEFORE the model learns from its outcome
("prequential" testing), so the scorecard is an honest out-of-sample test:
the model never gets credit for remembering an answer it has already seen.
"""

import math


def sigmoid(z: float) -> float:
    if z >= 0:
        return 1 / (1 + math.exp(-z))
    e = math.exp(z)
    return e / (1 + e)


def logit(p: float) -> float:
    p = min(1 - 1e-6, max(1e-6, p))
    return math.log(p / (1 - p))


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


class Logistic:
    """P(yes | features), learned one example at a time, with L2 shrinkage so a few examples can't swing it."""

    def __init__(self, n_features: int, lr: float = 0.1, l2: float = 0.01, weights: list[float] | None = None):
        self.lr, self.l2 = lr, l2
        self.w = list(weights) if weights and len(weights) == n_features else [0.0] * n_features

    def predict(self, x: list[float]) -> float:
        return sigmoid(sum(wi * xi for wi, xi in zip(self.w, x)))

    def update(self, x: list[float], y: int) -> None:
        err = self.predict(x) - y
        # The bias (x[0] == 1) is not shrunk: it carries the base rate.
        for i, xi in enumerate(x):
            shrink = 0.0 if i == 0 else self.l2 * self.w[i]
            self.w[i] -= self.lr * (err * xi + shrink)


class Linear:
    """A number from features (least squares), learned one example at a time; targets are clipped."""

    def __init__(self, n_features: int, lr: float = 0.02, l2: float = 0.01, clip: float = 2.0, weights: list[float] | None = None):
        self.lr, self.l2, self.clip = lr, l2, clip
        self.w = list(weights) if weights and len(weights) == n_features else [0.0] * n_features

    def predict(self, x: list[float]) -> float:
        return sum(wi * xi for wi, xi in zip(self.w, x))

    def update(self, x: list[float], y: float) -> None:
        err = clamp(self.predict(x) - clamp(y, -self.clip, self.clip), -self.clip, self.clip)
        for i, xi in enumerate(x):
            shrink = 0.0 if i == 0 else self.l2 * self.w[i]
            self.w[i] -= self.lr * (err * xi + shrink)


#: Calibration bins for "when I said X%, how often was it yes?"
BINS = 10


class Scorecard:
    """
    How good the yes/no predictions were, each made before its outcome was
    known. Compared with the dumbest honest forecaster: always saying the
    running average rate.
      brier       mean (p - outcome)^2 of the model
      brier_base  the same for "always the average so far"
      skill       1 - brier / brier_base  (> 0: better than the average; <= 0: no better)
    """

    def __init__(self):
        self.n = 0
        self.yes = 0
        self.brier = 0.0
        self.brier_base = 0.0
        self.hits = 0
        self.hits_base = 0
        self.bins = [[0, 0.0, 0] for _ in range(BINS)]  # [n, sum of p, yes]

    def base_rate(self) -> float:
        """Running rate of "yes", shrunk toward 50% while there is little data."""
        return (self.yes + 1) / (self.n + 2)

    def record(self, p: float, y: int) -> None:
        base = self.base_rate()
        self.brier += (p - y) ** 2
        self.brier_base += (base - y) ** 2
        self.hits += int((p >= 0.5) == bool(y))
        self.hits_base += int((base >= 0.5) == bool(y))
        b = self.bins[min(BINS - 1, int(p * BINS))]
        b[0] += 1
        b[1] += p
        b[2] += y
        self.n += 1
        self.yes += y

    def skill(self) -> float:
        return 1 - self.brier / self.brier_base if self.brier_base > 0 else 0.0

    def accuracy(self) -> float:
        return self.hits / self.n if self.n else 0.0

    def accuracy_base(self) -> float:
        return self.hits_base / self.n if self.n else 0.0

    def calibration(self) -> list[dict]:
        """Rows: predicted range, how many, average predicted %, actual yes %."""
        out = []
        for i, (n, sp, yes) in enumerate(self.bins):
            if n:
                out.append({"range": f"{i * 100 // BINS}-{(i + 1) * 100 // BINS}%", "n": n,
                            "predicted_pct": sp / n * 100, "actual_pct": yes / n * 100})
        return out

    def to_dict(self) -> dict:
        return {"n": self.n, "yes": self.yes, "brier": self.brier, "brierBase": self.brier_base,
                "hits": self.hits, "hitsBase": self.hits_base, "bins": self.bins}

    @staticmethod
    def from_dict(d: dict | None) -> "Scorecard":
        s = Scorecard()
        if not isinstance(d, dict):
            return s
        try:
            s.n, s.yes = int(d.get("n", 0)), int(d.get("yes", 0))
            s.brier, s.brier_base = float(d.get("brier", 0)), float(d.get("brierBase", 0))
            s.hits, s.hits_base = int(d.get("hits", 0)), int(d.get("hitsBase", 0))
            bins = d.get("bins")
            if isinstance(bins, list) and len(bins) == BINS:
                s.bins = [[int(b[0]), float(b[1]), int(b[2])] for b in bins]
        except (TypeError, ValueError, IndexError):
            return Scorecard()
        return s
