"""
Triangular cycles through a liquid pivot (SOL by default):
  USDC -> SOL -> X -> USDC   and   USDC -> X -> SOL -> USDC
They catch an X/SOL price out of line with X/USDC and SOL/USDC. Jupiter's
router already mixes such paths into single legs, so explicit triangles mostly
matter when the best route for each leg alone is not the best cycle. Each
costs 3 quotes, so only a few run per scan, in turn.
"""

from .cycle import CycleSpec, triangle_spec


def triangle_specs(tokens: dict[str, str], pivot: str) -> list[CycleSpec]:
    pivot_mint = tokens.get(pivot)
    if not pivot_mint:
        return []
    out = []
    for sym, mint in tokens.items():
        if sym == pivot or mint == pivot_mint:
            continue
        out += [triangle_spec((pivot, pivot_mint), (sym, mint)), triangle_spec((sym, mint), (pivot, pivot_mint))]
    return out


class Rotation:
    """Hands out items a few at a time, in turn, even as the list changes."""

    def __init__(self):
        self._next = 0

    def take(self, items: list, n: int) -> list:
        if not items or n <= 0:
            return []
        out = [items[(self._next + i) % len(items)] for i in range(min(n, len(items)))]
        self._next = (self._next + len(out)) % len(items)
        return out
