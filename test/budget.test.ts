import { describe, expect, it } from "vitest";
import { RequestBudget, budgetedFetch } from "../src/budget.js";

describe("RequestBudget (sliding 60s window)", () => {
  it("lets requests through until the limit, then says exactly how long to wait", () => {
    const b = new RequestBudget(5);
    for (let t = 0; t < 5; t++) b.record(t * 1000); // 5 requests at 0s..4s
    expect(b.used(4_000)).toBe(5);
    expect(b.waitFor(1, 4_000)).toBe(56_100); // oldest (t=0) leaves the window at 60s (+0.1s margin)
    expect(b.waitFor(2, 4_000)).toBe(57_100); // two must leave: second oldest at 61s
    expect(b.waitFor(1, 60_001)).toBe(0);
    expect(b.used(60_001)).toBe(4);
  });

  it("never allows more than the limit in any 60s window when callers respect waitFor", () => {
    const b = new RequestBudget(58);
    const sent: number[] = [];
    let now = 0;
    for (let scan = 0; scan < 200; scan++) {
      const n = scan % 3 === 2 ? 6 : 2; // mix of full and focus scans, sent as fast as allowed
      now += b.waitFor(n, now);
      for (let i = 0; i < n; i++) {
        b.record(now);
        sent.push(now);
      }
    }
    for (const start of sent) {
      expect(sent.filter((t) => t > start - 60_000 && t <= start).length).toBeLessThanOrEqual(58);
    }
  });

  it("counts every request made through the wrapped fetch", async () => {
    const b = new RequestBudget(10);
    const f = budgetedFetch(b, (async () => new Response("ok")) as typeof fetch);
    await f("https://x");
    await f("https://y");
    expect(b.used()).toBe(2);
  });

  it("with a 10-second window too, spreads requests out and keeps every window under its limit", () => {
    const b = new RequestBudget([
      { ms: 60_000, limit: 58 },
      { ms: 10_000, limit: 9 },
    ]);
    const sent: number[] = [];
    let now = 0;
    for (let k = 0; k < 400; k++) {
      now += b.waitFor(2, now); // each token = 2 back-to-back requests
      b.record(now);
      b.record(now + 300);
      sent.push(now, now + 300);
      now += 300;
    }
    for (const t of sent) {
      expect(sent.filter((x) => x > t - 10_000 && x <= t).length).toBeLessThanOrEqual(9);
      expect(sent.filter((x) => x > t - 60_000 && x <= t).length).toBeLessThanOrEqual(58);
    }
    const perMin = (sent.length / (sent[sent.length - 1] - sent[0])) * 60_000;
    expect(perMin).toBeGreaterThan(45); // still uses most of the ~54/min allowance (0.1s margins cost a little)
  });
});


describe("free room right now", () => {
  it("is the smallest room left in any window", async () => {
    const { RequestBudget } = await import("../src/budget.js");
    const b = new RequestBudget([
      { ms: 60_000, limit: 10 },
      { ms: 10_000, limit: 3 },
    ]);
    expect(b.available(1_000)).toBe(3);
    b.record(1_000);
    b.record(2_000);
    expect(b.available(2_000)).toBe(1);
    b.record(3_000);
    expect(b.available(3_000)).toBe(0);
    // The 10s window empties; the minute window still counts all three.
    expect(b.available(13_500)).toBe(3);
    expect(new RequestBudget(5).available(0)).toBe(5);
  });
});
