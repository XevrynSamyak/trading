"""Wallet balances (SOL, the base stablecoin, token-account deposits) with a short cache."""

import time
from dataclasses import dataclass

from .config import STABLE_MINTS, USDC_MINT
from .solana.keys import TOKEN_PROGRAM_ID, Keypair, associated_token_address
from .solana.rpc import Rpc


def load_keypair(base58_secret: str) -> Keypair:
    return Keypair.from_base58(base58_secret)


@dataclass
class Balances:
    lamports: int
    #: The base stablecoin (what the bot trades with), in its smallest units.
    base_atoms: int
    #: SOL held as refundable deposits ("rent") in the wallet's token accounts. Each new
    #: token the bot trades opens one (~0.002 SOL). It is still the owner's money.
    rent_lamports: int
    #: The other dollar stablecoin (USDT when trading USDC, and the reverse): not traded,
    #: but counted in the wallet's value, so switching BASE_TOKEN never looks like a loss.
    other_stable_atoms: int = 0


async def get_balances(rpc: Rpc, owner: str, base_mint: str = USDC_MINT) -> Balances:
    lamports = await rpc.get_balance(owner)
    accounts = await rpc.get_parsed_token_accounts_by_owner(owner, TOKEN_PROGRAM_ID)
    base, other, rent = 0, 0, 0
    for acc in accounts:
        rent += acc["account"]["lamports"]
        info = acc["account"]["data"]["parsed"]["info"]
        if info["mint"] == base_mint:
            base += int(info["tokenAmount"]["amount"])
        elif info["mint"] in STABLE_MINTS:
            other += int(info["tokenAmount"]["amount"])
    return Balances(lamports, base, rent, other)


def wallet_value_usd(b: Balances, sol_price_usd: float) -> float:
    return (b.base_atoms + b.other_stable_atoms) / 1e6 + ((b.lamports + b.rent_lamports) / 1e9) * sol_price_usd


def base_ata(owner: str, base_mint: str = USDC_MINT) -> str:
    """The wallet's standard token account (associated token account) for the base stablecoin."""
    return associated_token_address(owner, base_mint)


def token_amount_from_data(data: bytes) -> int:
    """The amount (u64 at byte 64) in raw SPL token account data."""
    if len(data) < 72:
        raise ValueError(f"not a token account ({len(data)} bytes)")
    return int.from_bytes(data[64:72], "little")


class BalanceCache:
    """
    Reads balances at most once per `max_age_ms` (default 1 minute) to save RPC
    credits. Call invalidate() after anything that moves money.
    """

    def __init__(self, rpc: Rpc, owner: str, max_age_ms: int = 60_000, base_mint: str = USDC_MINT):
        self.rpc, self.owner, self.max_age_ms, self.base_mint = rpc, owner, max_age_ms, base_mint
        self._cached: tuple[Balances, float] | None = None

    async def get(self, now: float | None = None) -> Balances:
        now = time.time() * 1000 if now is None else now
        if self._cached is None or now - self._cached[1] >= self.max_age_ms:
            self._cached = (await get_balances(self.rpc, self.owner, self.base_mint), now)
        return self._cached[0]

    def invalidate(self) -> None:
        self._cached = None
