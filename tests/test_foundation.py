import json
import os

import pytest

from arbbot.atomic import read_json_with_backup, write_json_atomic
from arbbot.config import (
    jupiter_ms_per_request,
    jupiter_rate_windows,
    load_config,
    load_dotenv,
    max_scans_per_min,
    trade_size_usd,
)
from arbbot.jsonl import JsonlReader
from arbbot.killswitch import disable_trading, enable_trading, halted, trading_disabled
from arbbot.ledger import Ledger, basis_of, totals_by_basis
from arbbot.log import make_repeat_filter, redact
from arbbot.profit import required_out_atoms, slippage_for_floor, usd_to_usdc_atoms
from arbbot.secret_checks import check_secrets, looks_like_seed_phrase
from arbbot.solana.keys import Keypair
from arbbot.sustain import month_verdict, should_retire
from arbbot.util import iso, start_of_utc_day, start_of_utc_month

KP = Keypair.generate()
SECRET, PUB = KP.secret_base58(), KP.public_key
SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident"


def ms(text: str) -> int:
    from datetime import datetime

    return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)


# --- config -------------------------------------------------------------------

def test_jupiter_settings_without_and_with_a_key():
    cfg = load_config({})
    assert cfg.jupiter_api == "https://lite-api.jup.ag/swap/v1"
    assert cfg.jupiter_tokens_api == "https://lite-api.jup.ag/tokens/v2"
    assert cfg.jupiter_rpm == 30 and cfg.jupiter_ms_per_request == 2_500
    assert max_scans_per_min(cfg.jupiter_ms_per_request) == pytest.approx(4, abs=0.01)
    k = load_config({"JUPITER_API_KEY": " my-key \n"})
    assert k.jupiter_api_key == "my-key" and k.jupiter_api == "https://api.jup.ag/swap/v1"
    assert k.jupiter_rpm == 60 and k.jupiter_ms_per_request == 1_112
    assert max_scans_per_min(k.jupiter_ms_per_request) == pytest.approx(8.99, abs=0.01)
    assert load_config({"JUPITER_API": "https://lite-api.jup.ag/swap/v1/", "JUPITER_API_KEY": "k"}).jupiter_api == "https://api.jup.ag/swap/v1"
    assert load_config({"JUPITER_API": "http://127.0.0.1:9/swap/v1", "JUPITER_API_KEY": "k"}).jupiter_api == "http://127.0.0.1:9/swap/v1"


def test_rate_windows_and_paid_plans():
    assert jupiter_ms_per_request(600) == 102
    assert jupiter_ms_per_request(2) == 60_000
    assert jupiter_rate_windows(60) == [(60_000, 58), (10_000, 9)]
    assert jupiter_rate_windows(30) == [(60_000, 28), (10_000, 4)]
    assert load_config({"MIN_SCAN_INTERVAL_MS": "3000"}).min_scan_interval_ms == 3_000


def test_modes_need_explicit_confirmation_and_a_key():
    assert load_config({}).mode == "paper"
    with pytest.raises(ValueError, match="LIVE_TRADING_CONFIRM"):
        load_config({"MODE": "micro"})
    with pytest.raises(ValueError, match="PRIVATE_SIGNING_KEY"):
        load_config({"MODE": "micro", "LIVE_TRADING_CONFIRM": "yes"})
    micro = load_config({"MODE": "micro", "LIVE_TRADING_CONFIRM": "yes", "PRIVATE_SIGNING_KEY": SECRET})
    assert micro.mode == "micro" and micro.micro_max_trade_usd == 5
    assert load_config({"MODE": "Live"}).mode == "paper"  # unknown spelling falls back to safe paper
    assert load_config({"WALLET_SECRET_KEY": SECRET}).signing_key == SECRET
    assert load_config({"STARTING_BALANCE_USD": "100", "LOSS_FLOOR_PCT": "0.8"}).loss_floor_usd == 80
    with pytest.raises(ValueError, match="must be a number"):
        load_config({"MIN_PROFIT_BPS": "lots"})


def test_old_and_new_setting_names_and_trade_size():
    assert load_config({"TRADE_SIZE_PCT": "0.5"}).trade_size_pct == 0.5
    assert load_config({"MAX_EXPOSURE_PCT": "0.3", "TRADE_SIZE_PCT": "0.5"}).trade_size_pct == 0.3
    cfg = load_config({"MAX_TRADE_USD": "10"})
    assert trade_size_usd(cfg, 25) == 10
    assert trade_size_usd(load_config({}), 25.999) == 20.79


