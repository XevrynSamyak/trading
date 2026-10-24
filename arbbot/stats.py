"""
Learning engine V2: success rates for every funnel step, learned from what
actually happened (data/opps-<mode>.jsonl is the source of truth and is
replayed at startup).

Each rate is a Beta-posterior mean shrunk toward the global rate, so a token
with 2 samples doesn't swing wildly:
    rate = (successes + k*m) / (trials + k),   m = global rate, k = 4
Steps never observed yet (e.g. landing before any real trade) use an explicit
prior and are listed as "assumed".
"""

import math
from dataclasses import dataclass, field

from .funnel import STAGES
from .util import utc_hour

PRIOR_STRENGTH = 4


@dataclass
class Counts:
    n: int = 0
    executable: int = 0
    sim_tried: int = 0
    sim_ok: int = 0
    submitted: int = 0
    landed: int = 0
    profitable: int = 0
    sum_quoted_bps: float = 0
    n_exec: int = 0
    sum_exec_bps: float = 0
    n_sim: int = 0
    sum_sim_bps: float = 0
    n_real: int = 0
    sum_real_bps: float = 0
    realized_usd: float = 0
    sum_latency_ms: float = 0
    n_latency: int = 0


@dataclass
class Priors:
    #: Assumed chance a simulated-OK transaction lands, until real trades say otherwise.
    landing: float = 0.5
    #: Assumed chance a landed trade is profitable (the on-chain floor makes this high).
    profit_given_landed: float = 0.9
    #: Assumed chance the exact transaction simulates OK, until simulations say otherwise.
    simulation: float = 0.5


DEFAULT_PRIORS = Priors()


@dataclass
class Probabilities:
    executable: float
    simulation: float
    landing: float
    profit: float
    #: Chance an attempt ends as intended in this mode.
    success: float
    #: Steps with no data yet, filled with priors.
    assumed: list[str] = field(default_factory=list)


#: Size buckets for statistics, by upper bound in USD.
SIZE_BOUNDS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000]


def size_bucket(usd: float) -> str:
    b = next((x for x in SIZE_BOUNDS if usd <= x), None)
    return ">5000" if b is None else f"<={b}"


_EXEC = STAGES.index("executable")
_SUBMITTED = STAGES.index("submitted")


