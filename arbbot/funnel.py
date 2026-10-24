"""
The opportunity funnel. Every candidate the bot acts on gets an ID and ONE
structured line in data/opps-<mode>.jsonl recording how far it got:

  quoted -> executable -> simulated -> submitted -> landed -> profitable

  quoted      the scan's quotes showed a gap above the bar (NOT profit)
  executable  every leg re-quoted moments later still cleared the floor
  simulated   the exact transaction simulated OK on the real chain
  submitted   a real transaction was sent (micro/live)
  landed      it landed on-chain
  profitable  it landed and the wallet gained after all fees

Records keep the TypeScript bot's camelCase JSON, so old files keep working.
"""

import json
import os
import re
from typing import Any

from .jsonl import JsonlReader, append_jsonl, read_jsonl
from .tail import tail_lines
from .util import iso, now_ms

STAGES = ["quoted", "executable", "simulated", "submitted", "landed", "profitable"]


def stage_of(result, real_money: bool) -> str:
    """Furthest funnel stage a result reached."""
    st = result.status
    if real_money:
        if st == "filled":
            return "profitable" if result.net_usd > 0 else "landed"
        if st == "failed":
            return "landed"
        if result.signature:
            return "submitted"  # sent but did not land / timed out
        if st == "rejected":
            return "executable"  # re-quote passed, simulation said no
        return "executable" if result.executable and st != "stale" else "quoted"
    if st == "filled" and result.verified:
        return "simulated"
    if st in ("filled", "rejected"):
        return "executable"
    return "quoted"  # stale or skipped before/at re-quote


def latencies(t: dict) -> dict:
    market = t.get("market")
    start = market if market is not None else t["quoteStart"]
    end = next(v for v in (t.get("landed"), t.get("submitted"), t.get("built"), t.get("requoteEnd"), t["decision"]) if v is not None)
    return _compact({
        "marketToQuoteMs": t["quoteEnd"] - market if market is not None else None,
        "quoteMs": t["quoteEnd"] - t["quoteStart"],
        "quoteToDecisionMs": t["decision"] - t["quoteEnd"],
        "decisionToSubmitMs": t["submitted"] - t["decision"] if t.get("submitted") is not None else None,
        "submitToLandingMs": t["landed"] - t["submitted"]
        if t.get("landed") is not None and t.get("submitted") is not None
        else None,
        "totalMs": end - start,
    })


def _compact(d: dict) -> dict:
    """Drops None values, the way JSON.stringify drops undefined ones."""
    return {k: v for k, v in d.items() if v is not None}


def _amt(v) -> dict:
    return {"netUsd": v.net_usd, "netBps": v.net_bps, "grossBps": v.gross_bps}


def build_opp_record(
    *,
    id: str,
    mode: str,
    cycle,
    val,
    result,
    decision_ts: int,
    expected: dict,
    sol_price_usd: float,
    detected=None,
    ladder: list[dict] | None = None,
    predicted: dict | None = None,
) -> dict:
    """
    Builds the funnel line for one acted-on candidate. `decision_ts` is when the
    bot decided to act (after ranking and the size ladder); `detected` is the
    scan quote that first showed the gap (default: `cycle`), since the ladder
    may re-quote later.
    """
    detected = detected or cycle
    real_money = mode != "paper"

    def bps_of(usd: float) -> float:
        return usd / val.in_usd * 10_000 if val.in_usd > 0 else 0

    rt = result.t
    t = _compact({
        "market": detected.market_ts,
        "quoteStart": detected.quote_started_at,
        "quoteEnd": detected.quoted_at,
        "decision": decision_ts,
        "requoteStart": rt.get("requoteStart"),
        "requoteEnd": rt.get("requoteEnd"),
        "built": rt.get("built"),
        "submitted": rt.get("submitted"),
        "landed": rt.get("landed"),
        "confirmed": rt.get("confirmed"),
    })

    def lamports_usd(l: float) -> float:
        return l / 1e9 * sol_price_usd

    if result.simulated_net_usd is not None:
        simulated = {"netUsd": result.simulated_net_usd, "netBps": bps_of(result.simulated_net_usd), "ok": True}
    elif result.verified and not real_money and result.status == "rejected":
        simulated = {"netUsd": 0, "netBps": 0, "ok": False}
    else:
        simulated = None
    landed = real_money and result.status in ("filled", "failed")
    realized = (
        _compact({"netUsd": result.net_usd, "netBps": bps_of(result.net_usd), "landed": landed, "signature": result.signature})
        if real_money and (landed or result.signature)
        else None
    )
    c = val.costs
    return _compact({
        "id": id,
        "ts": decision_ts,
        "mode": mode,
        "kind": cycle.kind,
        "symbol": cycle.symbol,
        "tokens": cycle.tokens,
        "route": cycle.routes,
        "sizeUsd": val.in_usd,
        "quoted": _amt(val),
        "executable": _amt(result.executable) if result.executable else None,
        "simulated": simulated,
        "realized": realized,
        "expected": expected,
        #: The gap predictor's view before acting: chance it holds at the re-check, and its size then.
        "predicted": predicted,
        "costs": {
            "baseFeeUsd": lamports_usd(c.base_fee_lamports),
            "priorityFeeUsd": lamports_usd(c.priority_fee_lamports),
            "tipUsd": c.tip_usd,
            "tipLamports": c.tip_lamports,
            "bufferUsd": c.buffer_usd,
            "totalUsd": c.total_usd,
            "dexFeeBps": cycle.dex_fee_bps,
            "priceImpactBps": cycle.price_impact_bps,
        },
        "ladder": ladder,
        "failedLeg": result.failed_leg,
        "stage": stage_of(result, real_money),
        "result": result.status,
        "reason": result.reason,
        "t": t,
        "lat": latencies(t),
    })


_ID = re.compile(r"^opp_(\d{8})_(\d+)$")


class Funnel:
    """Append-only funnel log with daily opportunity IDs: opp_YYYYMMDD_NNNNNN."""

    def __init__(self, path: str):
        self.path = path
        self._day = ""
        self._seq = 0
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        # Continue today's numbering after a restart.
        last = tail_lines(path, 1)
        if last:
            try:
                m = _ID.match(json.loads(last[0])["id"])
                if m:
                    self._day, self._seq = m.group(1), int(m.group(2))
            except (ValueError, KeyError, TypeError):
                pass  # torn last line: start a fresh sequence

    def next_id(self, now: int | None = None) -> str:
        day = iso(now_ms() if now is None else now)[:10].replace("-", "")
        if day != self._day:
            self._day, self._seq = day, 0
        self._seq += 1
        return f"opp_{day}_{self._seq:06d}"

    def record(self, r: dict) -> None:
        append_jsonl(self.path, r)

    @staticmethod
    def read(path: str) -> list[Any]:
        return read_jsonl(path)


#: Incremental reader for screens that refresh (`watch`).
FunnelReader = JsonlReader
