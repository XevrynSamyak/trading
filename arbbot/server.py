"""
Optional status server inside the bot (STATUS_HTTP_PORT), so the status can
be seen from another device and trading stopped in an emergency:

  GET  /              status page that refreshes itself (with a stop button)
  GET  /status.json   the same data as `status`, as JSON
  GET  /report.txt    the `report` text
  POST /stop-trading  trips the kill switch (data/TRADING_DISABLED)

Read-only apart from stopping: nothing here can start trading, re-enable it,
change settings or move money. Re-enabling stays a deliberate act on the
phone itself (npm run enable-trading). It listens on 127.0.0.1 unless
STATUS_HTTP_HOST says otherwise, and then STATUS_HTTP_TOKEN is required. No
secrets are served: status and report never contain keys.
"""

import asyncio
import hmac
import html
import json
from dataclasses import dataclass
from typing import Callable
from urllib.parse import parse_qs, quote, urlsplit

from .status import render_status
from .util import now_ms

MIN_TOKEN_LENGTH = 16
ROUTES = {"/": "GET", "/status.json": "GET", "/report.txt": "GET", "/stop-trading": "POST"}
READ_TIMEOUT_S = 10
REASONS = {200: "OK", 401: "Unauthorized", 404: "Not Found", 405: "Method Not Allowed", 500: "Internal Server Error"}


@dataclass
class ServerOptions:
    host: str
    port: int
    token: str | None = None


@dataclass
class ServerDeps:
    status: Callable[[], dict]
    report: Callable[[], str]
    stop_trading: Callable[[str], None]
    now: Callable[[], int] = now_ms


def _is_loopback(host: str) -> bool:
    return host in ("127.0.0.1", "::1", "localhost")


def check_server_options(o: ServerOptions) -> str | None:
    """Refuses settings that would expose the server without a proper token."""
    if not isinstance(o.port, int) or o.port < 0 or o.port > 65_535:
        return f"STATUS_HTTP_PORT must be a port number, got {o.port}"
    if o.token is not None and len(o.token) < MIN_TOKEN_LENGTH:
        return f"STATUS_HTTP_TOKEN must be at least {MIN_TOKEN_LENGTH} characters"
    if not _is_loopback(o.host) and not o.token:
        return (
            f"STATUS_HTTP_HOST={o.host} makes the status server reachable from other devices: "
            f"set STATUS_HTTP_TOKEN (random, {MIN_TOKEN_LENGTH}+ characters) first"
        )
    return None


def _authorized(headers: dict, query: dict, token: str | None) -> bool:
    if not token:
        return True  # loopback only (check_server_options)
    header = headers.get("authorization", "")
    supplied = header[7:] if header.startswith("Bearer ") else (query.get("token") or [None])[0]
    if not supplied:
        return False
    return hmac.compare_digest(supplied.encode(), token.encode())


def page(text: str, token: str | None, notice: str | None = None) -> str:
    q = f"?token={quote(token, safe='')}" if token else ""
    return f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5"><title>Arb bot status</title>
<style>body{{background:#111;color:#ddd;font:13px/1.35 ui-monospace,monospace;margin:12px}}pre{{white-space:pre-wrap}}
button{{background:#b00;color:#fff;border:0;padding:10px 16px;font:inherit;border-radius:4px}}.n{{color:#fc6}}</style></head><body>
{f'<p class="n">{html.escape(notice, quote=False)}</p>' if notice else ""}<pre>{html.escape(text, quote=False)}</pre>
<form method="post" action="/stop-trading{q}" onsubmit="return confirm('Stop all trading now? Re-enabling needs npm run enable-trading on the phone.')">
<button type="submit">Emergency stop: disable trading</button></form>
<p><a style="color:#8af" href="/report.txt{q}">Full report</a></p></body></html>"""


class StatusServer:
    def __init__(self, opts: ServerOptions, deps: ServerDeps):
        self.opts = opts
        self.deps = deps
        self._server: asyncio.base_events.Server | None = None

    async def start(self) -> int:
        """Starts listening; returns the port (useful with port 0)."""
        self._server = await asyncio.start_server(self._handle, self.opts.host, self.opts.port)
        return self._server.sockets[0].getsockname()[1]

    async def close(self) -> None:
        if self._server:
            self._server.close()
            try:
                await asyncio.wait_for(self._server.wait_closed(), 2)
            except (asyncio.TimeoutError, OSError):
                pass
            self._server = None

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            await asyncio.wait_for(self._serve(reader, writer), READ_TIMEOUT_S)
        except (asyncio.TimeoutError, ConnectionError, ValueError, asyncio.IncompleteReadError):
            pass
        finally:
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        request_line = (await reader.readline()).decode("latin-1").strip()
        if not request_line:
            return
        parts = request_line.split()
        if len(parts) < 2:
            return
        method, target = parts[0], parts[1]
        headers: dict[str, str] = {}
        while True:
            line = (await reader.readline()).decode("latin-1")
            if line in ("\r\n", "\n", ""):
                break
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        # Requests carry no body we need; read (and drop) a small one so the client isn't cut off.
        length = int(headers.get("content-length") or 0)
        if 0 < length <= 65_536:
            await reader.readexactly(length)

        def send(code: int, ctype: str, body: str, extra: dict | None = None) -> None:
            data = body.encode()
            head = [
                f"HTTP/1.1 {code} {REASONS.get(code, '')}",
                f"content-type: {ctype}",
                "cache-control: no-store",
                "x-content-type-options: nosniff",
                f"content-length: {len(data)}",
                "connection: close",
                *(f"{k}: {v}" for k, v in (extra or {}).items()),
            ]
            writer.write(("\r\n".join(head) + "\r\n\r\n").encode() + data)

        url = urlsplit(target)
        path, query = url.path or "/", parse_qs(url.query)
        want = ROUTES.get(path)
        if not want:
            send(404, "text/plain", "not found\n")
        elif method != want:
            send(405, "text/plain", f"use {want}\n", {"allow": want})
        elif not _authorized(headers, query, self.opts.token):
            send(401, "text/plain", "missing or wrong token\n")
        else:
            try:
                await self._route(path, headers, writer, send)
            except Exception as err:  # noqa: BLE001
                send(500, "text/plain", f"error: {str(err)[:200]}\n")
        await writer.drain()

    async def _route(self, path: str, headers: dict, writer, send) -> None:
        d = self.deps
        if path == "/status.json":
            send(200, "application/json", json.dumps(await asyncio.to_thread(d.status)))
        elif path == "/report.txt":
            send(200, "text/plain; charset=utf-8", await asyncio.to_thread(d.report))
        elif path == "/stop-trading":
            peer = writer.get_extra_info("peername")
            d.stop_trading(f"stopped from the status page ({peer[0] if peer else 'unknown address'})")
            if "text/html" in headers.get("accept", ""):
                text = render_status(await asyncio.to_thread(d.status), d.now(), False)
                send(200, "text/html; charset=utf-8",
                     page(text, self.opts.token, "Trading disabled. Re-enable on the phone with: npm run enable-trading"))
            else:
                send(200, "application/json", json.dumps({"ok": True, "disabled": True}))
        else:
            text = render_status(await asyncio.to_thread(d.status), d.now(), False)
            send(200, "text/html; charset=utf-8", page(text, self.opts.token))
