"""
Ed25519 (RFC 8032) in pure Python: public keys, signatures, and the
"is this point on the curve" test that program-derived addresses need.
Slow compared with native code (a few milliseconds per signature), which is
plenty for a bot that signs at most a few transactions a minute.
"""

import hashlib

P = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
D = (-121665 * pow(121666, P - 2, P)) % P
SQRT_M1 = pow(2, (P - 1) // 4, P)


def _recover_x(y: int, sign: int):
    if y >= P:
        return None
    x2 = (y * y - 1) * pow(D * y * y + 1, P - 2, P) % P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (P + 3) // 8, P)
    if (x * x - x2) % P:
        x = x * SQRT_M1 % P
    if (x * x - x2) % P:
        return None
    if (x & 1) != sign:
        x = P - x
    return x


_GY = 4 * pow(5, P - 2, P) % P
_GX = _recover_x(_GY, 0)
G = (_GX, _GY, 1, _GX * _GY % P)
_ZERO = (0, 1, 1, 0)


def _add(p, q):
    a = (p[1] - p[0]) * (q[1] - q[0]) % P
    b = (p[1] + p[0]) * (q[1] + q[0]) % P
    c = 2 * p[3] * q[3] * D % P
    d = 2 * p[2] * q[2] % P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % P, g * h % P, f * g % P, e * h % P)


def _mul(s: int, p):
    q = _ZERO
    while s:
        if s & 1:
            q = _add(q, p)
        p = _add(p, p)
        s >>= 1
    return q


def _equal(p, q) -> bool:
    return (p[0] * q[2] - q[0] * p[2]) % P == 0 and (p[1] * q[2] - q[1] * p[2]) % P == 0


def _compress(p) -> bytes:
    zinv = pow(p[2], P - 2, P)
    x, y = p[0] * zinv % P, p[1] * zinv % P
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def _decompress(s: bytes):
    if len(s) != 32:
        return None
    y = int.from_bytes(s, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, x * y % P)


def is_on_curve(point: bytes) -> bool:
    """True if the 32 bytes are a valid Ed25519 point (program addresses must NOT be)."""
    return _decompress(point) is not None


def _sha512_int(data: bytes) -> int:
    return int.from_bytes(hashlib.sha512(data).digest(), "little")


def _expand(seed: bytes):
    if len(seed) != 32:
        raise ValueError("Ed25519 seed must be 32 bytes")
    h = hashlib.sha512(seed).digest()
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    return a, h[32:]


def public_key(seed: bytes) -> bytes:
    a, _ = _expand(seed)
    return _compress(_mul(a, G))


def sign(seed: bytes, message: bytes) -> bytes:
    a, prefix = _expand(seed)
    pub = _compress(_mul(a, G))
    r = _sha512_int(prefix + message) % L
    rs = _compress(_mul(r, G))
    h = _sha512_int(rs + pub + message) % L
    s = (r + h * a) % L
    return rs + s.to_bytes(32, "little")


def verify(pub: bytes, message: bytes, signature: bytes) -> bool:
    if len(signature) != 64:
        return False
    a = _decompress(pub)
    r = _decompress(signature[:32])
    if a is None or r is None:
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= L:
        return False
    h = _sha512_int(signature[:32] + pub + message) % L
    return _equal(_mul(s, G), _add(r, _mul(h, a)))
