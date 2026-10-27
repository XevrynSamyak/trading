"""
`report`: what actually happened, with quoted, executable, simulated and
realized results kept apart across every mode the bot has run in, plus risk
status and an honest go-live verdict.
"""

import os
from dataclasses import dataclass, field

from .atomic import read_json_with_backup
from .brain import Brain
from .funnel import STAGES, Funnel
from .gate import GateThresholds, Verdict, go_live_verdict, load_gate_input
from .ledger import Ledger, basis_of, money_basis, totals_by_basis
from .gappredict import GapPredictor
from .probes import ProbeLog
from .stats import LearningStats, size_bucket
from .status_file import read_status
from .sustain import format_verdict, month_verdict
from .tokensafety import STATES, SafetyThresholds, TokenSafety
from .trend import Trend
from .util import iso, js_round, now_ms, start_of_utc_day, start_of_utc_month, to_fixed

MODES = ["paper", "micro", "live"]


@dataclass
class ReportData:
    mode_now: str
    #: Round trips quoted by scans (all of them, not only candidates).
    scans: int
    opps: list[dict]
    stats: LearningStats
    quoted_only_usd: float
    verdict: Verdict
    #: {"level": "GREEN" | "AMBER" | "RED", "reasons": [...]}
    risk: dict
    thoughts: list[str]
    bills_line: str
    #: Safety state of every token the bot knows: {symbol, state, reasons}.
    safety: list[dict] = field(default_factory=list)
    #: Last `benchmark` from this device (data/benchmark.json).
    benchmark: dict | None = None
    #: What re-checks taught: {"table": [...], "thoughts": [...]}.
    gaps: dict | None = None
    brain_summary: str = ""
    #: Gap predictor scorecard (GapPredictor.summary()).
    gap_predict: dict | None = None
    #: Price-direction predictions, paper only: {"status": Trend.status(), "thoughts": [...], "evidence": str}.
    trend: dict | None = None
    #: The stablecoin trades start and end in.
    base: str = "USDC"


def _median(xs: list[float]) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def _avg(xs: list[float]) -> float | None:
    return sum(xs) / len(xs) if xs else None


def _fmt_bps(x: float | None) -> str:
    return "   n/a" if x is None else f"{to_fixed(x / 100, 2).rjust(6)}%"


def _fmt_ms(x: float | None) -> str:
    return "n/a" if x is None else f"{js_round(x)} ms"


def _usd(n: float) -> str:
    return f"{'+' if n >= 0 else '-'}${to_fixed(abs(n), 4)}"


def _pct(num: float, den: float) -> str:
    return f"{to_fixed(num / den * 100, 1)}%" if den else "n/a"


def _stage_at_least(r: dict, stage: str) -> bool:
    return STAGES.index(r["stage"]) >= STAGES.index(stage) if r.get("stage") in STAGES else False


def _best_by(items: list[dict], key, value, min_n: int = 1) -> str:
    """Best key by mean of a value, among groups with at least `min_n` samples."""
    groups: dict[str, list[float]] = {}
    for it in items:
        v = value(it)
        if v is None:
            continue
        groups.setdefault(key(it), []).append(v)
    best = None
    for k, vs in groups.items():
        if len(vs) < min_n:
            continue
        m = sum(vs) / len(vs)
        if best is None or m > best[1]:
            best = (k, m)
    return f"{best[0]} ({_usd(best[1])} avg)" if best else "n/a"


