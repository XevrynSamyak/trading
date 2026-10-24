"""Async Solana JSON-RPC client (only the calls the bot uses), over httpx."""

import base64
import json

import httpx

from .tx import LookupTable, parse_lookup_table


class RpcError(Exception):
    """The RPC answered with an error: a definite answer (e.g. the send was refused)."""

    def __init__(self, method: str, code, message: str):
        super().__init__(f"{method}: {message} (code {code})")
        self.code = code


class Rpc:
    def __init__(self, url: str, client: httpx.AsyncClient, commitment: str = "confirmed"):
        self.url = url
        self.client = client
        self.commitment = commitment

    async def call(self, method: str, params: list | None = None):
        res = await self.client.post(self.url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []})
        if res.status_code >= 400:
            raise RuntimeError(f"RPC {method} {res.status_code}: {res.text[:160]}")
        body = res.json()
        if body.get("error"):
            err = body["error"]
            raise RpcError(method, err.get("code"), err.get("message") or json.dumps(err))
        return body.get("result")

    async def get_slot(self) -> int:
        return await self.call("getSlot", [{"commitment": self.commitment}])

    async def get_version(self) -> dict:
        return await self.call("getVersion")

    async def get_balance(self, pubkey: str) -> int:
        return (await self.call("getBalance", [pubkey, {"commitment": self.commitment}]))["value"]

    async def get_parsed_token_accounts_by_owner(self, owner: str, program_id: str) -> list[dict]:
        r = await self.call(
            "getTokenAccountsByOwner",
            [owner, {"programId": program_id}, {"encoding": "jsonParsed", "commitment": self.commitment}],
        )
        return r["value"]

    async def get_token_account_balance(self, address: str, commitment: str = "processed") -> int:
        r = await self.call("getTokenAccountBalance", [address, {"commitment": commitment}])
        return int(r["value"]["amount"])

    async def get_multiple_parsed_accounts(self, keys: list[str]) -> list[dict | None]:
        r = await self.call("getMultipleAccounts", [keys, {"encoding": "jsonParsed", "commitment": self.commitment}])
        return r["value"]

    async def get_account_data(self, key: str) -> bytes | None:
        r = await self.call("getAccountInfo", [key, {"encoding": "base64", "commitment": self.commitment}])
        v = r["value"]
        return base64.b64decode(v["data"][0]) if v else None

    async def get_address_lookup_table(self, key: str) -> LookupTable | None:
        data = await self.get_account_data(key)
        return parse_lookup_table(key, data) if data is not None else None

    async def get_latest_blockhash(self) -> tuple[str, int]:
        v = (await self.call("getLatestBlockhash", [{"commitment": self.commitment}]))["value"]
        return v["blockhash"], v["lastValidBlockHeight"]

    async def simulate_transaction(self, tx: bytes, *, sig_verify: bool = False, replace_recent_blockhash: bool = False,
                                   commitment: str = "processed", account_addresses: list[str] | None = None) -> dict:
        cfg: dict = {"encoding": "base64", "commitment": commitment}
        if sig_verify:
            cfg["sigVerify"] = True
        if replace_recent_blockhash:
            cfg["replaceRecentBlockhash"] = True
        if account_addresses:
            cfg["accounts"] = {"encoding": "base64", "addresses": account_addresses}
        return (await self.call("simulateTransaction", [base64.b64encode(tx).decode(), cfg]))["value"]

    async def send_transaction(self, tx: bytes, skip_preflight: bool = True, max_retries: int = 2) -> str:
        return await self.call(
            "sendTransaction",
            [base64.b64encode(tx).decode(), {"encoding": "base64", "skipPreflight": skip_preflight, "maxRetries": max_retries}],
        )

    async def get_signature_statuses(self, signatures: list[str]) -> list[dict | None]:
        return (await self.call("getSignatureStatuses", [signatures]))["value"]

    async def get_block_height(self) -> int:
        return await self.call("getBlockHeight", [{"commitment": self.commitment}])

    async def get_transaction(self, signature: str) -> dict | None:
        return await self.call(
            "getTransaction",
            [signature, {"commitment": "confirmed", "maxSupportedTransactionVersion": 0, "encoding": "json"}],
        )
