"""
Jito block engine. Transactions sent with bundleOnly=true are documented as
"revert protected": if the arbitrage would fail, it is not included in a
block, and the tip is only paid when it lands.
"""

import json

import httpx


class JitoError(RuntimeError):
    """Jito answered with an error: a definite refusal."""


class JitoClient:
    def __init__(self, base_url: str, client: httpx.AsyncClient):
        self.base_url = base_url
        self.client = client

    async def _rpc(self, path: str, method: str, params: list):
        res = await self.client.post(
            f"{self.base_url}{path}",
            json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
            headers={"Content-Type": "application/json"},
        )
        text = res.text
        if res.status_code >= 400:
            raise JitoError(f"Jito {method} {res.status_code}: {text[:160]}")
        body = json.loads(text)
        if body.get("error"):
            err = body["error"]
            raise JitoError(f"Jito {method}: {err.get('message') if isinstance(err, dict) else err}")
        if body.get("result") is None:
            raise JitoError(f"Jito {method}: empty response")
        return body["result"]

    async def get_tip_accounts(self) -> list[str]:
        return await self._rpc("/getTipAccounts", "getTipAccounts", [])

    async def send_transaction(self, base64_tx: str) -> str:
        """Sends a signed transaction as a revert-protected single-transaction bundle."""
        return await self._rpc("/transactions?bundleOnly=true", "sendTransaction", [base64_tx, {"encoding": "base64"}])
