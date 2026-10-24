"""
RPC WebSocket subscriptions (accountSubscribe, slotSubscribe) with automatic
reconnects. Written for this bot so that nothing ever waits for a reply that
may not come: subscribing and unsubscribing return at once, and a half-dead
connection is detected by pings and replaced.
"""

import asyncio
import itertools
import json
import re
from typing import Callable

from ..log import log


def ws_url_from(rpc_url: str) -> str:
    """wss:// for https://, ws:// for http://; an explicit port moves up by one (the validator convention)."""
    m = re.match(r"^(https?):\/\/([^\/:]+)(:\d+)?(.*)$", rpc_url)
    if not m:
        raise ValueError(f"Failed to validate endpoint URL `{rpc_url}`")
    proto, host, port, rest = m.groups()
    port_part = f":{int(port[1:]) + 1}" if port else ""
    return f"{'wss' if proto == 'https' else 'ws'}://{host}{port_part}{rest}"


class RpcWebSocket:
    def __init__(self, url: str, connect=None, backoff_max_s: float = 30.0):
        self.url = url
        self._connect = connect  # injectable for tests
        self._subs: dict[int, dict] = {}
        self._ids = itertools.count(1)
        self._req_ids = itertools.count(1)
        self._pending: dict[int, int] = {}
        self._by_server: dict[int, int] = {}
        self._ws = None
        self._task: asyncio.Task | None = None
        self._closed = False
        self._backoff_max = backoff_max_s

    # -- public ----------------------------------------------------------------

    def account_subscribe(self, account: str, on_change: Callable[[int], None], commitment: str = "processed") -> int:
        return self._add(
            "accountSubscribe", "accountUnsubscribe", [account, {"encoding": "base64", "commitment": commitment}],
            lambda p: on_change(p["result"]["context"]["slot"]),
        )

    def slot_subscribe(self, on_slot: Callable[[int], None]) -> int:
        return self._add("slotSubscribe", "slotUnsubscribe", [], lambda p: on_slot(p["result"]["slot"]))

    def unsubscribe(self, cid: int) -> None:
        """Forget a subscription. Never waits for the server's reply."""
        sub = self._subs.pop(cid, None)
        if not sub or sub["server_id"] is None:
            return
        self._by_server.pop(sub["server_id"], None)
        self._send_nowait(sub["unsub"], [sub["server_id"]])

    @property
    def connected(self) -> bool:
        return self._ws is not None

    async def close(self) -> None:
        self._closed = True
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        self._task = None

    # -- internals ---------------------------------------------------------------

    def _add(self, method: str, unsub: str, params: list, dispatch) -> int:
        cid = next(self._ids)
        self._subs[cid] = {"method": method, "unsub": unsub, "params": params, "dispatch": dispatch, "server_id": None}
        if self._task is None and not self._closed:
            self._task = asyncio.create_task(self._run())
        elif self._ws is not None:
            self._subscribe(cid)
        return cid

    def _subscribe(self, cid: int) -> None:
        sub = self._subs[cid]
        rid = self._send_nowait(sub["method"], sub["params"])
        if rid is not None:
            self._pending[rid] = cid

    def _send_nowait(self, method: str, params: list) -> int | None:
        ws = self._ws
        if ws is None:
            return None
        rid = next(self._req_ids)
        msg = json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})

        async def send():
            try:
                await asyncio.wait_for(ws.send(msg), 5)
            except Exception:
                pass  # the reader notices a dead socket and reconnects

        asyncio.create_task(send())
        return rid

    def _handle(self, raw) -> None:
        msg = json.loads(raw)
        if "id" in msg and msg["id"] in self._pending:
            cid = self._pending.pop(msg["id"])
            server_id = msg.get("result")
            if not isinstance(server_id, int) or isinstance(server_id, bool):
                return
            if cid in self._subs:
                self._subs[cid]["server_id"] = server_id
                self._by_server[server_id] = cid
            else:  # unsubscribed while the reply was on its way
                self._send_nowait("accountUnsubscribe", [server_id])
            return
        method = msg.get("method", "")
        if method.endswith("Notification"):
            params = msg.get("params") or {}
            cid = self._by_server.get(params.get("subscription"))
            if cid in self._subs:
                try:
                    self._subs[cid]["dispatch"](params)
                except Exception as err:  # a bad callback must not kill the connection
                    log.warn(f"subscription callback failed: {err}")

    async def _open(self):
        if self._connect:
            return await self._connect(self.url)
        import websockets

        return await websockets.connect(self.url, ping_interval=20, ping_timeout=20, open_timeout=10, close_timeout=2)

    async def _run(self) -> None:
        delay = 1.0
        while not self._closed:
            try:
                ws = await self._open()
                self._ws = ws
                delay = 1.0
                for cid in list(self._subs):
                    self._subscribe(cid)
                async for raw in ws:
                    self._handle(raw)
                raise ConnectionError("connection closed")
            except asyncio.CancelledError:
                raise
            except Exception as err:
                log.ws_error(str(err)[:160] or type(err).__name__)
            finally:
                ws, self._ws = self._ws, None
                self._pending.clear()
                self._by_server.clear()
                for sub in self._subs.values():
                    sub["server_id"] = None
                if ws is not None:
                    try:
                        await asyncio.wait_for(ws.close(), 2)
                    except Exception:
                        pass
            await asyncio.sleep(delay)
            delay = min(self._backoff_max, delay * 2)
