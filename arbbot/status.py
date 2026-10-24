"""
`status`   one-time progress screen
`watch`    same, refreshing every few seconds (Ctrl+C to exit)

With ENGINE_URL set (e.g. http://<phone>:8787), shows that engine's status
instead of reading the local data folder.
"""

import asyncio
import os
import re
import sys
import time

import httpx

from .brain import EDGE_BINS, Brain
from .funnel import FunnelReader
from .gate import GateThresholds, go_live_verdict, load_gate_input
from .killswitch import halted, trading_disabled
from .ledger import Ledger, totals_by_basis
from .probes import GapMemory, ProbeLog
from .status_file import is_alive, read_status
from .tail import tail_lines
from .util import iso, js_round, js_str, now_ms, start_of_utc_day, to_fixed

DAY_MS = 86_400_000
EVENT_PATTERN = re.compile(
    r"FILLED|REJECTED|FAILED|TIMEOUT|DISABLED|re-enabled|moving fast|found new tokens|HALTED|paused|Started|Stopped"
    r"|cycle error|too many requests|crashed|stopped|refused|quote-only"
)


def results_of(records: list[dict], now: int) -> dict:
    """Results per basis, today and all time: quoted, simulated and realized are never added together."""
    return {
        "today": totals_by_basis(records, start_of_utc_day(now)),
        "all": totals_by_basis(records),
        "failed": sum(1 for r in records if r.get("status") == "failed"),
        "fake": sum(1 for r in records if r.get("status") == "rejected"),
    }


def verdict_dict(v) -> dict | None:
    if v is None:
        return None
    return {"micro": {"ok": v.micro.ok, "reasons": v.micro.reasons}, "live": {"ok": v.live.ok, "reasons": v.live.reasons}}


def bar(fraction: float, width: int) -> str:
    f = min(1, max(0, fraction))
    full = js_round(f * width)
    return "█" * full + "░" * (width - full)