def test_dotenv_reading(tmp_path):
    p = tmp_path / ".env"
    p.write_text('# comment\nA=1\nexport B="two words"\nC=x # note\nD=keep\n')
    env = {"D": "already"}
    load_dotenv(str(p), env)
    assert env == {"A": "1", "B": "two words", "C": "x", "D": "already"}


# --- secrets and logs -----------------------------------------------------------

def test_seed_phrases_and_key_mixups_are_refused():
    assert looks_like_seed_phrase(SEED)
    assert not looks_like_seed_phrase("wallet needs at least one dollar")
    assert "SEED PHRASE" in check_secrets({"SOMETHING": SEED}).errors[0]
    r = check_secrets({"WALLET_PUBLIC_KEY": SECRET})
    assert "WALLET_PUBLIC_KEY holds a SECRET key" in r.errors[0]
    assert SECRET not in " ".join(r.errors)
    assert "PUBLIC address" in check_secrets({"PRIVATE_SIGNING_KEY": PUB}).errors[0]
    other = Keypair.generate().public_key
    assert "does not belong" in check_secrets({"PRIVATE_SIGNING_KEY": SECRET, "WALLET_PUBLIC_KEY": other}, mode="micro").errors[0]
    assert check_secrets({"PRIVATE_SIGNING_KEY": SECRET, "WALLET_PUBLIC_KEY": PUB}, mode="micro").errors == []


