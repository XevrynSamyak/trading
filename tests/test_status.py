import asyncio
import json
from datetime import datetime, timezone

import httpx
import pytest

from arbbot.log import redact
from arbbot.server import ServerDeps, ServerOptions, StatusServer, check_server_options
from arbbot.status import bar, duration, fetch_remote_status, gather_status, mix_thoughts, render_status, results_of

NOW = int(datetime(2026, 10, 5, 12, tzinfo=timezone.utc).timestamp() * 1000)


def base(**o):
    d = {
        "live": {
            "pid": 123, "mode": "paper", "startedAt": NOW - 2 * 3600_000 - 13 * 60_000, "updatedAt": NOW - 5_000, "cycles": 512,
            "state": "scanning", "onChainTesting": True, "sendVia": "jito", "solPrice": 121.6, "walletValueUsd": 25,
            "tradeSizeUsd": 20, "lastBest": {"symbol": "SOL", "netBps": -0.8, "expectedBps": -0.8, "needBps": 20}, "hot": ["BONK"],
            "nextScanInMs": 15_000,
        },
        "processAlive": True,
        "halted": None,
        "killSwitch": None,
        "results": results_of([], NOW),
        "brainStartedAt": NOW - 1.5 * 86_400_000,
        "paperDaysTarget": 3,
        "verdict": {
            "micro": {"ok": False, "reasons": ["only 4 trades simulated on-chain (need 30)", "only 1.5 days of paper data (need 3)"]},
            "live": {"ok": False, "reasons": ["Insufficient real execution sample: 0 MICRO trades landed (need 20)"]},
        },
        "edgeHistogram": {"-5..0": 8, "-20..-5": 2},
        "thoughts": ["I only trade when a gap pays at least 20bps (0.20%) after fees."],
        "events": ["[2026-10-05T10:00:00Z] Started in PAPER mode"],
    }
    d.update(o)
    return d


def live(**o):
    return {**base()["live"], **o}


def render(**o):
    return render_status(base(**o), NOW, False)


def test_running_bot_and_progress():
    text = render()
    assert "● RUNNING  (paper, tested on-chain)  up 2h 13m, 512 scans" in text
    assert "scanning, next scan in 10s" in text
    assert "Last:    SOL -0.8bps, need 20" in text
    assert "Hot:     BONK" in text
    assert "Test:    [██████████░░░░░░░░░░] 1.5 / 3 days" in text
    assert "Go live? MICRO: NO  LIVE: NO" in text
    assert "         only 4 trades simulated on-chain (need 30)" in text
    assert "Trading: ■ DISABLED" not in text
    assert "-5..0    ████████████████░░░░ 80.0%" in text
    assert "Brain thinks" in text
    assert "Started in PAPER mode" in text


def test_stopped_stuck_halted_not_started():
    assert "■ STOPPED" in render(processAlive=False)
    assert "■ STOPPED" in render(live=live(state="stopped"))
    assert "● STUCK?" in render(live=live(updatedAt=NOW - 10 * 60_000))
    assert "■ HALTED  loss floor hit" in render(halted="loss floor hit")
    assert "NOT STARTED YET" in render(live=None, processAlive=False)


def test_kill_switch_micro_and_live_hurdle():
    off = render(killSwitch="2026-10-05T11:00:00Z a single trade lost $0.0800", live=live(state="disabled", note="a single trade lost $0.0800"))
    assert "Trading: ■ DISABLED  2026-10-05T11:00:00Z a single trade lost $0.0800" in off
    assert "npm run enable-trading" in off
    assert "Doing:   disabled: a single trade lost $0.0800" in off
    micro = render(live=live(mode="micro"))
    assert "● RUNNING  (MICRO, tiny real trades via jito)" in micro
    assert "Test:" not in micro
    assert "         Insufficient real execution sample: 0 MICRO trades landed (need 20)" in micro
    ready = render(verdict={"micro": {"ok": True, "reasons": []}, "live": {"ok": False, "reasons": ["x"]}})
    assert "Go live? MICRO: YES  LIVE: NO" in ready


def test_pause_reason_and_extras():
    assert "Doing:   paused: daily loss limit reached" in render(live=live(state="paused", note="daily loss limit reached"))
    text = render(live=live(scansLastMin=7, jupiterLimit=60, jupiterUsed=41, quoteMs=380, focus=["WIF"],
                            events={"watching": 3, "eventsToday": 12345, "capped": False, "tooBusy": 1, "cap": 60000},
                            funnelToday={"quoted": 4, "executable": 1},
                            lastOpp={"id": "opp_1", "symbol": "WIF", "stage": "quoted", "result": "stale", "totalMs": 812, "quotedBps": 22.04, "execBps": -3.1}))
    assert "Speed:   7 scans in the last minute  (Jupiter: 41/60 requests used per minute)" in text
    assert "Events:  watching 3 pool(s), 12,345 / 60,000 updates today  (1 too-busy pool(s) resting)" in text
    assert "Focus:   WIF" in text
    assert "Prices:  watching 28 tokens every 15s" in render(live=live(priceWatch={"tokens": 28, "everyMs": 15_000}))
    pred = render(live=live(gapPredict={"n": 140, "skillPct": 12.4, "used": True},
                            trend={"predictions": 950, "accuracyPct": 81.2, "baseAccuracyPct": 80.0, "open": 1, "trades": 7,
                                   "netUsd": -0.0123, "horizonMin": 15, "top": [["WIF", 0.62], ["JUP", 0.31]], "tokens": 20, "watching": 25}))
    assert "Predict: gaps: 140 re-checks scored, 12% better than the average (used to decide)" in pred
    assert "Trend:   950 price predictions checked, right 81% (always 'no': 80%); paper: 1 open, 7 closed, -$0.0123 (paper only)" in pred
    assert "chance of rising more than costs in 15 min: WIF 62%, JUP 31%" in pred
    early = render(live=live(trend={"predictions": 0, "tokens": 3, "watching": 25}))
    assert "Trend:   collecting 1-minute prices; 3 of 25 tokens have the hour of history predictions need (paper only)" in early
    assert "Funnel:  quoted 4 → executable 1 → simulated 0" in text
    assert 'Latest:  opp_1 WIF quoted 22.0bps → fresh -3.1bps → stale at "quoted" (812 ms)' in text


