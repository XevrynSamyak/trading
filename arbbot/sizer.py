"""
Trade-size optimiser. Bigger trades earn more per gap but move the price
more, so profit vs. size usually rises, peaks, then falls:

  $100 -> +$1.40   $500 -> +$7.20   $1,000 -> +$12.30
  $1,500 -> +$15.20   $2,000 -> +$15.80   $3,000 -> +$12.40   -> choose $2,000

Each extra size costs a quote of every leg, so the ladder only runs on
candidates, with a capped number of points spread evenly in log space.
"""

import math
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from .util import js_str, to_fixed


def ladder_sizes(ladder: list[float], max_usd: float, min_usd: float, max_points: int, already: float | None = None) -> list[float]:
    """
    Sizes to evaluate: ladder points within limits plus the largest allowed
    (`max_usd`: wallet x exposure cap, MAX_TRADE_USD, MICRO cap, whichever is
    smallest), thinned to `max_points`.
    """
    top = math.floor(max_usd * 100) / 100
    if top < min_usd:
        return []
    cand = [x for x in ladder if min_usd <= x < top] + [top] + ([already] if already else [])
    all_ = sorted({x for x in cand if min_usd <= x <= top})
    if len(all_) <= max_points:
        return all_
    if max_points == 1:
        return [already if already is not None and already in all_ else top]
    # Priority: the largest allowed size, the size already quoted (free), the smallest;
    # then fill with the points nearest to targets evenly spaced in log space.
    keep: list[float] = []

    def add(x: float) -> None:
        if x not in keep:
            keep.append(x)

    for x in [all_[-1], *([already] if already is not None and already in all_ else []), all_[0]]:
        if len(keep) < max_points:
            add(x)
    lo, hi = math.log(all_[0]), math.log(all_[-1])

    def dist(x: float, target: float) -> float:
        return abs(math.log(x) - math.log(target))

    for i in range(1, max_points - 1):
        if len(keep) >= max_points:
            break
        target = math.exp(lo + (hi - lo) * i / (max_points - 1))
        remaining = [x for x in all_ if x not in keep]
        best = remaining[0]
        for x in remaining[1:]:
            if dist(x, target) < dist(best, target):
                best = x
        add(best)
    # Targets can collide; fill any gap with the point farthest (in log terms) from those kept.
    while len(keep) < max_points:
        remaining = [x for x in all_ if x not in keep]

        def gap(x: float) -> float:
            return min(abs(math.log(x) - math.log(k)) for k in keep)

        best = remaining[0]
        for x in remaining[1:]:
            if gap(x) > gap(best):
                best = x
        add(best)
    return sorted(keep)


@dataclass
class SizePoint:
    size_usd: float
    cycle: Any
    val: Any
    ev_usd: float
    impact_bps: float
    feasible: bool
    reason: str | None = None


def pick_best_size(points: list[SizePoint]) -> SizePoint | None:
    """The size with the highest expected value among feasible points (positive EV, impact within the limit)."""
    feasible = sorted((p for p in points if p.feasible), key=lambda p: -p.ev_usd)
    return feasible[0] if feasible else None


def make_point(cycle, val, ev_usd: float, max_impact_bps: float) -> SizePoint:
    if cycle.price_impact_bps > max_impact_bps:
        reason = f"price impact {to_fixed(cycle.price_impact_bps, 0)}bps > {js_str(max_impact_bps)}"
    elif ev_usd <= 0:
        reason = "no positive expected value"
    else:
        reason = None
    return SizePoint(val.in_usd, cycle, val, ev_usd, cycle.price_impact_bps, reason is None, reason)


async def evaluate_ladder(
    sizes: list[float],
    quote_at: Callable[[float], Awaitable[tuple[Any, Any]]],
    ev_of: Callable[[Any, Any], float],
    max_impact_bps: float,
    existing: tuple[Any, Any] | None = None,
    on_error: Callable[[float, Exception], None] = lambda size, err: None,
) -> list[SizePoint]:
    """
    Evaluates every size in `sizes` (reusing an existing (cycle, val) quote
    when its size matches) and returns all points, smallest first. Quote
    failures are skipped.
    """
    points: list[SizePoint] = []
    for size in sizes:
        try:
            if existing and abs(existing[1].in_usd - size) < 0.005:
                cycle, val = existing
            else:
                cycle, val = await quote_at(size)
            points.append(make_point(cycle, val, ev_of(cycle, val), max_impact_bps))
        except Exception as err:  # noqa: BLE001 - a failed size is skipped, the rest still count
            on_error(size, err)
    return points