def render_report(d: ReportData) -> str:
    o = d.opps
    real = [r for r in o if r.get("mode") != "paper"]
    sims = [r for r in o if r.get("simulated")]
    sim_ok = [r for r in sims if r["simulated"].get("ok")]
    landed = [r for r in real if (r.get("realized") or {}).get("landed")]
    profitable = [r for r in landed if r["realized"]["netUsd"] > 0]
    failed = [r for r in real if r.get("result") == "failed"]
    submitted = [r for r in real if _stage_at_least(r, "submitted")]
    realized = sum(r["realized"]["netUsd"] for r in landed)
    executable = sum(1 for r in o if _stage_at_least(r, "executable"))

    quoted_bps = [r["quoted"]["netBps"] for r in o]
    exec_bps = [r["executable"]["netBps"] for r in o if r.get("executable")]
    sim_bps = [r["simulated"]["netBps"] for r in sim_ok]
    real_bps = [r["realized"]["netBps"] for r in landed]

    line = "=" * 48
    out = [line, "            ARBITRAGE BOT REPORT", line, ""]
    out.append(f"Mode now:                     {d.mode_now.upper()}, trading in {d.base}")
    out.append(f"Scanned round trips:          {d.scans:,}")
    out.append(f"Candidates acted on:          {len(o):,}")
    out.append(f"  still there at re-quote:    {executable}  ({_pct(executable, len(o))})")
    out.append(f"  simulated on-chain:         {len(sims)}  (OK: {len(sim_ok)}, {_pct(len(sim_ok), len(sims))})")
    out.append(
        f"Real trades (MICRO/LIVE):     {len(submitted)} sent, {len(landed)} landed, {len(profitable)} profitable, {len(failed)} failed"
    )
    kinds = list(dict.fromkeys(r.get("kind") for r in o))
    if len(kinds) > 1:
        for k in kinds:
            ks = [r for r in o if r.get("kind") == k]
            held = sum(1 for r in ks if _stage_at_least(r, "executable"))
            out.append(
                f"  {k}:".ljust(30)
                + f"{len(ks)} acted on, {_pct(held, len(ks))} still there at re-quote, "
                + f"{sum(1 for r in ks if (r.get('simulated') or {}).get('ok'))} simulated OK, "
                + f"{sum(1 for r in ks if (r.get('realized') or {}).get('landed'))} landed"
            )
    out.append("")
    out.append(f"Realized P&L (real money):    {_usd(realized)}")
    out.append(f"Quoted-only results:          {_usd(d.quoted_only_usd)}  (quotes alone; NOT profit)")
    out.append("")
    out.append("Net edge after all costs       average   median     n")

    def edge_row(name: str, xs: list[float]) -> str:
        return f"  {name.ljust(27)} {_fmt_bps(_avg(xs))}  {_fmt_bps(_median(xs))}  {str(len(xs)).rjust(4)}"

    out.append(edge_row("quoted (not profit)", quoted_bps))
    out.append(edge_row("executable (fresh re-quote)", exec_bps))
    out.append(edge_row("simulated on-chain", sim_bps))
    out.append(edge_row("realized", real_bps))
    out.append("")
    out.append(f"Landing rate:                 {_pct(len(landed), len(submitted))}")
    out.append(f"Profitability rate:           {_pct(len(profitable), len(landed))}")
    out.append("")
    out.append("Latency (median)")

    def lrow(label: str, v: str) -> None:
        out.append(f"  {label}".ljust(30) + v)

    def opt(xs) -> float | None:
        return _median([x for x in xs if x is not None])

    lat = lambda r, k: (r.get("lat") or {}).get(k)  # noqa: E731
    lrow("quote (all legs):", _fmt_ms(opt(lat(r, "quoteMs") for r in o)))
    lrow("market change -> quote:", _fmt_ms(opt(lat(r, "marketToQuoteMs") for r in o)))
    lrow("quote -> decision+sizing:", _fmt_ms(opt(lat(r, "quoteToDecisionMs") for r in o)))
    lrow("decision -> fresh re-quote:", _fmt_ms(opt(
        r["t"]["requoteEnd"] - r["t"]["decision"] if r["t"].get("requoteEnd") is not None else None for r in o)))
    lrow("decision -> submission:", _fmt_ms(opt(lat(r, "decisionToSubmitMs") for r in real)))
    lrow("submission -> landing:", _fmt_ms(opt(lat(r, "submitToLandingMs") for r in real)))
    totals = [lat(r, "totalMs") for r in o if lat(r, "totalMs") is not None]
    lrow("total (avg / median):", f"{_fmt_ms(_avg(totals))} / {_fmt_ms(_median(totals))}")
    # Did pool-event triggers find gaps that were still there more often than plain polling?
    evented = [r for r in o if r["t"].get("market") is not None]
    if evented:
        polled = [r for r in o if r["t"].get("market") is None]
        held_n = lambda xs: sum(1 for r in xs if _stage_at_least(r, "executable"))  # noqa: E731
        lrow("event-triggered:", f"{len(evented)} acted on, {_pct(held_n(evented), len(evented))} still there at re-quote")
        lrow("polled:", f"{len(polled)} acted on, {_pct(held_n(polled), len(polled))} still there at re-quote")
    b = d.benchmark
    if b:
        ms = lambda x: "n/a" if x is None else f"{js_round(x)} ms"  # noqa: E731
        out.append("")
        out.append(f"Measured here (npm run benchmark, {iso(int(b['ts']))[:16].replace('T', ' ')} UTC)")
        lrow("RPC round trip:", f"{ms(b['rpcSlot'].get('medianMs'))} median, {ms(b['rpcSlot'].get('p90Ms'))} p90")
        if b.get("quoteRoundTrip"):
            lrow("Jupiter, both legs:", f"{ms(b['quoteRoundTrip'].get('medianMs'))} median, {ms(b['quoteRoundTrip'].get('p90Ms'))} p90")
        if b.get("minGapLifetimeMs") is not None:
            lrow("a gap must last at least:", ms(b["minGapLifetimeMs"]))
    out.append("")
    # "Best" by real money if there is any, else by on-chain simulation; never by quotes.
    evidence = landed or sim_ok

    def val(r: dict) -> float | None:
        if (r.get("realized") or {}).get("landed"):
            return r["realized"]["netUsd"]
        if (r.get("simulated") or {}).get("ok"):
            return r["simulated"]["netUsd"]
        return None

    basis_note = "realized" if landed else "simulated" if sim_ok else "no evidence yet"
    out.append(f"Best token ({basis_note}):".ljust(30) + _best_by(evidence, lambda r: r["symbol"], val))
    out.append("Best route:".ljust(30) + _best_by(evidence, lambda r: r["route"], val))
    out.append("Best trade size:".ljust(30) + _best_by(evidence, lambda r: f"${size_bucket(r['sizeUsd'])}", val))
    chosen = [r["sizeUsd"] for r in o if r.get("ladder")]
    if chosen:
        out.append(f"Size chosen by the ladder:    median ${to_fixed(_median(chosen), 2)} (max ${to_fixed(max(chosen), 2)})")
    out.append("")

    rows = d.stats.table()
    if rows:
        out.append("Token        n   Quote edge   Exec edge   Real edge   Success")
        for r in rows[:12]:
            out.append(
                f"{r['symbol'].ljust(10)} {str(r['n']).rjust(4)} {_fmt_bps(r['quoted_bps']).rjust(11)} {_fmt_bps(r['exec_bps']).rjust(11)} "
                f"{_fmt_bps(r['real_bps']).rjust(11)}{'*' if r['real_kind'] == 'simulated' else ' '} {to_fixed(r['success_pct'], 0).rjust(6)}%"
            )
        out.append("  (* = simulated on-chain, no real trades yet)")
        out.append("")

    if d.gaps and d.gaps.get("table"):
        out.append("What re-checks taught       (gap still there when quoted again; learning only)")
        out.append("  quoted gap     n   still there   shrank on average")
        for r in d.gaps["table"]:
            out.append(
                f"  {r['bucket'].ljust(10)} {str(r['n']).rjust(5)}   {(to_fixed(r['held_pct'], 0) + '%').rjust(11)}   "
                f"{to_fixed(r['avg_decay_bps'], 1).rjust(8)}bps"
            )
        for t in d.gaps.get("thoughts", []):
            out.append(f"  - {t}")
        out.append("")

    gp = d.gap_predict
    if gp and gp.get("n"):
        out.append("Gap predictions               (each scored before its outcome was known)")
        out.append(f"  re-checks scored:           {gp['n']}")
        skill = gp["skill_pct"]
        out.append(
            f"  vs assuming the average:    {'+' if skill >= 0 else ''}{to_fixed(skill, 1)}% "
            f"({'used to decide' if gp['used'] else 'not used to decide yet'})"
        )
        out.append(f"  right at a 50% cut-off:     {to_fixed(gp['accuracy_pct'], 0)}% (always guessing the usual outcome: "
                   f"{to_fixed(gp['accuracy_base_pct'], 0)}%)")
        if gp.get("size_err_bps") is not None:
            out.append(f"  gap size at re-check:       off by {to_fixed(gp['size_err_bps'], 1)}bps on average "
                       f"(the quote at face value: {to_fixed(gp['size_err_quote_bps'], 1)}bps)")
        for row in gp.get("calibration", []):
            out.append(f"    said {row['range'].ljust(8)} n={str(row['n']).ljust(5)} actually still there "
                       f"{to_fixed(row['actual_pct'], 0)}%")
        out.append("")

    tr = d.trend
    if tr and tr.get("status"):
        st = tr["status"]
        out.append("Price-direction predictions   (PAPER ONLY: never traded with real money)")
        out.append(f"  question:                   will a token rise more than its trading costs in {st['horizonMin']} min?")
        out.append(f"  tokens with enough history: {st['tokens']} of {st['watching']}")
        if st["predictions"]:
            out.append(f"  predictions checked:        {st['predictions']:,}, right {to_fixed(st['accuracyPct'], 0)}% "
                       f"(always 'no': {to_fixed(st['baseAccuracyPct'], 0)}%), vs average {'+' if st['skillPct'] >= 0 else ''}"
                       f"{to_fixed(st['skillPct'], 1)}%")
            sign = "+" if st["netUsd"] >= 0 else "-"
            out.append(f"  paper trades:               {st['trades']} closed, {st['open']} open, "
                       f"{sign}${to_fixed(abs(st['netUsd']), 4)} after costs (paper)")
            out.append(f"  verdict:                    {tr['evidence']}")
        for t in tr.get("thoughts", []):
            out.append(f"  - {t}")
        out.append("")

    if d.safety:
        out.append("Token safety                  (BLOCKED: never quoted, WATCH: quoted only, PAPER_ONLY, LIVE_ALLOWED)")
        for t in sorted(d.safety, key=lambda t: (STATES.index(t["state"]), t["symbol"].casefold(), t["symbol"].swapcase())):
            out.append(f"  {t['symbol'].ljust(10)} {t['state'].ljust(13)} {'; '.join(t['reasons'])}".rstrip())
        out.append("")

    out.append(line)
    out.append(f"RISK STATUS:                  {d.risk['level']}")
    for r in d.risk["reasons"]:
        out.append(f"    - {r}")
    out.append("")
    out.append("GO-LIVE VERDICT:")
    out.append(f"    MICRO LIVE: {'YES' if d.verdict.micro.ok else 'NO'}")
    out.append(f"    FULL LIVE:  {'YES' if d.verdict.live.ok else 'NO'}")
    out.append("")
    out.append("REASON:")
    reasons = [f"MICRO: {r}" for r in d.verdict.micro.reasons] + [f"LIVE: {r}" for r in d.verdict.live.reasons]
    if not reasons:
        out.append("    All gates passed on real execution data.")
    for r in reasons:
        out.append(f"    {r}")
    out.append(line)
    out.append("")
    out.append(d.bills_line)
    if d.thoughts:
        out += ["", "What the brain is thinking:"]
        for t in d.thoughts[:5]:
            out.append(f"- {t}")
    return "\n".join(out)


