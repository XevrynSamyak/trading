from dataclasses import dataclass
from typing import Awaitable, Callable

from .config import SOL_MINT, USDC_MINT
from .costs import CostSettings, Valuation, value_cycle
from .cycle import Cycle, CycleSpec, quote_cycle


@dataclass
class Scored:
    """A quoted cycle and what it's worth after every cost (an estimate, not profit)."""

    cycle: Cycle
    val: Valuation


async def scan_cycles(
    jup,
    specs: list[CycleSpec],
    size_for: Callable[[CycleSpec], int],
    sol_price_usd: float,
    costs: CostSettings,
    on_error: Callable[[CycleSpec, Exception], None] = lambda s, e: None,
    before_each: Callable[[CycleSpec], Awaitable[None]] | None = None,
    market_ts_for: Callable[[CycleSpec], int | None] | None = None,
    stop_after: Callable[[Scored], bool] | None = None,
) -> list[Scored]:
    """
    Quotes each cycle (at its own size) and values it after costs, one after
    another: each cycle's legs stay back-to-back and requests are spread out
    (`before_each` paces them). `stop_after` returning True skips the rest, so a
    gap is acted on while its quote is fresh. Results come back best-first by net
    USD; failed quotes are reported and skipped.
    """
    results: list[Scored] = []
    for spec in specs:
        try:
            if before_each:
                await before_each(spec)
            cycle = await quote_cycle(jup, spec, size_for(spec), market_ts=market_ts_for(spec) if market_ts_for else None)
            scored = Scored(cycle, value_cycle(cycle, sol_price_usd, costs))
            results.append(scored)
            if stop_after and stop_after(scored):
                break
        except Exception as err:  # noqa: BLE001 - reported to the caller, never fatal
            on_error(spec, err)
    return sorted(results, key=lambda s: s.val.net_usd, reverse=True)


async def fetch_sol_price_usd(jup, base_mint: str = USDC_MINT) -> float:
    """SOL's price in the base stablecoin (counted as dollars)."""
    q = await jup.quote(SOL_MINT, base_mint, 1_000_000_000, 50)
    return int(q["outAmount"]) / 1e6
