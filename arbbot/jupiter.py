"""Minimal client for Jupiter's swap API (quote + swap-instructions). Quotes stay plain JSON dicts."""

from typing import Callable

import httpx


def jupiter_headers(api_key: str | None, extra: dict | None = None) -> dict:
    """The API key goes in `x-api-key` (never in the URL or logs)."""
    h = dict(extra or {})
    if api_key:
        h["x-api-key"] = api_key
    return h


class JupiterError(RuntimeError):
    pass


class JupiterClient:
    def __init__(self, base_url: str, client: httpx.AsyncClient, api_key: str | None = None,
                 on_request: Callable[[], None] | None = None):
        self.base_url = base_url
        self.client = client
        self.api_key = api_key
        #: Called before every request (the request budget counts them).
        self.on_request = on_request or (lambda: None)

    async def quote(self, input_mint: str, output_mint: str, amount: int, slippage_bps: int, max_accounts: int | None = None) -> dict:
        params = {
            "inputMint": input_mint,
            "outputMint": output_mint,
            "amount": str(amount),
            "slippageBps": str(slippage_bps),
            "restrictIntermediateTokens": "true",
        }
        # Keeps each leg small enough that all legs fit in one transaction.
        if max_accounts:
            params["maxAccounts"] = str(max_accounts)
        self.on_request()
        res = await self.client.get(f"{self.base_url}/quote", params=params, headers=jupiter_headers(self.api_key))
        if res.status_code >= 400:
            raise JupiterError(f"Jupiter quote {res.status_code}: {res.text}")
        return res.json()

    async def swap_instructions(self, quote: dict, user_public_key: str) -> dict:
        self.on_request()
        res = await self.client.post(
            f"{self.base_url}/swap-instructions",
            json={
                "quoteResponse": quote,
                "userPublicKey": user_public_key,
                # Keep wSOL as a token account so the next leg can spend this leg's output.
                "wrapAndUnwrapSol": False,
                "dynamicComputeUnitLimit": False,
            },
            headers=jupiter_headers(self.api_key, {"Content-Type": "application/json"}),
        )
        if res.status_code >= 400:
            raise JupiterError(f"Jupiter swap-instructions {res.status_code}: {res.text}")
        body = res.json()
        if body.get("error"):
            raise JupiterError(f"Jupiter swap-instructions: {body['error']}")
        return body
