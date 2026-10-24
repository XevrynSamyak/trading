"""
Trade log (data/trades-<mode>.jsonl). Every amount has a basis; only
"simulated" and "realized" are evidence, "quoted" is what a price quote
promised and is NEVER profit.
 - quoted:    from Jupiter quotes only (paper mode without on-chain testing)
 - simulated: the exact transaction simulated on the real chain (paper, nothing sent)
 - realized:  a real transaction landed and the wallet balance changed (micro/live)
Records use the same JSON fields as before (camelCase), so old files keep working.
"""

import os
from typing import Iterable

from .jsonl import append_jsonl, read_jsonl

BASES = ("quoted", "simulated", "realized")


def basis_of(r: dict) -> str:
    """The basis of a record; older records without the field are inferred."""
    if r.get("basis"):
        return r["basis"]
    if r.get("mode") in ("live", "micro"):
        return "realized"
    return "simulated" if r.get("verified") else "quoted"


def money_basis(mode: str) -> str:
    """Which basis counts as money in each mode (quoted never does)."""
    return "simulated" if mode == "paper" else "realized"


class Ledger:
    """Append-only trade log, read once and then kept in memory."""

    def __init__(self, path: str):
        self.path = path
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self._cache: list[dict] | None = None

    def append(self, rec: dict) -> None:
        append_jsonl(self.path, {k: v for k, v in rec.items() if v is not None})
        if self._cache is not None:
            self._cache.append(rec)

    def all(self) -> list[dict]:
        if self._cache is None:
            self._cache = read_jsonl(self.path)
        return self._cache

    @staticmethod
    def read(path: str) -> list[dict]:
        return read_jsonl(path)

    def pnl_between(self, from_ts: int, to_ts: float = float("inf"), records: list[dict] | None = None,
                    bases: Iterable[str] | None = None) -> float:
        """Net P&L in [from_ts, to_ts), optionally only for the given bases."""
        recs = self.all() if records is None else records
        bs = set(bases) if bases is not None else None
        return sum(r["netUsd"] for r in recs if from_ts <= r["ts"] < to_ts and (bs is None or basis_of(r) in bs))


def totals_by_basis(records: list[dict], since_ts: int = 0) -> dict[str, dict]:
    """Totals per basis, for screens that must never mix quoted with real numbers."""
    out = {b: {"count": 0, "wins": 0, "netUsd": 0.0} for b in BASES}
    for r in records:
        if r["ts"] < since_ts or r.get("status") == "skipped":
            continue
        t = out[basis_of(r)]
        t["count"] += 1
        if r.get("status") == "filled" and r["netUsd"] > 0:
            t["wins"] += 1
        t["netUsd"] += r["netUsd"]
    return out
