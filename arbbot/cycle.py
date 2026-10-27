"""
An arbitrage cycle: start in the base stablecoin (USDC, or USDT with
BASE_TOKEN=USDT), trade through one or more tokens, end in the base, all legs
in ONE atomic transaction.
  two-leg:  USDC -> X -> USDC
  triangle: USDC -> A -> B -> USDC
Jupiter picks the best venue mix (Raydium, Orca, Meteora, ...) for each leg,
so cross-venue gaps show up as legs routed through different venues.
"""

import time
from dataclasses import dataclass, field, replace

from .config import USDC_MINT

#: Account budget for all legs in one v0 transaction (lookup tables make room).
TX_ACCOUNT_BUDGET = 56


def max_accounts_per_leg(legs: int) -> int:
    return TX_ACCOUNT_BUDGET // legs


@dataclass
class CycleSpec:
    kind: str  # "two-leg" | "triangle"
    #: Display/learning key: "JUP" or "SOL>JUP".
    symbol: str
    #: Token symbols passed through (for safety checks).
    tokens: list[str]
    #: Mints including start and end: [USDC, X, USDC] or [USDC, A, B, USDC].
    path: list[str]


@dataclass
class Cycle(CycleSpec):
    in_atoms: int = 0
    legs: list[dict] = field(default_factory=list)
    out_atoms: int = 0
    quote_started_at: int = 0
    quoted_at: int = 0
    #: Venue labels per leg, e.g. "Raydium>Orca | Meteora".
    routes: str = ""
    #: Price impact Jupiter reports, summed over legs (bps; treats priceImpactPct as a fraction).
    price_impact_bps: float = 0.0
    #: DEX fees charged along the route (bps). Already inside the quoted output.
    dex_fee_bps: float = 0.0
    #: Pool accounts the route uses (watched for changes by the event trigger).
    pools: list[str] = field(default_factory=list)
    #: When the market change that prompted this quote happened, if known.
    market_ts: int | None = None


def two_leg_spec(symbol: str, mint: str, base: str = USDC_MINT) -> CycleSpec:
    return CycleSpec("two-leg", symbol, [symbol], [base, mint, base])


def triangle_spec(a: tuple[str, str], b: tuple[str, str], base: str = USDC_MINT) -> CycleSpec:
    return CycleSpec("triangle", f"{a[0]}>{b[0]}", [a[0], b[0]], [base, a[1], b[1], base])


def spec_of(c: CycleSpec) -> CycleSpec:
    return CycleSpec(c.kind, c.symbol, list(c.tokens), list(c.path))


def _route_label(q: dict) -> str:
    return ">".join((step.get("swapInfo") or {}).get("label") or "?" for step in q.get("routePlan") or [])


def _num(x) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def leg_fee_bps(q: dict) -> float:
    """DEX fee of one leg in bps, from the fee each hop reports (weighted by split percent)."""
    bps = 0.0
    for step in q.get("routePlan") or []:
        s = step.get("swapInfo") or {}
        fee = _num(s.get("feeAmount"))
        if not fee:
            continue
        base = _num(s.get("inAmount")) if s.get("feeMint") == s.get("inputMint") else _num(s.get("outAmount")) + fee
        if base > 0:
            bps += (fee / base) * 10_000 * ((step.get("percent") if step.get("percent") is not None else 100) / 100)
    return bps


def _now_ms() -> int:
    return int(time.time() * 1000)


async def quote_cycle(jup, spec: CycleSpec, in_atoms: int, last_leg_slippage_bps: int | None = None,
                      market_ts: int | None = None, now=_now_ms) -> Cycle:
    """
    Quotes every leg back-to-back: each leg sells exactly what the previous one
    bought. Legs quote with 0 slippage except, optionally, the last one, whose
    slippage sets the on-chain minimum output (the profit floor).
    """
    started = now()
    legs: list[dict] = []
    amount = in_atoms
    n = len(spec.path) - 1
    for i in range(n):
        last = i == n - 1
        q = await jup.quote(spec.path[i], spec.path[i + 1], amount, (last_leg_slippage_bps or 0) if last else 0,
                            max_accounts=max_accounts_per_leg(n))
        legs.append(q)
        amount = int(q["outAmount"])
    pools: list[str] = []
    for q in legs:
        for step in q.get("routePlan") or []:
            k = (step.get("swapInfo") or {}).get("ammKey")
            if k and k not in pools:
                pools.append(k)
    return Cycle(
        spec.kind, spec.symbol, list(spec.tokens), list(spec.path),
        in_atoms=in_atoms,
        legs=legs,
        out_atoms=amount,
        quote_started_at=started,
        quoted_at=now(),
        routes=" | ".join(_route_label(q) for q in legs),
        price_impact_bps=sum(abs(_num(q.get("priceImpactPct"))) * 10_000 for q in legs),
        dex_fee_bps=sum(leg_fee_bps(q) for q in legs),
        pools=pools,
        market_ts=market_ts,
    )


__all__ = ["Cycle", "CycleSpec", "quote_cycle", "two_leg_spec", "triangle_spec", "spec_of", "leg_fee_bps",
           "max_accounts_per_leg", "replace"]
