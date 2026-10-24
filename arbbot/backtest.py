"""
`backtest`: replays the recorded opportunities (data/opps-*.jsonl) under
other settings, to see which rules would have done better.

It can only judge candidates the bot actually acted on. A stricter rule is a
subset of what happened, so its result is known; a looser rule would need
quotes nobody re-checked, so it cannot be judged here (paper mode is how to
find out). Money is realized (real trades) when there are any, otherwise
simulated on-chain; quote-only amounts are shown apart and are never profit.
"""

import os
import sys
from dataclasses import dataclass
from typing import Callable

from .funnel import STAGES, Funnel
from .probes import ProbeLog, gap_bucket, held
from .util import js_str, to_fixed


@dataclass
class Outcome:
    acted: int
    #: Still there at the fresh re-quote.
    executable: int
    simulated_ok: int
    landed: int
    profitable: int
    money_usd: float
    money_basis: str  # "realized" | "simulated" | "none"
    #: Sum of quoted net amounts at decision time: NOT profit.
    quoted_usd: float


def _reached(r: dict, stage: str) -> bool:
    return r.get("stage") in STAGES and STAGES.index(r["stage"]) >= STAGES.index(stage)


def outcome_of(opps: list[dict]) -> Outcome:
    landed = [r for r in opps if (r.get("realized") or {}).get("landed")]
    sims = [r for r in opps if (r.get("simulated") or {}).get("ok")]
    basis = "realized" if landed else "simulated" if sims else "none"
    if basis == "realized":
        money = sum(r["realized"]["netUsd"] for r in landed)
    elif basis == "simulated":
        money = sum(r["simulated"]["netUsd"] for r in sims)
    else:
        money = 0
    return Outcome(
        acted=len(opps),
        executable=sum(1 for r in opps if _reached(r, "executable")),
        simulated_ok=len(sims),
        landed=len(landed),
        profitable=sum(1 for r in landed if r["realized"]["netUsd"] > 0),
        money_usd=money,
        money_basis=basis,
        quoted_usd=sum(r["quoted"]["netUsd"] for r in opps),
    )


@dataclass
class Scenario:
    name: str
    keep: Callable[[dict], bool]


def _evidence_usd(r: dict) -> float | None:
    """Value used to judge a token: realized if it has real trades, else simulated, else nothing."""
    if (r.get("realized") or {}).get("landed"):
        return r["realized"]["netUsd"]
    if r.get("simulated"):
        return r["simulated"]["netUsd"] if r["simulated"].get("ok") else 0
    return None


def scenarios(opps: list[dict]) -> list[Scenario]:
    out = [Scenario("as recorded", lambda r: True)]
    for bps in (30, 50, 100):
        out.append(Scenario(f"quoted net >= {bps}bps", lambda r, bps=bps: r["quoted"]["netBps"] >= bps))
    for usd in (0.005, 0.02):
        out.append(Scenario(f"expected value >= ${js_str(usd)}", lambda r, usd=usd: r["expected"]["evUsd"] >= usd))
    for bps in (10, 30):
        out.append(Scenario(f"price impact <= {bps}bps", lambda r, bps=bps: r["costs"]["priceImpactBps"] <= bps))
    out.append(Scenario("quote <= 500ms old at decision", lambda r: r["lat"]["quoteToDecisionMs"] <= 500))
    kinds = list(dict.fromkeys(r.get("kind") for r in opps))
    if len(kinds) > 1:
        for k in kinds:
            out.append(Scenario(f"{k} only", lambda r, k=k: r.get("kind") == k))
    evented = any(r["t"].get("market") is not None for r in opps)
    polled = any(r["t"].get("market") is None for r in opps)
    if evented and polled:
        out.append(Scenario("event-triggered only", lambda r: r["t"].get("market") is not None))
        out.append(Scenario("polled only", lambda r: r["t"].get("market") is None))
    # Leave out the token with the worst evidence (needs on-chain results to judge).
    by_token: dict[str, float] = {}
    for r in opps:
        v = _evidence_usd(r)
        if v is not None:
            by_token[r["symbol"]] = by_token.get(r["symbol"], 0) + v
    if len(by_token) > 1:
        worst = sorted(by_token.items(), key=lambda x: x[1])[0]
        if worst[1] < 0:
            out.append(Scenario(f"without {worst[0]}", lambda r, w=worst[0]: r["symbol"] != w))
    return out


_AGE_EDGES = [250, 500, 1_000, 2_000, 5_000]


def _age_label(ms: float) -> str:
    i = next((k for k, e in enumerate(_AGE_EDGES) if ms < e), -1)
    if i == -1:
        return f">= {_AGE_EDGES[-1]} ms"
    return f"< {_AGE_EDGES[0]} ms" if i == 0 else f"{_AGE_EDGES[i - 1]}-{_AGE_EDGES[i]} ms"


