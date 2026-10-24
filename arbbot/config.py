"""Every setting, read from .env (and the environment), with validation."""

import math
import os
from dataclasses import dataclass, field

from .secret_checks import signing_key_from

USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDC_DECIMALS = 6
SOL_MINT = "So11111111111111111111111111111111111111112"

#: Liquid tokens worth scanning by default. Override with TOKENS=SYMBOL:mint,...
DEFAULT_TOKENS: dict[str, str] = {
    "SOL": SOL_MINT,
    "JUP": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    "BONK": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    "WIF": "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
    "JTO": "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
    "RAY": "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
}

# paper: nothing is ever signed or sent (quote-only, or simulated on-chain
#        when WALLET_PUBLIC_KEY is set).
# micro: real transactions with a hard tiny size cap, to prove execution.
# live:  adaptive sizing; refused at startup unless MICRO results pass the gate.
MODES = ("paper", "micro", "live")
REAL_MONEY_MODES = ("micro", "live")


def is_real_money(mode: str) -> bool:
    return mode in REAL_MONEY_MODES


#: Tokens quoted per scan; each needs 2 Jupiter requests (buy leg + sell leg).
TOKENS_PER_SCAN = 3
REQUESTS_PER_SCAN = TOKENS_PER_SCAN * 2

# Jupiter's limits (per minute, across all its APIs): 30 without a key, 60 with
# a free key. lite-api.jup.ag is keyless-only and being retired, so with a key
# the bot uses api.jup.ag, which reads the key from `x-api-key`.
JUPITER_KEYLESS_RPM = 30
JUPITER_FREE_KEY_RPM = 60
#: Room left each minute for requests outside scans (SOL price, token list).
EXTRA_REQUESTS_PER_MIN = 2


