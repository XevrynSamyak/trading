"""
The go-live gate. Paper profits are never evidence:

 MICRO (tiny real trades) is recommended only after enough trades were
 simulated ON-CHAIN, enough of them succeeded, and they made money on average
 after every cost.

 LIVE (adaptive size) is ALLOWED only after enough MICRO trades landed, most
 were profitable, realized P&L is positive, and nothing unexpected happened.
 The bot refuses to start LIVE otherwise.
"""

import os
from dataclasses import dataclass, field
from typing import Callable

from .atomic import read_json_with_backup
from .funnel import Funnel
from .killswitch import halted, trading_disabled
from .util import js_str, now_ms, to_fixed


@dataclass
class GateThresholds:
    min_paper_days: float
    min_simulated: int
    min_sim_success_rate: float
    micro_min_trades: int
    micro_min_profitable_rate: float

    @staticmethod
    def from_config(cfg) -> "GateThresholds":
        return GateThresholds(cfg.gate_min_paper_days, cfg.gate_min_simulated, cfg.gate_min_sim_success_rate,
                              cfg.gate_micro_min_trades, cfg.gate_micro_min_profitable_rate)


@dataclass
class GateInput:
    paper: list[dict]
    micro: list[dict]
    paper_days: float
    kill_switch: str | None = None
    halted: str | None = None


@dataclass
class GateResult:
    ok: bool
    reasons: list[str] = field(default_factory=list)


@dataclass
class Verdict:
    micro: GateResult
    live: GateResult


def _pct(x: float) -> str:
    return f"{to_fixed(x * 100, 0)}%"


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0


def go_live_verdict(i: GateInput, t: GateThresholds) -> Verdict:
    blockers: list[str] = []
    if i.kill_switch:
        blockers.append(f"trading is disabled: {i.kill_switch}")
    if i.halted:
        blockers.append(f"the bot is halted: {i.halted}")

    micro = list(blockers)
    sims = [r for r in i.paper if r.get("simulated")]
    ok = [r for r in sims if r["simulated"].get("ok")]
    if not sims:
        micro.append(
            "no trades simulated on-chain yet (paper mode does this when WALLET_PUBLIC_KEY is a funded wallet "
            "and a gap is worth testing)"
        )
    else:
        if len(sims) < t.min_simulated:
            micro.append(f"only {len(sims)} trades simulated on-chain (need {js_str(t.min_simulated)})")
        rate = len(ok) / len(sims)
        if rate < t.min_sim_success_rate:
            micro.append(f"only {_pct(rate)} of simulated trades succeeded (need {_pct(t.min_sim_success_rate)})")
        avg = _mean([r["simulated"]["netBps"] for r in ok])
        if ok and avg <= 0:
            micro.append(f"simulated trades lose money on average after costs ({to_fixed(avg, 1)}bps)")
        if not ok:
            micro.append("no simulated trade succeeded")
    if i.paper_days < t.min_paper_days:
        micro.append(f"only {to_fixed(i.paper_days, 1)} days of paper data (need {js_str(t.min_paper_days)})")

    live = list(blockers)
    landed = [r for r in i.micro if (r.get("realized") or {}).get("landed")]
    profitable = [r for r in landed if r["realized"]["netUsd"] > 0]
    pnl = sum(r["realized"]["netUsd"] for r in landed)
    timeouts = sum(1 for r in i.micro if r.get("result") == "timeout")
    if len(landed) < t.micro_min_trades:
        live.append(f"Insufficient real execution sample: {len(landed)} MICRO trades landed (need {js_str(t.micro_min_trades)})")
    if landed:
        rate = len(profitable) / len(landed)
        if rate < t.micro_min_profitable_rate:
            live.append(f"only {_pct(rate)} of MICRO trades were profitable (need {_pct(t.micro_min_profitable_rate)})")
        if pnl <= 0:
            live.append(f"MICRO realized P&L is ${to_fixed(pnl, 4)} (must be positive)")
    if timeouts:
        live.append(f"{timeouts} MICRO trade(s) had an unconfirmed landing")

    return Verdict(GateResult(not micro, micro), GateResult(not live, live))


DAY_MS = 86_400_000


def load_gate_input(data_dir: str, now: float | None = None, read: Callable[[str], list[dict]] = Funnel.read) -> GateInput:
    """
    Everything the gate looks at, read from the data folder: the paper and
    MICRO funnels, how long paper testing has run, the kill switch and halt.
    `read` lets a refreshing screen pass a cached reader.
    """
    now = now_ms() if now is None else now
    paper = read(os.path.join(data_dir, "opps-paper.jsonl"))
    micro = read(os.path.join(data_dir, "opps-micro.jsonl"))
    brain = read_json_with_backup(os.path.join(data_dir, "brain-paper.json"))
    started = brain[0].get("startedAt") if brain and isinstance(brain[0], dict) else None
    start = started if started is not None else (paper[0].get("ts") if paper else None)
    return GateInput(
        paper=paper,
        micro=micro,
        paper_days=max(0, (now - start) / DAY_MS) if start else 0,
        kill_switch=trading_disabled(data_dir),
        halted=halted(data_dir),
    )
