import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { redact } from "../src/log.js";
import { checkServerOptions, createStatusServer, type ServerDeps } from "../src/server.js";
import { fetchRemoteStatus, resultsOf, type StatusData } from "../src/status.js";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const TOKEN = "s3cret-status-token-123";

const data: StatusData = {
  live: {
    pid: 1, mode: "paper", startedAt: NOW - 3_600_000, updatedAt: NOW - 1_000, cycles: 42, state: "scanning",
    onChainTesting: false, sendVia: "jito", solPrice: 150, walletValueUsd: 25, tradeSizeUsd: 20, hot: [], nextScanInMs: 5_000,
  },
  processAlive: true,
  halted: null,
  killSwitch: null,
  results: resultsOf([], NOW),
  brainStartedAt: NOW - 86_400_000,
  paperDaysTarget: 3,
  verdict: null,
  edgeHistogram: {},
  thoughts: [],
  events: [],
};

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start(token: string | undefined, deps: Partial<ServerDeps> = {}) {
  const stops: string[] = [];
  const server = createStatusServer(
    { host: "127.0.0.1", port: 0, token },
    { status: () => data, report: () => "REPORT TEXT", stopTrading: (r) => stops.push(r), now: () => NOW, ...deps },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  close = () => server.close();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, stops };
}

describe("status server settings", () => {
  it("only listens beyond this device with a proper token", () => {
    expect(checkServerOptions({ host: "127.0.0.1", port: 8787 })).toBeNull();
    expect(checkServerOptions({ host: "0.0.0.0", port: 8787 })).toMatch(/set STATUS_HTTP_TOKEN/);
    expect(checkServerOptions({ host: "0.0.0.0", port: 8787, token: "short" })).toMatch(/at least 16/);
    expect(checkServerOptions({ host: "0.0.0.0", port: 8787, token: TOKEN })).toBeNull();
    expect(checkServerOptions({ host: "127.0.0.1", port: 70_000 })).toMatch(/port number/);
  });
});

describe("status server", () => {
  it("serves status, report and page only with the token", async () => {
    const { base } = await start(TOKEN);
    expect((await fetch(`${base}/status.json`)).status).toBe(401);
    expect((await fetch(`${base}/status.json?token=wrong-token-wrong-token`)).status).toBe(401);
    const json = await fetch(`${base}/status.json`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(json.status).toBe(200);
    expect(((await json.json()) as StatusData).live?.cycles).toBe(42);
    expect(await (await fetch(`${base}/report.txt?token=${TOKEN}`)).text()).toBe("REPORT TEXT");
    const html = await (await fetch(`${base}/?token=${TOKEN}`)).text();
    expect(html).toContain("RUNNING");
    expect(html).toContain("Emergency stop");
    expect(html).toContain('http-equiv="refresh"');
  });

  it("can stop trading but never start it, and only by POST", async () => {
    const { base, stops } = await start(TOKEN);
    expect((await fetch(`${base}/stop-trading?token=${TOKEN}`)).status).toBe(405); // GET can't stop
    expect((await fetch(`${base}/stop-trading`, { method: "POST" })).status).toBe(401);
    const res = await fetch(`${base}/stop-trading`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(await res.json()).toEqual({ ok: true, disabled: true });
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatch(/stopped from the status page \(.*127\.0\.0\.1\)/);
    for (const path of ["/enable-trading", "/start", "/settings"]) {
      expect((await fetch(`${base}${path}?token=${TOKEN}`, { method: "POST" })).status).toBe(404);
    }
    expect((await fetch(`${base}/status.json?token=${TOKEN}`, { method: "POST" })).status).toBe(405);
  });

  it("works without a token on this device only", async () => {
    const { base } = await start(undefined);
    expect((await fetch(`${base}/status.json`)).status).toBe(200);
  });

  it("feeds a remote dashboard (npm run watch with ENGINE_URL)", async () => {
    const { base } = await start(TOKEN);
    expect((await fetchRemoteStatus(base, TOKEN)).live?.cycles).toBe(42);
    await expect(fetchRemoteStatus(base, "nope-nope-nope-nope")).rejects.toThrow(/401 \(check ENGINE_TOKEN\)/);
  });

  it("keeps the token out of logs", () => {
    expect(redact(`GET http://192.168.1.5:8787/?token=${TOKEN}&x=1`)).toBe("GET http://192.168.1.5:8787/?token=***&x=1");
    expect(redact(`authorization: Bearer ${TOKEN}`)).toBe("authorization: Bearer ***");
  });
});
