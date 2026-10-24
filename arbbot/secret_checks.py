"""
Startup checks for the most damaging setup mistakes. Messages never repeat
the secret itself.
 - a seed phrase anywhere in the settings
 - a SECRET key in the public-address slot (WALLET_PUBLIC_KEY)
 - a public address in the signing-key slot
 - a signing key that does not belong to WALLET_PUBLIC_KEY
 - a signing key present in paper mode (not needed there)
 - a .env file other users can read
"""

import os
import re
from dataclasses import dataclass, field

from .solana.base58 import b58decode
from .solana.keys import Keypair

_SEED_WORD_COUNTS = {12, 15, 18, 21, 24}
_WORD = re.compile(r"^[a-z]{3,8}$")


@dataclass
class SecretCheck:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def looks_like_seed_phrase(value: str) -> bool:
    words = value.strip().split()
    return len(words) in _SEED_WORD_COUNTS and all(_WORD.match(w) for w in words)


def _decoded_length(value: str) -> int | None:
    try:
        return len(b58decode(value.strip()))
    except ValueError:
        return None


def signing_key_from(env: dict) -> str | None:
    """The signing key, preferring the new name; WALLET_SECRET_KEY is the older name."""
    return (env.get("PRIVATE_SIGNING_KEY") or "").strip() or (env.get("WALLET_SECRET_KEY") or "").strip() or None


def check_secrets(env: dict, mode: str = "paper", env_file_path: str | None = None) -> SecretCheck:
    r = SecretCheck()
    for key, value in env.items():
        if isinstance(value, str) and looks_like_seed_phrase(value):
            r.errors.append(
                f"{key} looks like a SEED PHRASE. Delete it from .env now. The bot never needs a seed phrase; "
                "if it was ever shared or pasted anywhere, move your funds to a new wallet."
            )

    pub = (env.get("WALLET_PUBLIC_KEY") or "").strip()
    if pub:
        n = _decoded_length(pub)
        if n == 64:
            r.errors.append(
                "WALLET_PUBLIC_KEY holds a SECRET key. Remove it from .env now; put only the public address "
                "(about 44 characters) there."
            )
        elif n != 32:
            r.errors.append("WALLET_PUBLIC_KEY is not a valid Solana address (copy the public address from Phantom).")

    new, old = (env.get("PRIVATE_SIGNING_KEY") or "").strip(), (env.get("WALLET_SECRET_KEY") or "").strip()
    if new and old and new != old:
        r.errors.append("PRIVATE_SIGNING_KEY and WALLET_SECRET_KEY are both set and differ. Keep only PRIVATE_SIGNING_KEY.")

    signing = signing_key_from(env)
    if signing:
        n = _decoded_length(signing)
        if n == 32:
            r.errors.append(
                "The signing key setting holds a PUBLIC address, not a signing key. Public addresses belong in WALLET_PUBLIC_KEY."
            )
        elif n != 64:
            r.errors.append("The signing key is not a valid base58 Solana secret key.")
        else:
            try:
                derived = Keypair.from_base58(signing).public_key
            except ValueError:
                r.errors.append("The signing key is not a valid base58 Solana secret key.")
                derived = None
            if derived and pub and _decoded_length(pub) == 32 and derived != pub:
                r.errors.append("The signing key does not belong to WALLET_PUBLIC_KEY. They must be the same wallet.")
        if mode == "paper":
            r.warnings.append(
                "A signing key is set but paper mode never signs anything. It is safer to remove it from .env until you go MICRO."
            )

    if env_file_path and os.path.exists(env_file_path):
        if os.stat(env_file_path).st_mode & 0o077:
            r.warnings.append(f"{env_file_path} can be read by other users. Run: chmod 600 {env_file_path}")
    return r
