"""
Token safety. Every token gets a state before the bot may touch it:

  BLOCKED       never quoted: the token can behave differently from what
                quotes assume (transfer fees or hooks, a permanent delegate,
                frozen-by-default or paused accounts, not a token at all)
  WATCH         quoted to learn, never acted on (a discovered token with an
                issuer who can freeze or mint, thin liquidity, few holders,
                a brand-new pool, or a few wallets holding most of it)
  PAPER_ONLY    paper trading only (discovered tokens unless allowlisted in
                LIVE_TOKENS; configured tokens until checked on-chain)
  LIVE_ALLOWED  may be traded with real money

Trades are atomic round trips (the bot never holds a token between
transactions), so the main dangers are tokens whose transfers don't behave
like the quote says, and thin or fake markets. On-chain facts come from the
mint account (one batched RPC call, re-checked daily) and are cached in
data/token-safety.json (same format as the TypeScript bot); market facts come
from Jupiter's token list.

Mint facts are camelCase dicts: program ("spl-token" | "spl-token-2022" |
"other" | "missing" | "invalid"), mintAuthority, freezeAuthority, decimals,
extensions, transferFeeBps, transferHookProgram, permanentDelegate,
defaultFrozen, paused. Market facts: liquidityUsd, holders, poolCreatedAt,
topHoldersPct, verified (any may be missing).
"""

from dataclasses import dataclass, field

from .atomic import read_json_with_backup, write_json_atomic
from .solana.keys import is_valid_address
from .util import js_round, js_str, now_ms, to_fixed

STATES = ["BLOCKED", "WATCH", "PAPER_ONLY", "LIVE_ALLOWED"]


@dataclass
class SafetyThresholds:
    min_liquidity_usd: float
    min_holders: int
    min_pool_age_days: float
    max_top_holders_pct: float

    @staticmethod
    def from_config(cfg) -> "SafetyThresholds":
        return SafetyThresholds(cfg.min_token_liquidity_usd, cfg.min_token_holders, cfg.min_pool_age_days, cfg.max_top_holders_pct)


@dataclass
class SafetyVerdict:
    state: str
    reasons: list[str] = field(default_factory=list)


#: Extensions that don't change how a plain transfer or swap behaves.
HARMLESS_EXTENSIONS = {
    "metadataPointer",
    "tokenMetadata",
    "groupPointer",
    "tokenGroup",
    "groupMemberPointer",
    "tokenGroupMember",
    "mintCloseAuthority",
    "interestBearingConfig",
    "scaledUiAmountConfig",
    "confidentialTransferMint",
    "confidentialTransferFeeConfig",
    "confidentialMintBurn",
}
#: Extensions judged by their state below.
JUDGED_EXTENSIONS = {"transferFeeConfig", "transferHook", "permanentDelegate", "defaultAccountState", "pausableConfig"}

DAY_MS = 86_400_000


def _none(program: str) -> dict:
    return {"program": program, "mintAuthority": None, "freezeAuthority": None, "extensions": []}


def _fee(cfg) -> float:
    try:
        return float((cfg or {}).get("transferFeeBasisPoints") or 0)
    except (TypeError, ValueError):
        return 0.0


def parse_mint_account(acc: dict | None) -> dict:
    """Reads a mint account as returned by getMultipleAccounts with jsonParsed encoding."""
    if not acc:
        return _none("missing")
    data = acc.get("data")
    if not isinstance(data, dict) or "parsed" not in data:
        return _none("other")
    program = data.get("program") if data.get("program") in ("spl-token", "spl-token-2022") else "other"
    parsed = data.get("parsed") if isinstance(data.get("parsed"), dict) else {}
    if program == "other" or parsed.get("type") != "mint":
        return _none("other")
    info = parsed.get("info") or {}
    exts = info.get("extensions") if isinstance(info.get("extensions"), list) else []
    facts = {
        "program": program,
        "mintAuthority": info["mintAuthority"] if isinstance(info.get("mintAuthority"), str) else None,
        "freezeAuthority": info["freezeAuthority"] if isinstance(info.get("freezeAuthority"), str) else None,
    }
    if isinstance(info.get("decimals"), int) and not isinstance(info.get("decimals"), bool):
        facts["decimals"] = info["decimals"]
    facts["extensions"] = [str(e.get("extension") if e.get("extension") is not None else "unknown") for e in exts]
    for e in exts:
        st = e.get("state") or {}
        name = e.get("extension")
        if name == "transferFeeConfig":
            facts["transferFeeBps"] = max(_fee(st.get("newerTransferFee")), _fee(st.get("olderTransferFee")))
        elif name == "transferHook":
            facts["transferHookProgram"] = st["programId"] if isinstance(st.get("programId"), str) else None
        elif name == "permanentDelegate":
            facts["permanentDelegate"] = st["delegate"] if isinstance(st.get("delegate"), str) else None
        elif name == "defaultAccountState":
            facts["defaultFrozen"] = st.get("accountState") == "frozen"
        elif name == "pausableConfig":
            facts["paused"] = st.get("paused") is True
    return facts