def survival_by_age(opps: list[dict]) -> list[dict]:
    """How fast gaps die: share still there at the fresh re-quote, by how old the scan quote was then."""
    order = [f"< {_AGE_EDGES[0]} ms"] + [f"{_AGE_EDGES[k]}-{e} ms" for k, e in enumerate(_AGE_EDGES[1:])] + [f">= {_AGE_EDGES[-1]} ms"]
    rows = {b: {"bucket": b, "n": 0, "still_there": 0} for b in order}
    for r in opps:
        if r["t"].get("requoteEnd") is None:
            continue
        row = rows[_age_label(r["t"]["requoteEnd"] - r["t"]["quoteEnd"])]
        row["n"] += 1
        if _reached(r, "executable"):
            row["still_there"] += 1
    return [rows[b] for b in order if rows[b]["n"] > 0]


def size_policies(opps: list[dict]) -> list[dict]:
    """Sizes the ladder compared (quoted at decision time only; not profit)."""
    with_ladder = [r for r in opps if len(r.get("ladder") or []) > 1]
    if not with_ladder:
        return []
    n = len(with_ladder)
    return [
        {"name": "size the ladder chose", "n": n, "quoted_usd": sum(r["quoted"]["netUsd"] for r in with_ladder)},
        {"name": "always the smallest size", "n": n, "quoted_usd": sum(r["ladder"][0]["netUsd"] for r in with_ladder)},
        {"name": "always the largest size", "n": n, "quoted_usd": sum(r["ladder"][-1]["netUsd"] for r in with_ladder)},
    ]


def _usd(n: float) -> str:
    return f"{'+' if n >= 0 else '-'}${to_fixed(abs(n), 4)}"


def _pct(a: float, b: float) -> str:
    return f"{to_fixed(a / b * 100, 0)}%" if b else "n/a"


def render_backtest(opps: list[dict], probes: list[dict] | None = None) -> str:
    probes = probes or []
    out = [f"Backtest over {len(opps)} recorded opportunities (what the bot actually acted on)."]
    if probes:
        out.append("")
        out.append(f"Gaps below the bar, re-checked by probes ({len(probes)}; learning only, nothing traded):")
        buckets: dict[str, dict] = {}
        for p in probes:
            b = buckets.setdefault(gap_bucket(p["quotedBps"]), {"n": 0, "held": 0})
            b["n"] += 1
            if held(p):
                b["held"] += 1
        for b, t in buckets.items():
            out.append(f"  quoted {b.ljust(8)} bps: {_pct(t['held'], t['n']).rjust(4)} still there  (n={t['n']})")
        out.append("  A lower bar only helps where small gaps are still there at the re-check.")
        out.append("")
    if not opps:
        out.append("Nothing recorded yet: let the bot run in paper mode first.")
        return "\n".join(out)
    base = outcome_of(opps)
    out.append(
        "No on-chain results yet (quote-only paper mode): only 'still there at re-quote' can be compared. "
        "Set WALLET_PUBLIC_KEY for simulated results."
        if base.money_basis == "none"
        else f"Money column: {base.money_basis} results only. Quoted amounts are shown apart and are not profit."
    )
    out.append("")
    out.append("Rule                               acted  still there  sim OK  landed  money            quoted (NOT profit)")
    for sc in scenarios(opps):
        o = outcome_of([r for r in opps if sc.keep(r)])
        money = "n/a" if o.money_basis == "none" else _usd(o.money_usd)
        out.append(
            f"{sc.name.ljust(34)} {str(o.acted).rjust(5)}  {_pct(o.executable, o.acted).rjust(11)}  {str(o.simulated_ok).rjust(6)}  "
            f"{str(o.landed).rjust(6)}  {money.ljust(15)}  {_usd(o.quoted_usd)}"
        )
    surv = survival_by_age(opps)
    if surv:
        out.append("")
        out.append("How fast gaps die (scan quote age at the fresh re-quote -> share still there)")
        for r in surv:
            out.append(f"  {r['bucket'].ljust(14)} {_pct(r['still_there'], r['n']).rjust(5)}  (n={r['n']})")
    sizes = size_policies(opps)
    if sizes:
        out.append("")
        out.append("Size policies (quoted at decision time only; NOT profit)")
        for s in sizes:
            out.append(f"  {s['name'].ljust(28)} {_usd(s['quoted_usd'])}  (n={s['n']})")
    out.append("")
    out.append(
        "Looser rules: see the probe section above (re-quotes only; on-chain results need trades above the bar)."
        if probes
        else "Looser rules can't be judged from this data: candidates below the bar were never re-checked."
    )
    return "\n".join(out)


def main(load_cfg, argv: list[str]) -> None:
    cfg = load_cfg()
    arg = next((a[7:] for a in argv if a.startswith("--mode=")), None)
    modes = [arg] if arg else ["paper", "micro", "live"]
    opps = [r for m in modes for r in Funnel.read(os.path.join(cfg.data_dir, f"opps-{m}.jsonl"))]
    probes = [p for m in modes for p in ProbeLog.read(os.path.join(cfg.data_dir, f"probes-{m}.jsonl"))]
    print(render_backtest(opps, probes))
    sys.stdout.flush()