def jupiter_rate_windows(requests_per_minute: int) -> list[tuple[int, int]]:
    """
    Limits the bot holds itself to, as (window ms, limit). Besides the
    per-minute window (2 requests of slack), any 10 seconds get at most a sixth
    of the per-minute limit minus 1: a "too many requests" seen at ~43/min with
    bursts suggests short bursts count too.
    """
    return [
        (60_000, max(1, requests_per_minute - 2)),
        (10_000, max(2, requests_per_minute // 6 - 1)),
    ]


def jupiter_ms_per_request(requests_per_minute: int) -> int:
    """Even spacing per request that fits every window: 60/min -> ~1.11 s; 30/min -> 2.5 s."""
    usable = requests_per_minute - EXTRA_REQUESTS_PER_MIN
    if usable <= 0:
        return 60_000
    per10s = jupiter_rate_windows(requests_per_minute)[1][1]
    return max(math.ceil(60_000 / usable), math.ceil(10_000 / per10s))


def max_scans_per_min(ms_per_request: float, requests_per_scan: int = REQUESTS_PER_SCAN) -> float:
    return 60_000 / (ms_per_request * requests_per_scan)


def _jupiter_url(configured: str | None, fallback_path: str, api_key: str | None) -> str:
    """lite-api ignores API keys, so a key only helps on api.jup.ag."""
    host = "https://api.jup.ag" if api_key else "https://lite-api.jup.ag"
    url = (configured or f"{host}{fallback_path}").rstrip("/")
    return url.replace("://lite-api.jup.ag", "://api.jup.ag") if api_key else url


def load_dotenv(path: str = ".env", env: dict | None = None) -> None:
    """Reads KEY=value lines into the environment without overriding what is already set."""
    target = os.environ if env is None else env
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[7:]
            key, value = line.split("=", 1)
            key, value = key.strip(), value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            elif " #" in value:
                value = value.split(" #", 1)[0].rstrip()
            if key and key not in target:
                target[key] = value


def _num(env: dict, key: str, fallback: float) -> float:
    raw = env.get(key)
    if raw is None or raw == "":
        return fallback
    try:
        n = float(raw)
    except ValueError:
        raise ValueError(f'{key} must be a number, got "{raw}"') from None
    if not math.isfinite(n):
        raise ValueError(f'{key} must be a number, got "{raw}"')
    return int(n) if n.is_integer() else n


def parse_pairs(raw: str | None) -> dict[str, str]:
    """Parses "name:value,name:value" into a dict."""
    out: dict[str, str] = {}
    for part in (raw or "").split(","):
        bits = [s.strip() for s in part.split(":")]
        if len(bits) >= 2 and bits[0] and bits[1]:
            out[bits[0]] = bits[1]
    return out


@dataclass
class Config:
    mode: str
    rpc_url: str
    rpc_ws_url: str | None
    jupiter_api: str
    jupiter_api_key: str | None
    jupiter_rpm: int
    signing_key: str | None
    wallet_public_key: str | None
    micro_max_trade_usd: float
    send_via: str
    jito_url: str
    jito_tip_lamports: int
    jito_max_tip_lamports: int
    jito_tip_share: float
    safety_buffer_bps: float
    safety_buffer_usd: float
    max_slippage_bps: int
    landing_timeout_ms: int
    min_expected_profit_usd: float
    landing_prior: float
    max_price_impact_bps: float
    size_ladder_usd: list[float]
    max_ladder_points: int
    tokens: dict[str, str]
    trade_size_pct: float
    max_trade_usd: float
    min_profit_bps: float
    priority_fee_lamports: int
    compute_unit_limit: int
    starting_balance_usd: float
    loss_floor_usd: float
    daily_loss_limit_usd: float
    max_consecutive_failures: int
    max_consecutive_losses: int
    unexpected_loss_usd: float
    gate_micro_min_trades: int
    gate_micro_min_profitable_rate: float
    gate_min_paper_days: float
    gate_min_simulated: int
    gate_min_sim_success_rate: float
    failure_cooldown_ms: int
    scan_interval_ms: int
    min_scan_interval_ms: int
    jupiter_ms_per_request: int
    monthly_costs_usd: dict[str, float]
    sustain_stop_after_months: int
    token_discovery: bool
    jupiter_tokens_api: str
    max_tokens: int
    min_token_liquidity_usd: float
    min_token_holders: int
    min_pool_age_days: float
    max_top_holders_pct: float
    live_tokens: list[str]
    event_triggers: bool
    max_watched_pools: int
    event_daily_cap: int
    event_debounce_ms: int
    busy_pool_per_min: int
    triangles: bool
    triangle_pivot: str
    triangle_every: int
    probes: bool
    probe_min_bps: float
    probes_per_hour: int
    status_http_port: int | None
    status_http_host: str
    status_http_token: str | None
    telegram_bot_token: str | None
    telegram_chat_id: str | None
    data_dir: str
    extra: dict = field(default_factory=dict)


def load_config(env: dict | None = None) -> Config:
    if env is None:
        load_dotenv()
        env = dict(os.environ)
    mode = env.get("MODE") if env.get("MODE") in MODES else "paper"
    signing_key = signing_key_from(env)
    if is_real_money(mode) and env.get("LIVE_TRADING_CONFIRM") != "yes":
        raise ValueError(f"MODE={mode} also requires LIVE_TRADING_CONFIRM=yes (real money will be traded)")
    if is_real_money(mode) and not signing_key:
        raise ValueError(f"MODE={mode} requires PRIVATE_SIGNING_KEY (base58) of a fresh, dedicated wallet")

    n = lambda k, d: _num(env, k, d)  # noqa: E731
    starting = n("STARTING_BALANCE_USD", 25)
    send_via = "rpc" if env.get("SEND_VIA") == "rpc" else "jito"
    key = (env.get("JUPITER_API_KEY") or "").strip() or None
    rpm = int(n("JUPITER_RPM", JUPITER_FREE_KEY_RPM if key else JUPITER_KEYLESS_RPM))
    ladder = []
    for x in (env.get("SIZE_LADDER_USD") or "10,25,50,100,250,500,750,1000,1500,2000,3000,5000").split(","):
        try:
            v = float(x.strip())
        except ValueError:
            continue
        if math.isfinite(v) and v > 0:
            ladder.append(int(v) if v.is_integer() else v)
    floor_default = round(starting * n("LOSS_FLOOR_PCT", 0.7), 2)

    cfg = Config(
        mode=mode,
        rpc_url=env.get("RPC_URL") or "https://api.mainnet-beta.solana.com",
        rpc_ws_url=env.get("RPC_WS_URL") or None,
        jupiter_api=_jupiter_url(env.get("JUPITER_API"), "/swap/v1", key),
        jupiter_api_key=key,
        jupiter_rpm=rpm,
        signing_key=signing_key,
        wallet_public_key=(env.get("WALLET_PUBLIC_KEY") or "").strip() or None,
        micro_max_trade_usd=n("MICRO_MAX_TRADE_USD", 5),
        send_via=send_via,
        jito_url=(env.get("JITO_URL") or "https://mainnet.block-engine.jito.wtf/api/v1").rstrip("/"),
        jito_tip_lamports=int(n("JITO_TIP_LAMPORTS", 1_000)),
        jito_max_tip_lamports=int(n("JITO_MAX_TIP_LAMPORTS", 2_000_000)),
        jito_tip_share=n("JITO_TIP_SHARE", 0.25),
        safety_buffer_bps=n("SAFETY_BUFFER_BPS", 3),
        safety_buffer_usd=n("SAFETY_BUFFER_USD", 0.001),
        max_slippage_bps=int(n("MAX_SLIPPAGE_BPS", 100)),
        landing_timeout_ms=int(n("LANDING_TIMEOUT_MS", 120_000)),
        min_expected_profit_usd=n("MIN_EXPECTED_PROFIT_USD", 0.001),
        landing_prior=n("LANDING_PRIOR", 0.5),
        max_price_impact_bps=n("MAX_PRICE_IMPACT_BPS", 100),
        size_ladder_usd=sorted(ladder),
        max_ladder_points=max(1, int(n("MAX_LADDER_POINTS", 4))),
        tokens=parse_pairs(env.get("TOKENS")) if env.get("TOKENS") else dict(DEFAULT_TOKENS),
        # Maximum capital exposure per trade (share of USDC on hand). TRADE_SIZE_PCT is the older name.
        trade_size_pct=_num(env, "MAX_EXPOSURE_PCT", n("TRADE_SIZE_PCT", 0.8)),
        max_trade_usd=n("MAX_TRADE_USD", 0),
        min_profit_bps=n("MIN_PROFIT_BPS", 20),
        # Through Jito the tip does the work, so the priority fee can be tiny.
        priority_fee_lamports=int(n("PRIORITY_FEE_LAMPORTS", 1_000 if send_via == "jito" else 10_000)),
        compute_unit_limit=int(n("COMPUTE_UNIT_LIMIT", 600_000)),
        starting_balance_usd=starting,
        loss_floor_usd=n("LOSS_FLOOR_USD", floor_default),
        daily_loss_limit_usd=n("DAILY_LOSS_LIMIT_USD", 2),
        max_consecutive_failures=int(n("MAX_CONSECUTIVE_FAILURES", 5)),
        max_consecutive_losses=int(n("MAX_CONSECUTIVE_LOSSES", 3)),
        unexpected_loss_usd=n("UNEXPECTED_LOSS_USD", 0.05),
        gate_micro_min_trades=int(n("GATE_MICRO_MIN_TRADES", 20)),
        gate_micro_min_profitable_rate=n("GATE_MICRO_MIN_PROFITABLE_RATE", 0.7),
        gate_min_paper_days=n("GATE_MIN_PAPER_DAYS", 3),
        gate_min_simulated=int(n("GATE_MIN_SIMULATED", 30)),
        gate_min_sim_success_rate=n("GATE_MIN_SIM_SUCCESS_RATE", 0.3),
        failure_cooldown_ms=int(n("FAILURE_COOLDOWN_MS", 10 * 60_000)),
        scan_interval_ms=int(n("SCAN_INTERVAL_MS", 5_000)),
        min_scan_interval_ms=int(n("MIN_SCAN_INTERVAL_MS", 1_000)),
        jupiter_ms_per_request=jupiter_ms_per_request(rpm),
        monthly_costs_usd={k: float(v) for k, v in parse_pairs(env.get("MONTHLY_COSTS_USD") or "server:0,rpc:0").items()},
        sustain_stop_after_months=int(n("SUSTAIN_STOP_AFTER_MONTHS", 2)),
        token_discovery=env.get("TOKEN_DISCOVERY") != "off",
        jupiter_tokens_api=_jupiter_url(env.get("JUPITER_TOKENS_API"), "/tokens/v2", key),
        max_tokens=int(n("MAX_TOKENS", 12)),
        min_token_liquidity_usd=n("MIN_TOKEN_LIQUIDITY_USD", 1_000_000),
        min_token_holders=int(n("MIN_TOKEN_HOLDERS", 1_000)),
        min_pool_age_days=n("MIN_POOL_AGE_DAYS", 7),
        max_top_holders_pct=n("MAX_TOP_HOLDERS_PCT", 60),
        live_tokens=[x.strip() for x in (env.get("LIVE_TOKENS") or "").split(",") if x.strip()],
        event_triggers=env.get("EVENT_TRIGGERS") != "off",
        max_watched_pools=int(n("MAX_WATCHED_POOLS", 4)),
        event_daily_cap=int(n("EVENT_DAILY_CAP", 20_000)),
        event_debounce_ms=int(n("EVENT_DEBOUNCE_MS", 1_500)),
        busy_pool_per_min=int(n("BUSY_POOL_EVENTS_PER_MIN", 30)),
        triangles=env.get("TRIANGLES") != "off",
        triangle_pivot=env.get("TRIANGLE_PIVOT") or "SOL",
        triangle_every=max(2, int(n("TRIANGLE_EVERY", 4))),
        probes=env.get("PROBES") != "off",
        probe_min_bps=n("PROBE_MIN_BPS", 0),
        probes_per_hour=max(0, int(n("PROBES_PER_HOUR", 30))),
        status_http_port=int(n("STATUS_HTTP_PORT", 0)) if env.get("STATUS_HTTP_PORT") else None,
        status_http_host=env.get("STATUS_HTTP_HOST") or "127.0.0.1",
        status_http_token=env.get("STATUS_HTTP_TOKEN") or None,
        telegram_bot_token=env.get("TELEGRAM_BOT_TOKEN") or None,
        telegram_chat_id=env.get("TELEGRAM_CHAT_ID") or None,
        data_dir=env.get("DATA_DIR") or "./data",
    )

    if not (0 < cfg.trade_size_pct <= 1):
        raise ValueError("TRADE_SIZE_PCT must be in (0, 1]")
    if not (0 <= cfg.jito_tip_share < 1):
        raise ValueError("JITO_TIP_SHARE must be in [0, 1)")
    if cfg.jito_max_tip_lamports < cfg.jito_tip_lamports:
        raise ValueError("JITO_MAX_TIP_LAMPORTS must be >= JITO_TIP_LAMPORTS")
    if not (0 < cfg.micro_max_trade_usd <= 25):
        raise ValueError("MICRO_MAX_TRADE_USD must be between 0 and 25 (MICRO is for tiny proof trades)")
    if cfg.loss_floor_usd >= cfg.starting_balance_usd:
        raise ValueError("LOSS_FLOOR_USD must be below STARTING_BALANCE_USD")
    return cfg


def trade_size_usd(cfg: Config, usdc_balance_usd: float) -> float:
    """
    USD to put into the next trade: a share of the USDC on hand (compounding),
    optionally capped. Both legs settle in one atomic transaction, so the
    position is never left half-open.
    """
    size = usdc_balance_usd * cfg.trade_size_pct
    capped = min(size, cfg.max_trade_usd) if cfg.max_trade_usd > 0 else size
    return math.floor(capped * 100) / 100


def extra_fee_lamports(cfg: Config) -> int:
    """Minimum a landed trade pays on top of the 5000-lamport base fee (priority + minimum tip)."""
    return cfg.priority_fee_lamports + (cfg.jito_tip_lamports if cfg.send_via == "jito" else 0)