def _locale(x: float) -> str:
    """Number.toLocaleString("en-US"): thousands separators, up to 3 decimals."""
    if float(x).is_integer():
        return f"{int(x):,}"
    return f"{x:,.3f}".rstrip("0").rstrip(".")


def _hard_blocks(c: dict) -> list[str]:
    """Problems that make quotes untrustworthy for this token: never quoted."""
    out: list[str] = []
    program = c.get("program")
    exts = c.get("extensions") or []
    if program == "invalid":
        out.append("not a valid mint address")
    if program == "missing":
        out.append("mint account not found")
    if program == "other":
        out.append("not an SPL token mint")
    if (c.get("transferFeeBps") or 0) > 0:
        out.append(f"charges a {js_str(c['transferFeeBps'])}bps fee on every transfer")
    if c.get("transferHookProgram"):
        out.append("runs a transfer hook program on every transfer")
    if c.get("permanentDelegate"):
        out.append("has a permanent delegate that can move anyone's tokens")
    if c.get("defaultFrozen"):
        out.append("new token accounts start frozen")
    if c.get("paused"):
        out.append("transfers are paused")
    if "nonTransferable" in exts:
        out.append("is non-transferable")
    if "unparseableExtension" in exts:
        out.append("has an extension the RPC could not read")
    return out


def _soft_risks(c: dict, m: dict | None, now: float, t: SafetyThresholds) -> list[str]:
    """Issuer powers and market weaknesses: discovered tokens with any of these are only watched."""
    out: list[str] = []
    exts = c.get("extensions") or []
    m = m or {}
    if c.get("freezeAuthority"):
        out.append("issuer can freeze token accounts")
    if c.get("mintAuthority"):
        out.append("issuer can mint more")
    if "pausableConfig" in exts and not c.get("paused"):
        out.append("issuer can pause transfers")
    unknown = [
        e for e in exts
        if e not in HARMLESS_EXTENSIONS and e not in JUDGED_EXTENSIONS and e not in ("nonTransferable", "unparseableExtension")
    ]
    if unknown:
        out.append(f"unfamiliar token extension(s): {', '.join(unknown)}")
    if m.get("liquidityUsd") is not None and m["liquidityUsd"] < t.min_liquidity_usd:
        out.append(f"liquidity ${_locale(js_round(m['liquidityUsd']))} < ${_locale(t.min_liquidity_usd)}")
    if m.get("holders") is not None and m["holders"] < t.min_holders:
        out.append(f"only {js_str(m['holders'])} holders (want {js_str(t.min_holders)}+)")
    if m.get("poolCreatedAt") is not None:
        days = (now - m["poolCreatedAt"]) / DAY_MS
        if days < t.min_pool_age_days:
            out.append(f"first pool only {to_fixed(days, 1)} days old (want {js_str(t.min_pool_age_days)}+)")
    if m.get("topHoldersPct") is not None and m["topHoldersPct"] > t.max_top_holders_pct:
        out.append(f"top holders own {to_fixed(m['topHoldersPct'], 0)}% (want ≤ {js_str(t.max_top_holders_pct)}%)")
    return out


def classify_token(
    *, configured: bool, allowlisted: bool, chain: dict | None, now: float, t: SafetyThresholds, market: dict | None = None
) -> SafetyVerdict:
    """
    The state for one token. Configured tokens (the starting list or TOKENS)
    are trusted unless the chain shows a hard problem; discovered ones must
    also look healthy, and only an explicit LIVE_TOKENS entry lets them touch
    real money.
    """
    if not chain:
        return SafetyVerdict("PAPER_ONLY" if configured or allowlisted else "WATCH", ["not checked on-chain yet"])
    hard = _hard_blocks(chain)
    if hard:
        return SafetyVerdict("BLOCKED", hard)
    soft = _soft_risks(chain, market, now, t)
    if configured:
        return SafetyVerdict("LIVE_ALLOWED", [f"note: {r}" for r in soft])
    if soft:
        return SafetyVerdict("WATCH", soft)
    if allowlisted:
        return SafetyVerdict("LIVE_ALLOWED", ["discovered, allowlisted in LIVE_TOKENS"])
    return SafetyVerdict("PAPER_ONLY", ["discovered: real trades need it in LIVE_TOKENS"])


def can_scan(state: str, mode: str) -> bool:
    """May the bot quote this token in this mode? Real-money modes don't spend requests on tokens they can't trade."""
    return state != "BLOCKED" if mode == "paper" else state == "LIVE_ALLOWED"