def risk_status(
    kill_switch: str | None,
    halted: str | None,
    today_money_pnl_usd: float,
    daily_loss_limit_usd: float,
    timeouts_today: int,
    loss_floor_usd: float,
    wallet_value_usd: float | None = None,
) -> dict:
    """GREEN / AMBER / RED from what the files say."""
    red: list[str] = []
    amber: list[str] = []
    if kill_switch:
        red.append(f"trading disabled: {kill_switch}")
    if halted:
        red.append(f"halted: {halted}")
    if today_money_pnl_usd <= -0.5 * daily_loss_limit_usd:
        amber.append(f"today's P&L ${to_fixed(today_money_pnl_usd, 2)} is past half the daily limit")
    if timeouts_today:
        amber.append(f"{timeouts_today} unconfirmed landing(s) today")
    if wallet_value_usd is not None and wallet_value_usd <= loss_floor_usd * 1.1:
        amber.append("wallet is within 10% of the loss floor")
    if red:
        return {"level": "RED", "reasons": red + amber}
    if amber:
        return {"level": "AMBER", "reasons": amber}
    return {"level": "GREEN", "reasons": []}


def build_report_data(cfg, now: int | None = None) -> ReportData:
    now = now_ms() if now is None else now

    def file(name: str) -> str:
        return os.path.join(cfg.data_dir, name)

    opps = [r for m in MODES for r in Funnel.read(file(f"opps-{m}.jsonl"))]
    trades = [r for m in MODES for r in Ledger.read(file(f"trades-{m}.jsonl"))]
    scans = 0
    for m in MODES:
        b = read_json_with_backup(file(f"brain-{m}.json"))
        if b and isinstance(b[0], dict):
            scans += b[0].get("totalScans") or 0
    gate = load_gate_input(cfg.data_dir, now)
    verdict = go_live_verdict(gate, GateThresholds.from_config(cfg))

    # Money that counts in the current mode: simulated in paper, realized in micro/live.
    money = money_basis(cfg.mode)
    mine = [r for r in trades if r.get("mode") == cfg.mode and basis_of(r) == money]
    today = start_of_utc_day(now)
    today_pnl = sum(r["netUsd"] for r in mine if r["ts"] >= today)
    live = read_status(file("status.json"))
    risk = risk_status(
        kill_switch=gate.kill_switch,
        halted=gate.halted,
        today_money_pnl_usd=today_pnl,
        daily_loss_limit_usd=cfg.daily_loss_limit_usd,
        timeouts_today=sum(1 for o in opps if o["ts"] >= today and o.get("result") == "timeout"),
        wallet_value_usd=live.get("walletValueUsd") if live and live.get("mode") == cfg.mode else None,
        loss_floor_usd=cfg.loss_floor_usd,
    )
    bills = format_verdict(month_verdict(mine, start_of_utc_month(now), cfg.monthly_costs_usd))
    bills_line = f"Bills: {bills} (month to date, " + (
        "real money)" if money == "realized" else "simulated on-chain only; NOT real money)"
    )
    brain = Brain(file(f"brain-{cfg.mode}.json"), cfg.min_profit_bps)
    safety = TokenSafety(file("token-safety.json"), cfg.live_tokens, SafetyThresholds.from_config(cfg))
    safety_rows = []
    for symbol, mint in brain.token_pool(cfg.tokens).items():
        v = safety.verdict(symbol, mint, symbol in cfg.tokens, now)
        safety_rows.append({"symbol": symbol, "state": v.state, "reasons": v.reasons})
    bench = read_json_with_backup(file("benchmark.json"))
    gaps = GapPredictor.from_records([p for m in MODES for p in ProbeLog.read(file(f"probes-{m}.jsonl"))], opps)
    trend = Trend(cfg.data_dir, cfg.trend_horizon_min, cfg.trend_enter_prob, cfg.trend_max_positions, cfg.trend_stop_pct,
                  readonly=True) if cfg.trend_paper else None
    return ReportData(
        mode_now=cfg.mode,
        scans=scans,
        opps=opps,
        stats=LearningStats.from_records(opps),
        quoted_only_usd=totals_by_basis(trades)["quoted"]["netUsd"],
        verdict=verdict,
        risk=risk,
        thoughts=brain.thoughts(cfg.min_profit_bps),
        bills_line=bills_line,
        safety=safety_rows,
        benchmark=bench[0] if bench and isinstance(bench[0], dict) else None,
        gaps={"table": gaps.memory.table(), "thoughts": gaps.memory.thoughts()},
        brain_summary=brain.summary(),
        gap_predict=gaps.summary(),
        trend={"status": trend.status(), "thoughts": trend.thoughts(), "evidence": trend.evidence()} if trend else None,
        base=cfg.base_token,
    )


def main(load_cfg) -> None:
    data = build_report_data(load_cfg())
    print(render_report(data))
    print("\nBrain details:\n" + data.brain_summary)