def duration(ms: float) -> str:
    s = max(0, int(ms // 1000))
    d, h, m = s // 86_400, (s % 86_400) // 3600, (s % 3600) // 60
    if d:
        return f"{d}d {h}h"
    if h:
        return f"{h}h {m}m"
    if m:
        return f"{m}m"
    return f"{s}s"


def _money(n: float) -> str:
    return f"{'+' if n >= 0 else '-'}${to_fixed(abs(n), 4)}"


def _thousands(n: float) -> str:
    return f"{int(n):,}" if float(n).is_integer() else f"{n:,}"


def render_status(i: dict, now: int, color: bool) -> str:
    """The status screen, from the data gather_status() returns (plain JSON, so a remote engine can send it)."""

    def c(code: int, t: str) -> str:
        return f"\x1b[{code}m{t}\x1b[0m" if color else t

    green, red, yellow = (lambda t: c(32, t)), (lambda t: c(31, t)), (lambda t: c(33, t))
    dim, bold = (lambda t: c(2, t)), (lambda t: c(1, t))
    out: list[str] = []
    live = i.get("live")

    out.append(bold("=== Solana arb bot ===  ") + dim(iso(now)[:16].replace("T", " ") + " UTC"))

    # --- is it running? -------------------------------------------------------
    stale_after = max(120_000, ((live or {}).get("nextScanInMs") or 0) * 2 + 30_000)
    age = now - live["updatedAt"] if live else float("inf")
    if i.get("halted"):
        out.append(f"Status:  {red('■ HALTED')}  {i['halted']}")
        out.append(dim("         Read the reason, then delete data/HALTED to allow a restart."))
    elif not live:
        out.append(f"Status:  {yellow('○ NOT STARTED YET')}  start it: bash deploy/termux-run.sh &")
    elif not i.get("processAlive") or live.get("state") == "stopped":
        out.append(f"Status:  {red('■ STOPPED')}  (last seen {duration(age)} ago)  start it: bash deploy/termux-run.sh &")
    elif age > stale_after:
        out.append(f"Status:  {yellow('● STUCK?')}  running but no update for {duration(age)}; check: tail data/bot.log")
    else:
        mode = live.get("mode")
        if mode == "live":
            how = f"LIVE, real money via {live.get('sendVia')}"
        elif mode == "micro":
            how = f"MICRO, tiny real trades via {live.get('sendVia')}"
        else:
            how = "paper, tested on-chain" if live.get("onChainTesting") else "paper, quote-only"
        out.append(f"Status:  {green('● RUNNING')}  ({how})  up {duration(now - live['startedAt'])}, {live['cycles']} scans")
    if i.get("killSwitch") and not i.get("halted"):
        out.append(f"Trading: {red('■ DISABLED')}  {i['killSwitch']}")
        out.append(dim("         Check why, then re-enable: npm run enable-trading"))

    if live and i.get("processAlive") and not i.get("halted"):
        nxt = max(0, live["updatedAt"] + (live.get("nextScanInMs") or 0) - now)
        state = live.get("state")
        doing = f"scanning, next scan in {duration(nxt)}" if state == "scanning" else f"{state}: {live.get('note') or ''}"
        out.append(f"Doing:   {doing}")
        if state == "scanning" and live.get("note"):
            out.append(f"         {yellow(live['note'])}")
        b = live.get("lastBest")
        if b:
            # How close the last scan came: -20bps or worse = empty, at the bar = full.
            closeness = (b["expectedBps"] + 20) / (b["needBps"] + 20)
            exp = f" (expect {to_fixed(b['expectedBps'], 1)})" if abs(b["expectedBps"] - b["netBps"]) >= 0.1 else ""
            meter = green(bar(1, 12)) if closeness >= 1 else bar(closeness, 12)
            out.append(f"Last:    {b['symbol']} {to_fixed(b['netBps'], 1)}bps{exp}, need {js_str(b['needBps'])}  {meter} {dim('how close')}")
        if live.get("scansLastMin") is not None and live.get("jupiterLimit"):
            up_ms = now - live["startedAt"]
            scans = (
                f"{live['scansLastMin']} scans so far (started {duration(up_ms)} ago)"
                if up_ms < 60_000
                else f"{live['scansLastMin']} scans in the last minute"
            )
            out.append(f"Speed:   {scans}  " + dim(f"(Jupiter: {live.get('jupiterUsed') or 0}/{live['jupiterLimit']} requests used per minute)"))
            if live.get("quoteMs") is not None:
                out.append(dim(f"         quoting both legs of a token takes ~{live['quoteMs']} ms from here"))
        elif live.get("paceFloorMs"):
            out.append(f"Speed:   ~{to_fixed(60_000 / live['paceFloorMs'], 1)} scans/min")
        e = live.get("events")
        if e:
            watching = yellow("paused for today (daily cap reached)") if e.get("capped") else f"watching {e.get('watching', 0)} pool(s)"
            out.append(
                f"Events:  {watching}, {_thousands(e.get('eventsToday', 0))} / {_thousands(e.get('cap', 0))} updates today"
                + (dim(f"  ({e['tooBusy']} too-busy pool(s) resting)") if e.get("tooBusy") else "")
            )
        pw = live.get("priceWatch")
        if pw and pw.get("tokens"):
            out.append(f"Prices:  watching {pw['tokens']} tokens every {duration(pw['everyMs'])} " + dim("(1 request; movers get quoted first)"))
        if live.get("focus"):
            out.append(f"Focus:   {yellow(', '.join(live['focus']))} {dim('(re-checking just this every few seconds)')}")
        f = live.get("funnelToday")
        if f:
            stages = ["quoted", "executable", "simulated", "submitted", "landed", "profitable"]
            out.append(f"Funnel:  {' → '.join(f'{s} {f.get(s, 0)}' for s in stages)} {dim('(today)')}")
        o = live.get("lastOpp")
        if o:
            out.append(
                f"Latest:  {o['id']} {o['symbol']} quoted {to_fixed(o['quotedBps'], 1)}bps"
                + (f" → fresh {to_fixed(o['execBps'], 1)}bps" if o.get("execBps") is not None else "")
                + f' → {o["result"]} at "{o["stage"]}" ' + dim(f"({o['totalMs']} ms)")
            )
        if live.get("hot"):
            out.append(f"Hot:     {yellow(', '.join(live['hot']))} {dim('(sudden price moves)')}")
        out.append(
            f"Wallet:  ${to_fixed(live['walletValueUsd'], 2)}{dim(' (paper)') if live.get('mode') == 'paper' else ''}   "
            f"trade size up to ${to_fixed(live['tradeSizeUsd'], 2)}   SOL ${to_fixed(live['solPrice'], 2)}"
        )

    # --- test progress and the go-live gate -----------------------------------
    paper = not live or live.get("mode") == "paper"
    v = i.get("verdict")
    if paper or v:
        out.append("")
    if paper:
        days = (now - i["brainStartedAt"]) / DAY_MS
        target = i["paperDaysTarget"]
        out.append(f"Test:    [{bar(days / target, 20)}] {to_fixed(min(days, 99), 1)} / {js_str(target)} days")
    if v:
        yn = lambda ok: green("YES") if ok else red("NO")  # noqa: E731
        out.append(f"Go live? MICRO: {yn(v['micro']['ok'])}  LIVE: {yn(v['live']['ok'])}  {dim('(npm run report explains)')}")
        # The next hurdle: MICRO's while paper testing, LIVE's once real trades run.
        why = (v["micro"]["reasons"] if paper else v["live"]["reasons"])[:1]
        if why:
            out.append(dim(f"         {why[0]}"))

    # --- results: quoted, simulated and realized are NEVER added together ------
    res = i["results"]
    all_t, today_t = res["all"], res["today"]
    out.append("")
    out.append(bold("Results") + dim("  (today / all time)"))

    def row(name: str, b: str, note: str) -> str:
        return (
            f"  {name.ljust(22)} {str(today_t[b]['count']).rjust(3)} / {str(all_t[b]['count']).ljust(4)} "
            f"{_money(today_t[b]['netUsd'])} / {_money(all_t[b]['netUsd'])}  {dim(note)}"
        )

    out.append(yellow(row("quoted (not profit)", "quoted", "quotes only, unproven")))
    out.append(row("simulated on-chain", "simulated", "exact tx simulated, nothing sent"))
    out.append(row("realized (real money)", "realized", "landed transactions"))
    out.append(f"  fake gaps (cost nothing): {res['fake']}   failed on-chain: {res['failed']}")

    # --- how close gaps got ---------------------------------------------------
    hist = i.get("edgeHistogram") or {}
    total = sum(hist.values())
    if total:
        out.append("")
        out.append(bold("How close gaps got") + dim(" (best per scan, bps after fees)"))
        for label, _ in EDGE_BINS:
            n = hist.get(label, 0)
            if not n:
                continue
            pct = n / total
            line = f"  {label.ljust(8)} {bar(pct, 20)} {to_fixed(pct * 100, 1)}%"
            out.append(green(line) if label in ("20+", "10..20") else line)

    if i.get("thoughts"):
        out.append("")
        out.append(bold("Brain thinks"))
        for t in i["thoughts"][:4]:
            out.append(f"  - {t}")

    if i.get("events"):
        out.append("")
        out.append(bold("Recent events"))
        for e in i["events"]:
            out.append(dim(f"  {e[:160]}"))

    return "\n".join(out)


# Funnel files only grow; when refreshing, parse just the new lines.
_readers: dict[str, FunnelReader] = {}


def _read_cached(path: str) -> list[dict]:
    if path not in _readers:
        _readers[path] = FunnelReader(path)
    return _readers[path].read()


def mix_thoughts(brain: list[str], gaps: list[str]) -> list[str]:
    """The brain's own thoughts and what re-checks taught, alternating so both show."""
    out: list[str] = []
    for k in range(max(len(brain), len(gaps))):
        if k < len(brain) and brain[k]:
            out.append(brain[k])
        if k < len(gaps) and gaps[k]:
            out.append(gaps[k])
    return out


def gather_status(cfg, now: int | None = None) -> dict:
    """Reads the data folder. The engine's status server calls this too."""
    now = now_ms() if now is None else now
    d = cfg.data_dir
    live = read_status(os.path.join(d, "status.json"))
    brain = Brain(os.path.join(d, f"brain-{cfg.mode}.json"), cfg.min_profit_bps)
    try:
        verdict = verdict_dict(go_live_verdict(load_gate_input(d, now, _read_cached), GateThresholds.from_config(cfg)))
    except Exception:  # noqa: BLE001 - the verdict is a hint on this screen; `report` shows any problem
        verdict = None
    gaps = GapMemory.from_records(
        ProbeLog.read(os.path.join(d, f"probes-{cfg.mode}.jsonl")), _read_cached(os.path.join(d, f"opps-{cfg.mode}.jsonl"))
    )
    return {
        "live": live,
        "processAlive": is_alive((live or {}).get("pid")),
        "halted": halted(d),
        "killSwitch": trading_disabled(d),
        "results": results_of(Ledger.read(os.path.join(d, f"trades-{cfg.mode}.jsonl")), now),
        "brainStartedAt": brain.state["startedAt"],
        "paperDaysTarget": cfg.gate_min_paper_days,
        "verdict": verdict,
        "edgeHistogram": brain.state["edgeHistogram"],
        "thoughts": mix_thoughts(brain.thoughts(cfg.min_profit_bps), gaps.thoughts()),
        "events": [l for l in tail_lines(os.path.join(d, "bot.log"), 400) if EVENT_PATTERN.search(l)][-6:],
    }


async def fetch_remote_status(engine_url: str, token: str | None, client: httpx.AsyncClient | None = None) -> dict:
    """A remote engine's status (ENGINE_URL), e.g. the phone's, seen from a laptop."""
    own = client is None
    client = client or httpx.AsyncClient(timeout=10)
    try:
        res = await client.get(f"{engine_url.rstrip('/')}/status.json", headers={"authorization": f"Bearer {token}"} if token else {})
    finally:
        if own:
            await client.aclose()
    if res.status_code >= 400:
        raise RuntimeError(f"engine answered {res.status_code}{' (check ENGINE_TOKEN)' if res.status_code == 401 else ''}")
    return res.json()


def screen(load_cfg) -> str:
    color = sys.stdout.isatty()
    engine = os.environ.get("ENGINE_URL")
    if not engine:
        return render_status(gather_status(load_cfg()), now_ms(), color)
    try:
        data = asyncio.run(fetch_remote_status(engine, os.environ.get("ENGINE_TOKEN") or os.environ.get("STATUS_HTTP_TOKEN")))
        return render_status(data, now_ms(), color) + f"\n\n(from {engine})"
    except Exception as err:  # noqa: BLE001 - show the problem instead of a traceback
        return f"Cannot reach the bot at {engine}: {str(err)[:160]}"


def main(load_cfg, watch: bool = False) -> None:
    if not watch:
        print(screen(load_cfg))
        return
    try:
        while True:
            # Clear the screen and redraw in place.
            sys.stdout.write("\x1b[2J\x1b[H" + screen(load_cfg) + "\n\n(refreshes every 5s, Ctrl+C to exit)\n")
            sys.stdout.flush()
            time.sleep(5)
    except KeyboardInterrupt:
        pass