def test_paper_mode_signing_key_and_readable_env_warnings(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("x=1")
    os.chmod(env_file, 0o644)
    r = check_secrets({"WALLET_SECRET_KEY": SECRET}, mode="paper", env_file_path=str(env_file))
    assert r.errors == []
    assert "paper mode never signs" in "\n".join(r.warnings)
    assert "chmod 600" in "\n".join(r.warnings)


def test_log_redaction():
    line = (
        "fetch https://mainnet.helius-rpc.com/?api-key=fa4e0000-test-0000-0000-notarealkey1 failed; "
        'headers {"x-api-key":"abc123"} key jup_00000000deadbeef00000000deadbeef '
        "tg https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage "
        f"secret {SECRET} bytes [{','.join(str(b) for b in range(64))}] wallet {PUB} "
        "page http://1.2.3.4:8787/?token=abcdefghijklmnop1234 auth Bearer abcdefghijklmnop1234"
    )
    out = redact(line)
    for s in ["fa4e0000", "abc123", "deadbeef", "AAHdqTcvCH1v", SECRET, "abcdefghijklmnop1234"]:
        assert s not in out
    assert "[REDACTED-SECRET-KEY]" in out and "[REDACTED-KEY-BYTES]" in out
    assert PUB in out  # public addresses stay readable
    assert redact("best SOL $20.00: quoted net -0.8bps") == "best SOL $20.00: quoted net -0.8bps"


def test_websocket_error_spam_is_rate_limited():
    t = [0]
    f = make_repeat_filter(60_000, lambda: t[0])
    assert f("ws error: connect ECONNREFUSED").startswith("ws error: connect ECONNREFUSED [WebSocket unreachable")
    t[0] += 1_000
    assert f("ws error: connect ECONNREFUSED") is None
    t[0] += 1_000
    assert f("ws error: x") is None
    assert f("best SOL") == "best SOL"
    t[0] += 60_000
    assert "(2 similar hidden)" in f("ws error: x")


# --- files ----------------------------------------------------------------------

def test_crash_safe_json(tmp_path):
    p = str(tmp_path / "state.json")
    write_json_atomic(p, {"v": 1}, backup=True)
    write_json_atomic(p, {"v": 2}, backup=True)
    assert read_json_with_backup(p) == ({"v": 2}, False)
    with open(p, "w") as f:
        f.write('{"v": 3, "half-writ')
    assert read_json_with_backup(p) == ({"v": 1}, True)
    assert not os.path.exists(p + ".tmp")
    assert read_json_with_backup(str(tmp_path / "none.json")) is None


def test_ledger_bases_and_torn_lines(tmp_path):
    rec = lambda **o: {"ts": 1, "mode": "paper", "symbol": "SOL", "status": "filled", "inUsd": 10, "netUsd": 0.01, "feeUsd": 0.001, **o}  # noqa: E731
    assert basis_of(rec()) == "quoted"
    assert basis_of(rec(verified=True)) == "simulated"
    assert basis_of(rec(mode="live", verified=True)) == "realized"
    assert basis_of(rec(mode="micro")) == "realized"
    t = totals_by_basis([rec(netUsd=0.05), rec(verified=True, netUsd=-0.01), rec(status="skipped")])
    assert t["quoted"] == {"count": 1, "wins": 1, "netUsd": 0.05}
    assert t["simulated"] == {"count": 1, "wins": 0, "netUsd": -0.01}
    assert t["realized"]["count"] == 0
    p = tmp_path / "trades.jsonl"
    p.write_text(json.dumps(rec(netUsd=1)) + "\n" + '{"ts": 2, "mo')
    l = Ledger(str(p))
    assert len(l.all()) == 1
    l.append(rec(netUsd=2, verified=True))
    assert len(l.all()) == 2
    assert l.pnl_between(0, bases=["simulated"]) == 2
    assert len(Ledger.read(str(p))) == 2


def test_incremental_reader(tmp_path):
    p = tmp_path / "opps.jsonl"
    r = JsonlReader(str(p))
    assert r.read() == []
    p.write_text('{"id":"a"}\n{"id":"b"}\n')
    assert [x["id"] for x in r.read()] == ["a", "b"]
    with open(p, "a") as f:
        f.write('{"id":"c"')
    assert len(r.read()) == 2
    with open(p, "a") as f:
        f.write("}\n")
    assert [x["id"] for x in r.read()] == ["a", "b", "c"]
    p.write_text('{"id":"z"}\n')
    assert [x["id"] for x in r.read()] == ["z"]


def test_kill_switch(tmp_path):
    d = str(tmp_path)
    assert trading_disabled(d) is None and enable_trading(d) is False
    nested = os.path.join(d, "nested")
    disable_trading(nested, "unexpected loss", ms("2026-10-05T10:00:00Z"))
    assert trading_disabled(nested) == "2026-10-05T10:00:00.000Z unexpected loss"
    assert enable_trading(nested) is True and trading_disabled(nested) is None
    assert halted(d) is None


# --- money helpers --------------------------------------------------------------

def test_floor_math():
    assert usd_to_usdc_atoms(0.0000005) == 1  # rounds half up, like the TypeScript version
    required = required_out_atoms(usd_to_usdc_atoms(10), 0.003, 20)
    assert required == usd_to_usdc_atoms(10.023)
    quoted = usd_to_usdc_atoms(10.05)
    slip = slippage_for_floor(quoted, required)
    assert quoted * (10_000 - slip) // 10_000 >= required
    assert slippage_for_floor(usd_to_usdc_atoms(10), required) is None


def test_bills_verdicts():
    t = lambda d, n: {"ts": ms(d), "mode": "paper", "symbol": "SOL", "status": "filled", "inUsd": 10, "netUsd": n, "feeUsd": 0.002}  # noqa: E731
    costs = {"server": 0, "rpc": 1}
    v = month_verdict([t("2026-09-03T00:00:00Z", 0.7), t("2026-09-20T00:00:00Z", 0.5)], ms("2026-09-01T00:00:00Z"), costs)
    assert v["paidItsWay"] and v["surplusUsd"] == pytest.approx(0.2)
    recs = [t("2026-08-02T00:00:00Z", 0.1), t("2026-09-02T00:00:00Z", 0.1)]
    now = ms("2026-10-01T00:00:00Z")
    assert should_retire(recs, now, costs, 2, recs[0]["ts"]) is True
    assert should_retire(recs, now, costs, 3, recs[0]["ts"]) is False


def test_time_helpers():
    t = ms("2026-10-05T13:45:10.123Z")
    assert iso(t) == "2026-10-05T13:45:10.123Z"
    assert start_of_utc_day(t) == ms("2026-10-05T00:00:00Z")
    assert start_of_utc_month(t) == ms("2026-10-01T00:00:00Z")
    assert start_of_utc_month(t, -10) == ms("2025-12-01T00:00:00Z")
    assert start_of_utc_month(t, 3) == ms("2027-01-01T00:00:00Z")


def test_everything_printed_is_redacted(capsys):
    import sys

    from arbbot.log import RedactingStream

    stream = RedactingStream(sys.stdout)
    stream.write("RPC https://mainnet.helius-rpc.com/?api-key=abcd1234efgh5678\n")
    assert "abcd1234" not in capsys.readouterr().out