class LearningStats:
    def __init__(self, priors: Priors = DEFAULT_PRIORS):
        self.priors = priors
        self.global_ = Counts()
        self.by_token: dict[str, Counts] = {}
        self.by_route: dict[str, Counts] = {}
        self.by_size: dict[str, Counts] = {}
        self.by_hour: dict[str, Counts] = {}

    @staticmethod
    def from_records(records, priors: Priors | None = None) -> "LearningStats":
        s = LearningStats(priors or DEFAULT_PRIORS)
        for r in records:
            s.observe(r)
        return s

    def observe(self, r: dict) -> None:
        groups = [
            self.global_,
            self.by_token.setdefault(r["symbol"], Counts()),
            self.by_route.setdefault(r["route"], Counts()),
            self.by_size.setdefault(size_bucket(r["sizeUsd"]), Counts()),
            self.by_hour.setdefault(str(utc_hour(r["ts"])), Counts()),
        ]
        stage = STAGES.index(r["stage"]) if r.get("stage") in STAGES else -1
        real_money = r.get("mode") != "paper"
        executable = r.get("executable")
        simulated = r.get("simulated")
        realized = r.get("realized")
        total_ms = (r.get("lat") or {}).get("totalMs")
        for c in groups:
            c.n += 1
            c.sum_quoted_bps += r["quoted"]["netBps"]
            if executable:
                c.n_exec += 1
                c.sum_exec_bps += executable["netBps"]
            if stage >= _EXEC:
                c.executable += 1
            # Simulation outcome: explicit in paper; in real modes "sent" means it simulated OK.
            if simulated:
                c.sim_tried += 1
                if simulated.get("ok"):
                    c.sim_ok += 1
                    c.n_sim += 1
                    c.sum_sim_bps += simulated["netBps"]
            elif real_money and stage >= _EXEC:
                c.sim_tried += 1
                if stage >= _SUBMITTED:
                    c.sim_ok += 1
            if stage >= _SUBMITTED:
                c.submitted += 1
            if realized and realized.get("landed"):
                c.landed += 1
                c.n_real += 1
                c.sum_real_bps += realized["netBps"]
                c.realized_usd += realized["netUsd"]
                if realized["netUsd"] > 0:
                    c.profitable += 1
            if isinstance(total_ms, (int, float)) and not isinstance(total_ms, bool) and math.isfinite(total_ms):
                c.sum_latency_ms += total_ms
                c.n_latency += 1

    @staticmethod
    def _rate(s: float, n: float, gs: float, gn: float, prior: float) -> tuple[float, bool]:
        """Beta-posterior mean for successes/trials, shrunk toward the global rate (or a prior when there is none)."""
        if gn == 0:
            return prior, True
        m = (gs + 1) / (gn + 2)
        return (s + PRIOR_STRENGTH * m) / (n + PRIOR_STRENGTH), False

    def probabilities(self, symbol: str, route: str | None, mode: str, with_wallet: bool) -> Probabilities:
        g = self.global_
        tok = self.by_token.get(symbol) or Counts()
        rt = self.by_route.get(route) if route else None

        def blend(f) -> tuple[float, bool]:
            a = f(tok)
            # Blend in the route's own history once it has a few samples.
            if rt and rt.n >= 5:
                b = f(rt)
                return (a[0] + b[0]) / 2, a[1] and b[1]
            return a

        r = self._rate
        exe = blend(lambda c: r(c.executable, c.n, g.executable, g.n, 0.5))
        sim = blend(lambda c: r(c.sim_ok, c.sim_tried, g.sim_ok, g.sim_tried, self.priors.simulation))
        land = blend(lambda c: r(c.landed, c.submitted, g.landed, g.submitted, self.priors.landing))
        profit = blend(lambda c: r(c.profitable, c.landed, g.profitable, g.landed, self.priors.profit_given_landed))
        assumed: list[str] = []
        success = exe[0]
        if exe[1]:
            assumed.append("executable")
        if mode != "paper" or with_wallet:
            success *= sim[0]
            if sim[1]:
                assumed.append("simulation")
        if mode != "paper":
            success *= land[0] * profit[0]
            if land[1]:
                assumed.append("landing")
            if profit[1]:
                assumed.append("profit")
        return Probabilities(exe[0], sim[0], land[0], profit[0], success, assumed)

    @staticmethod
    def expected_value(net_usd: float, network_usd: float, p: Probabilities, mode: str, with_wallet: bool) -> float:
        """
        Expected value of an attempt. Paper: chance it holds x net. Real money:
        also landing and profit chances; a landed-but-failed trade costs its
        network fee, a dropped one costs nothing.
        """
        if mode == "paper":
            return (p.executable * p.simulation if with_wallet else p.executable) * net_usd
        reach = p.executable * p.simulation * p.landing
        return reach * (p.profit * net_usd - (1 - p.profit) * network_usd)

    def medianish_latency_ms(self, fallback: float = 1_500) -> float:
        """Typical time from market/quote to the last stage reached, ms."""
        g = self.global_
        return g.sum_latency_ms / g.n_latency if g.n_latency else fallback

    def table(self) -> list[dict]:
        """Per-token table: quoted vs executable vs simulated/realized edge and success rate."""
        rows = []
        for symbol, c in self.by_token.items():
            real_kind = "realized" if c.n_real else "simulated" if c.n_sim else "-"
            real_bps = c.sum_real_bps / c.n_real if c.n_real else c.sum_sim_bps / c.n_sim if c.n_sim else None
            if c.n_real:
                success = c.profitable / max(1, c.submitted)
            elif c.sim_tried:
                success = c.sim_ok / c.sim_tried
            else:
                success = c.executable / c.n
            rows.append({
                "symbol": symbol,
                "n": c.n,
                "quoted_bps": c.sum_quoted_bps / c.n,
                "exec_bps": c.sum_exec_bps / c.n_exec if c.n_exec else None,
                "real_bps": real_bps,
                "real_kind": real_kind,
                "success_pct": success * 100,
            })
        return sorted(rows, key=lambda x: -x["n"])


def score_opportunity(
    ev_usd: float,
    quote_age_ms: float,
    expected_latency_ms: float,
    price_impact_bps: float,
    max_impact_bps: float,
    discovered: bool,
) -> float:
    """
    Opportunity score for ranking: expected value, discounted for stale quotes,
    slow expected execution, high price impact and unproven (discovered)
    tokens. Negative EV stays negative so it is never chosen.
    """
    if ev_usd <= 0:
        return ev_usd
    fresh = 1 / (1 + quote_age_ms / 1_000)
    speed = 1 / (1 + expected_latency_ms / 2_000)
    impact = max(0, 1 - price_impact_bps / max_impact_bps) if max_impact_bps > 0 else 1
    known = 0.8 if discovered else 1
    return ev_usd * fresh * speed * impact * known