def can_act(state: str, mode: str) -> bool:
    """May the bot act on a gap in this token in this mode?"""
    return state in ("PAPER_ONLY", "LIVE_ALLOWED") if mode == "paper" else state == "LIVE_ALLOWED"


def _error_text(err: BaseException) -> str:
    return f"{type(err).__name__}: {err}" if str(err) else type(err).__name__


class TokenSafety:
    """Cached safety facts for every token the bot knows, keyed by mint."""

    def __init__(
        self,
        path: str,
        live_tokens: list[str],
        thresholds: SafetyThresholds,
        recheck_ms: float = DAY_MS,
        retry_ms: float = 10 * 60_000,
    ):
        self.path = path
        self.live_tokens = live_tokens
        self.thresholds = thresholds
        self.recheck_ms = recheck_ms
        self.retry_ms = retry_ms
        read = read_json_with_backup(path)
        self.entries: dict[str, dict] = read[0] if read and isinstance(read[0], dict) else {}

    def due(self, mints, now: float | None = None) -> list[str]:
        """Mints whose on-chain facts are missing, stale, or due for a retry."""
        now = now_ms() if now is None else now
        out: list[str] = []
        for mint in dict.fromkeys(mints):
            e = self.entries.get(mint)
            if not e or now - e.get("checkedAt", 0) >= (self.recheck_ms if e.get("chain") and not e.get("error") else self.retry_ms):
                out.append(mint)
        return out

    def _entry(self, symbol: str, now: float, chain=None, market=None, error=None) -> dict:
        e = {"symbol": symbol, "checkedAt": now}
        if chain is not None:
            e["chain"] = chain
        if market is not None:
            e["market"] = market
        if error is not None:
            e["error"] = error
        return e

    async def refresh(self, rpc, tokens: dict[str, str], now: float | None = None) -> int:
        """
        Checks every due mint of `tokens` (symbol -> mint) in one RPC call and
        saves the cache. Returns how many were checked; raises if the RPC call
        failed (the failed mints are retried after `retry_ms`).
        """
        now = now_ms() if now is None else now
        symbol_of = {m: s for s, m in tokens.items()}
        due = self.due(list(symbol_of), now)
        # A malformed address must not fail the whole batch: it is simply not a token.
        for mint in (m for m in due if not is_valid_address(m)):
            self.entries[mint] = self._entry(symbol_of[mint], now, _none("invalid"), (self.entries.get(mint) or {}).get("market"))
        mints = [m for m in due if is_valid_address(m)]
        if not mints:
            if due:
                self.save()
            return len(due)
        try:
            for i in range(0, len(mints), 100):
                batch = mints[i : i + 100]
                accounts = await rpc.get_multiple_parsed_accounts(batch)
                for j, mint in enumerate(batch):
                    prev = self.entries.get(mint) or {}
                    acc = accounts[j] if j < len(accounts) else None
                    self.entries[mint] = self._entry(symbol_of[mint], now, parse_mint_account(acc), prev.get("market"))
        except Exception as err:
            for mint in mints:
                prev = self.entries.get(mint)
                if prev and prev.get("chain") and not prev.get("error") and now - prev.get("checkedAt", 0) < self.recheck_ms * 2:
                    continue  # keep recent facts
                self.entries[mint] = {**(prev or {}), "symbol": symbol_of[mint], "checkedAt": now, "error": _error_text(err)[:200]}
            self.save()
            raise
        self.save()
        return len(due)

    def note_market(self, mint: str, symbol: str, market: dict) -> None:
        """Market facts from Jupiter's token list (kept with the on-chain facts)."""
        e = self.entries.get(mint)
        self.entries[mint] = {**e, "market": market} if e else {"symbol": symbol, "checkedAt": 0, "market": market}

    def verdict(self, symbol: str, mint: str, configured: bool, now: float | None = None) -> SafetyVerdict:
        now = now_ms() if now is None else now
        e = self.entries.get(mint) or {}
        v = classify_token(
            configured=configured,
            allowlisted=symbol in self.live_tokens or mint in self.live_tokens,
            chain=None if e.get("error") else e.get("chain"),
            market=e.get("market"),
            now=now,
            t=self.thresholds,
        )
        if e.get("error"):
            v.reasons.append(f"last on-chain check failed: {e['error'][:80]}")
        return v

    def cycle_state(self, tokens: list[tuple[str, str, bool]], now: float | None = None) -> str:
        """The weakest state among the (symbol, mint, configured) tokens a cycle passes through."""
        worst = len(STATES) - 1
        for symbol, mint, configured in tokens:
            worst = min(worst, STATES.index(self.verdict(symbol, mint, configured, now).state))
        return STATES[worst]

    def save(self) -> None:
        try:
            write_json_atomic(self.path, self.entries, backup=True, pretty=True)
        except OSError:
            pass  # the cache only saves RPC calls; the bot still works without it
