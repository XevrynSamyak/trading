"""Base58 (Bitcoin alphabet), as Solana uses for addresses, keys and signatures."""

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_INDEX = {c: i for i, c in enumerate(ALPHABET)}


def b58encode(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    out = []
    while n:
        n, r = divmod(n, 58)
        out.append(ALPHABET[r])
    zeros = len(data) - len(data.lstrip(b"\0"))
    return "1" * zeros + "".join(reversed(out))


def b58decode(text: str) -> bytes:
    n = 0
    for c in text:
        if c not in _INDEX:
            raise ValueError("Non-base58 character")
        n = n * 58 + _INDEX[c]
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    zeros = len(text) - len(text.lstrip("1"))
    return b"\0" * zeros + body
