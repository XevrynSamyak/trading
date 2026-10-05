import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { renderStatus, type StatusData } from "./status.js";

/**
 * Optional status server inside the bot (STATUS_HTTP_PORT), so the status
 * can be seen from another device and trading stopped in an emergency:
 *
 *   GET  /              status page that refreshes itself (with a stop button)
 *   GET  /status.json   the same data as `npm run status`, as JSON
 *   GET  /report.txt    the `npm run report` text
 *   POST /stop-trading  trips the kill switch (data/TRADING_DISABLED)
 *
 * Read-only apart from stopping: nothing here can start trading, re-enable
 * it, change settings or move money. Re-enabling stays a deliberate act on
 * the phone itself (npm run enable-trading). It listens on 127.0.0.1 unless
 * STATUS_HTTP_HOST says otherwise, and then STATUS_HTTP_TOKEN is required.
 * No secrets are served: status and report never contain keys.
 */
export interface ServerOptions {
  host: string;
  port: number;
  token?: string;
}

export interface ServerDeps {
  status: () => StatusData;
  report: () => string;
  stopTrading: (reason: string) => void;
  now?: () => number;
}

const MIN_TOKEN_LENGTH = 16;
const isLoopback = (host: string) => host === "127.0.0.1" || host === "::1" || host === "localhost";

/** Refuses settings that would expose the server without a proper token. */
export function checkServerOptions(o: ServerOptions): string | null {
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65_535) return `STATUS_HTTP_PORT must be a port number, got ${o.port}`;
  if (o.token !== undefined && o.token.length < MIN_TOKEN_LENGTH) {
    return `STATUS_HTTP_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`;
  }
  if (!isLoopback(o.host) && !o.token) {
    return `STATUS_HTTP_HOST=${o.host} makes the status server reachable from other devices: set STATUS_HTTP_TOKEN (random, ${MIN_TOKEN_LENGTH}+ characters) first`;
  }
  return null;
}

function authorized(req: IncomingMessage, url: URL, token: string | undefined): boolean {
  if (!token) return true; // loopback only (checkServerOptions)
  const header = req.headers.authorization;
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function page(text: string, token: string | undefined, notice?: string): string {
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5"><title>Arb bot status</title>
<style>body{background:#111;color:#ddd;font:13px/1.35 ui-monospace,monospace;margin:12px}pre{white-space:pre-wrap}
button{background:#b00;color:#fff;border:0;padding:10px 16px;font:inherit;border-radius:4px}.n{color:#fc6}</style></head><body>
${notice ? `<p class="n">${escapeHtml(notice)}</p>` : ""}<pre>${escapeHtml(text)}</pre>
<form method="post" action="/stop-trading${q}" onsubmit="return confirm('Stop all trading now? Re-enabling needs npm run enable-trading on the phone.')">
<button type="submit">Emergency stop: disable trading</button></form>
<p><a style="color:#8af" href="/report.txt${q}">Full report</a></p></body></html>`;
}

export function createStatusServer(o: ServerOptions, deps: ServerDeps): Server {
  const now = deps.now ?? Date.now;
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://bot");
    const send = (code: number, type: string, body: string) => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(body);
    };
    // Requests carry no body we need; don't read one.
    req.resume();
    const routes: Record<string, string> = { "/": "GET", "/status.json": "GET", "/report.txt": "GET", "/stop-trading": "POST" };
    const method = routes[url.pathname];
    if (!method) return send(404, "text/plain", "not found\n");
    if (req.method !== method) {
      res.setHeader("allow", method);
      return send(405, "text/plain", `use ${method}\n`);
    }
    if (!authorized(req, url, o.token)) return send(401, "text/plain", "missing or wrong token\n");
    try {
      if (url.pathname === "/status.json") return send(200, "application/json", JSON.stringify(deps.status()));
      if (url.pathname === "/report.txt") return send(200, "text/plain; charset=utf-8", deps.report());
      if (url.pathname === "/stop-trading") {
        deps.stopTrading(`stopped from the status page (${req.socket.remoteAddress ?? "unknown address"})`);
        const wantsHtml = (req.headers.accept ?? "").includes("text/html");
        return wantsHtml
          ? send(200, "text/html; charset=utf-8", page(renderStatus({ ...deps.status(), now: now(), color: false }), o.token, "Trading disabled. Re-enable on the phone with: npm run enable-trading"))
          : send(200, "application/json", JSON.stringify({ ok: true, disabled: true }));
      }
      return send(200, "text/html; charset=utf-8", page(renderStatus({ ...deps.status(), now: now(), color: false }), o.token));
    } catch (err) {
      return send(500, "text/plain", `error: ${String(err).slice(0, 200)}\n`);
    }
  });
}
