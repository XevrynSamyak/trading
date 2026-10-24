"""
Price watch: one Jupiter price request covers up to 50 tokens, so the bot can
keep an eye on every token it knows for a few requests a minute and spend its
full round-trip quotes (2 requests per token) on the ones that just moved.
A price is one number per token, so it can't show an arbitrage gap itself;
it only says where to look.
"""

import math
from typing import Callable

from .jupiter import jupiter_headers

#: Most tokens Jupiter's price API takes in one request.
MAX_IDS = 50


def parse_prices(body) -> dict[str, float]:
    """mint -> USD price, from Price API v3 ({mint: {usdPrice}}) or v2 ({data: {mint: {price}}})."""
    if not isinstance(body, dict):
        return {}
    data = body["data"] if isinstance(body.get("data"), dict) else body
    out: dict[str, float] = {}
    for mint, v in data.items():
        if not isinstance(v, dict):
            continue
        try:
            price = float(v.get("usdPrice", v.get("price")))
        except (TypeError, ValueError):
            continue
        if math.isfinite(price) and price > 0:
            out[mint] = price
    return out


def requests_needed(n_mints: int) -> int:
    return math.ceil(n_mints / MAX_IDS)


async def fetch_prices(client, price_api: str, mints: list[str], api_key: str | None = None,
                       on_request: Callable[[], None] = lambda: None) -> dict[str, float]:
    """USD prices for `mints` (tokens Jupiter has no reliable price for are left out)."""
    unique = list(dict.fromkeys(mints))
    out: dict[str, float] = {}
    for i in range(0, len(unique), MAX_IDS):
        on_request()
        res = await client.get(price_api, params={"ids": ",".join(unique[i : i + MAX_IDS])}, headers=jupiter_headers(api_key))
        if res.status_code >= 400:
            raise RuntimeError(f"Jupiter price {res.status_code}: {res.text[:120]}")
        out.update(parse_prices(res.json()))
    return out
