import math

USDC_DECIMALS = 6
USDC_UNIT = 10**USDC_DECIMALS
BASE_FEE_LAMPORTS = 5_000


def usd_to_usdc_atoms(usd: float) -> int:
    return math.floor(usd * USDC_UNIT + 0.5)  # JavaScript Math.round, not banker's rounding


def usdc_atoms_to_usd(atoms: int) -> float:
    return atoms / USDC_UNIT


def lamports_to_usd(lamports: float, sol_price_usd: float) -> float:
    return (lamports / 1e9) * sol_price_usd


def required_out_atoms(in_atoms: int, fee_usd: float, min_profit_bps: float) -> int:
    """
    Smallest USDC amount the last leg must return for the trade to clear fees
    plus the minimum profit. Enforced on-chain as that leg's slippage floor,
    so a trade that would lose money reverts instead of filling.
    """
    in_usd = usdc_atoms_to_usd(in_atoms)
    need = in_usd + fee_usd + (in_usd * min_profit_bps) / 10_000
    return math.ceil(need * USDC_UNIT)


def slippage_for_floor(quoted_out: int, required: int) -> int | None:
    """Slippage (bps) that makes the last leg's on-chain minimum equal `required`; None if not achievable."""
    if quoted_out < required:
        return None
    return ((quoted_out - required) * 10_000) // quoted_out
