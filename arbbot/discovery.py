"""
Finds actively traded, verified tokens via Jupiter's token API so the brain
can look beyond the starting list. Busy tokens are where price gaps appear.
"""

import re
from datetime import datetime

from .config import USDC_MINT
from .jupiter import jupiter_headers

STABLES = {USDC_MINT, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"}  # USDC, USDT


def _mint(t: dict):
    return t.get("id") or t.get("address") or t.get("mint")


def _verified(t: dict) -> bool:
    return t.get("isVerified") is True or "verified" in (t.get("tags") or [])


def parse_top_tokens(body, min_liquidity_usd: float, limit: int) -> dict[str, str]:
    out: dict[str, str] = {}
    for t in body if isinstance(body, list) else []:
        mint = _mint(t)
        symbol = re.sub(r"[^A-Za-z0-9]", "", t.get("symbol") or "").upper()[:12]
        if not mint or not symbol or not _verified(t) or mint in STABLES:
            continue
        if (t.get("liquidity") or 0) < min_liquidity_usd:
            continue
        key = f"{symbol}-{mint[:4]}" if symbol in out else symbol
        out[key] = mint
        if len(out) >= limit:
            break
    return out


def _num(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def _ts(text) -> int | None:
    if not isinstance(text, str):
        return None
    try:
        return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def parse_token_facts(body) -> dict[str, dict]:
    """Market facts per mint for the safety check (fields Jupiter doesn't send stay unknown)."""
    out: dict[str, dict] = {}
    for t in body if isinstance(body, list) else []:
        mint = _mint(t)
        if not mint:
            continue
        out[mint] = {
            "liquidityUsd": _num(t.get("liquidity")),
            "holders": _num(t.get("holderCount")),
            "poolCreatedAt": _ts((t.get("firstPool") or {}).get("createdAt")),
            "topHoldersPct": _num((t.get("audit") or {}).get("topHoldersPercentage")),
            "verified": _verified(t),
        }
    return out


async def discover_tokens(tokens_api: str, min_liquidity_usd: float, limit: int, client, api_key: str | None = None,
                          on_request=lambda: None) -> tuple[dict[str, str], dict[str, dict]]:
    on_request()
    res = await client.get(f"{tokens_api}/toptraded/1h", params={"limit": "50"}, headers=jupiter_headers(api_key))
    if res.status_code >= 400:
        raise RuntimeError(f"Jupiter tokens {res.status_code}: {res.text[:120]}")
    body = res.json()
    return parse_top_tokens(body, min_liquidity_usd, limit), parse_token_facts(body)
