"""Wallet balances (SOL, USDC, token-account deposits) with a short cache."""

import time
from dataclasses import dataclass

from .config import USDC_MINT
from .solana.keys import TOKEN_PROGRAM_ID, Keypair, associated_token_address
from .solana.rpc import Rpc


def load_keypair(base58_secret: str) -> Keypair:
    return Keypair.from_base58(base58_secret)


@dataclass
class Balances:
    lamports: int
    usdc_atoms: int
    #: SOL held as refundable deposits ("rent") in the wallet's token accounts. Each new
    #: token the bot trades opens one (~0.002 SOL). It is still the owner's money.
    rent_lamports: int


async def get_balances(rpc: Rpc, owner: str) -> Balances:
    lamports = await rpc.get_balance(owner)
    accounts = await rpc.get_parsed_token_accounts_by_owner(owner, TOKEN_PROGRAM_ID)
    usdc, rent = 0, 0
    for acc in accounts:
        rent += acc["account"]["lamports"]
        info = acc["account"]["data"]["parsed"]["info"]
        if info["mint"] == USDC_MINT:
            usdc += int(info["tokenAmount"]["amount"])
    return Balances(lamports, usdc, rent)


def wallet_value_usd(b: Balances, sol_price_usd: float) -> float:
    return b.usdc_atoms / 1e6 + ((b.lamports + b.rent_lamports) / 1e9) * sol_price_usd


def usdc_ata(owner: str) -> str:
    """The wallet's standard USDC token account (associated token account)."""
    return associated_token_address(owner, USDC_MINT)


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

    def __init__(self, rpc: Rpc, owner: str, max_age_ms: int = 60_000):
        self.rpc, self.owner, self.max_age_ms = rpc, owner, max_age_ms
        self._cached: tuple[Balances, float] | None = None

    async def get(self, now: float | None = None) -> Balances:
        now = time.time() * 1000 if now is None else now
        if self._cached is None or now - self._cached[1] >= self.max_age_ms:
            self._cached = (await get_balances(self.rpc, self.owner), now)
        return self._cached[0]

    def invalidate(self) -> None:
        self._cached = None
