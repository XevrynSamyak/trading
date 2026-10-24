"""Addresses, key pairs and program-derived addresses."""

import hashlib

from . import ed25519
from .base58 import b58decode, b58encode

TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
SYSTEM_PROGRAM_ID = "11111111111111111111111111111111"
COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111"


def pubkey_bytes(address: str) -> bytes:
    """32 bytes of a base58 address; raises ValueError if it isn't one."""
    raw = b58decode(address)
    if len(raw) != 32:
        raise ValueError(f"Invalid public key input: {address[:12]}…")
    return raw


def is_valid_address(address: str) -> bool:
    try:
        pubkey_bytes(address)
        return True
    except ValueError:
        return False


class Keypair:
    """A signing key pair from a 64-byte secret key (seed + public key), as Phantom exports it."""

    def __init__(self, secret_key: bytes):
        if len(secret_key) != 64:
            raise ValueError("bad secret key size")
        seed, pub = secret_key[:32], secret_key[32:]
        if ed25519.public_key(seed) != pub:
            raise ValueError("provided secretKey is invalid")
        self._seed = seed
        self.public_key = b58encode(pub)

    @classmethod
    def from_base58(cls, secret: str) -> "Keypair":
        return cls(b58decode(secret.strip()))

    @classmethod
    def generate(cls) -> "Keypair":
        import os

        seed = os.urandom(32)
        return cls(seed + ed25519.public_key(seed))

    def secret_base58(self) -> str:
        return b58encode(self._seed + pubkey_bytes(self.public_key))

    def sign(self, message: bytes) -> bytes:
        return ed25519.sign(self._seed, message)


def find_program_address(seeds: list[bytes], program_id: str) -> tuple[str, int]:
    pid = pubkey_bytes(program_id)
    for bump in range(255, -1, -1):
        h = hashlib.sha256(b"".join(seeds) + bytes([bump]) + pid + b"ProgramDerivedAddress").digest()
        if not ed25519.is_on_curve(h):
            return b58encode(h), bump
    raise ValueError("Unable to find a viable program address bump seed")


def associated_token_address(owner: str, mint: str) -> str:
    addr, _ = find_program_address(
        [pubkey_bytes(owner), pubkey_bytes(TOKEN_PROGRAM_ID), pubkey_bytes(mint)], ASSOCIATED_TOKEN_PROGRAM_ID
    )
    return addr
