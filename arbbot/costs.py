"""
Execution cost model. Jupiter's quoted output already includes DEX fees and
price impact for the quoted size. What the quote does NOT include, and this
model adds before every decision:
  - Solana base fee (one signature)
  - priority fee
  - Jito tip (only when sending through Jito): a share of the expected profit,
    clamped between a minimum and a maximum, never so high it eats the profit
  - a safety buffer for things we can't see (quote drift, rounding)
"""

from dataclasses import dataclass

from .profit import BASE_FEE_LAMPORTS, lamports_to_usd, usdc_atoms_to_usd


@dataclass
class CostSettings:
    priority_fee_lamports: int
    send_via: str
    #: Share of the room left after other costs offered to Jito as tip (0..1).
    tip_share: float
    min_tip_lamports: int
    max_tip_lamports: int
    safety_buffer_bps: float
    safety_buffer_usd: float

    @staticmethod
    def from_config(cfg) -> "CostSettings":
        return CostSettings(cfg.priority_fee_lamports, cfg.send_via, cfg.jito_tip_share, cfg.jito_tip_lamports,
                            cfg.jito_max_tip_lamports, cfg.safety_buffer_bps, cfg.safety_buffer_usd)


@dataclass
class Costs:
    base_fee_lamports: int
    priority_fee_lamports: int
    tip_lamports: int
    #: Paid in SOL when the transaction lands: base + priority + tip.
    network_usd: float
    tip_usd: float
    buffer_usd: float
    #: Everything the quote does not already include.
    total_usd: float


def estimate_costs(gross_usd: float, in_usd: float, sol_price_usd: float, s: CostSettings) -> Costs:
    base = lamports_to_usd(BASE_FEE_LAMPORTS, sol_price_usd)
    prio = lamports_to_usd(s.priority_fee_lamports, sol_price_usd)
    buffer = (in_usd * s.safety_buffer_bps) / 10_000 + s.safety_buffer_usd
    tip = 0
    if s.send_via == "jito":
        room = gross_usd - base - prio - buffer
        want = int((room * s.tip_share / sol_price_usd) * 1e9) if room > 0 and sol_price_usd > 0 else 0
        tip = min(s.max_tip_lamports, max(s.min_tip_lamports, want))
    tip_usd = lamports_to_usd(tip, sol_price_usd)
    network = base + prio + tip_usd
    return Costs(BASE_FEE_LAMPORTS, s.priority_fee_lamports, tip, network, tip_usd, buffer, network + buffer)


@dataclass
class Valuation:
    """Quoted gross vs what's left after every cost. "net" is an estimate, not profit."""

    in_usd: float
    out_usd: float
    gross_usd: float
    gross_bps: float
    costs: Costs
    net_usd: float
    net_bps: float


def _bps(x: float, in_usd: float) -> float:
    return (x / in_usd) * 10_000 if in_usd > 0 else 0.0


def value_cycle(c, sol_price_usd: float, s: CostSettings) -> Valuation:
    in_usd, out_usd = usdc_atoms_to_usd(c.in_atoms), usdc_atoms_to_usd(c.out_atoms)
    gross = out_usd - in_usd
    costs = estimate_costs(gross, in_usd, sol_price_usd, s)
    net = gross - costs.total_usd
    return Valuation(in_usd, out_usd, gross, _bps(gross, in_usd), costs, net, _bps(net, in_usd))


def revalue(c, costs: Costs) -> Valuation:
    """Re-values a cycle with fixed costs (the tip and buffer decided for this attempt)."""
    in_usd, out_usd = usdc_atoms_to_usd(c.in_atoms), usdc_atoms_to_usd(c.out_atoms)
    gross = out_usd - in_usd
    net = gross - costs.total_usd
    return Valuation(in_usd, out_usd, gross, _bps(gross, in_usd), costs, net, _bps(net, in_usd))