def test_bars_and_durations():
    assert bar(0.5, 10) == "█████░░░░░"
    assert bar(2, 4) == "████"
    assert duration(45_000) == "45s"
    assert duration(3 * 86_400_000 + 3600_000) == "3d 1h"


def test_mix_thoughts():
    assert mix_thoughts(["b1", "b2", "b3"], ["g1"]) == ["b1", "g1", "b2", "b3"]


def test_gather_status_from_data_folder(tmp_path):
    from arbbot.config import load_config
    cfg = load_config({"DATA_DIR": str(tmp_path)})
    (tmp_path / "bot.log").write_text("noise\n[x] Started in PAPER mode\n[y] scan line\n")
    (tmp_path / "trades-paper.jsonl").write_text(json.dumps({"ts": NOW, "mode": "paper", "symbol": "SOL", "status": "rejected", "netUsd": 0, "basis": "simulated"}) + "\n")
    d = gather_status(cfg, NOW)
    assert d["live"] is None and d["processAlive"] is False
    assert d["events"] == ["[x] Started in PAPER mode"]
    assert d["results"]["fake"] == 1
    assert d["verdict"]["micro"]["ok"] is False
    json.dumps(d)  # plain JSON for the status server
    assert "NOT STARTED YET" in render_status(d, NOW, False)


# ---- status server ------------------------------------------------------------------

TOKEN = "s3cret-status-token-123"
DATA = base(live=live(pid=1, cycles=42, startedAt=NOW - 3_600_000, updatedAt=NOW - 1_000, onChainTesting=False, solPrice=150,
                      hot=[], nextScanInMs=5_000), verdict=None, edgeHistogram={}, thoughts=[], events=[])


def test_server_settings():
    assert check_server_options(ServerOptions("127.0.0.1", 8787)) is None
    assert "set STATUS_HTTP_TOKEN" in check_server_options(ServerOptions("0.0.0.0", 8787))
    assert "at least 16" in check_server_options(ServerOptions("0.0.0.0", 8787, "short"))
    assert check_server_options(ServerOptions("0.0.0.0", 8787, TOKEN)) is None
    assert "port number" in check_server_options(ServerOptions("127.0.0.1", 70_000))


def with_server(token, fn):
    stops = []

    async def run():
        srv = StatusServer(ServerOptions("127.0.0.1", 0, token),
                           ServerDeps(status=lambda: DATA, report=lambda: "REPORT TEXT", stop_trading=stops.append, now=lambda: NOW))
        port = await srv.start()
        try:
            async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}") as c:
                await fn(c, f"http://127.0.0.1:{port}")
        finally:
            await srv.close()

    asyncio.run(run())
    return stops


def test_server_needs_token():
    async def fn(c, base_url):
        assert (await c.get("/status.json")).status_code == 401
        assert (await c.get("/status.json?token=wrong-token-wrong-token")).status_code == 401
        r = await c.get("/status.json", headers={"authorization": f"Bearer {TOKEN}"})
        assert r.status_code == 200 and r.json()["live"]["cycles"] == 42
        assert (await c.get(f"/report.txt?token={TOKEN}")).text == "REPORT TEXT"
        page = (await c.get(f"/?token={TOKEN}")).text
        assert "RUNNING" in page and "Emergency stop" in page and 'http-equiv="refresh"' in page
        assert (await fetch_remote_status(base_url, TOKEN))["live"]["cycles"] == 42
        with pytest.raises(RuntimeError, match=r"401 \(check ENGINE_TOKEN\)"):
            await fetch_remote_status(base_url, "nope-nope-nope-nope")

    with_server(TOKEN, fn)


def test_server_stops_but_never_starts():
    async def fn(c, _):
        assert (await c.get(f"/stop-trading?token={TOKEN}")).status_code == 405
        assert (await c.post("/stop-trading")).status_code == 401
        r = await c.post("/stop-trading", headers={"authorization": f"Bearer {TOKEN}"})
        assert r.json() == {"ok": True, "disabled": True}
        for path in ("/enable-trading", "/start", "/settings"):
            assert (await c.post(f"{path}?token={TOKEN}")).status_code == 404
        assert (await c.post(f"/status.json?token={TOKEN}")).status_code == 405
        html = await c.post(f"/stop-trading?token={TOKEN}", headers={"accept": "text/html"})
        assert "Trading disabled. Re-enable on the phone" in html.text

    stops = with_server(TOKEN, fn)
    assert len(stops) == 2
    assert "stopped from the status page (127.0.0.1)" == stops[0]


def test_server_without_token_on_this_device():
    async def fn(c, _):
        assert (await c.get("/status.json")).status_code == 200

    with_server(None, fn)


def test_token_kept_out_of_logs():
    assert redact(f"GET http://192.168.1.5:8787/?token={TOKEN}&x=1") == "GET http://192.168.1.5:8787/?token=***&x=1"
    assert redact(f"authorization: Bearer {TOKEN}") == "authorization: Bearer ***"
