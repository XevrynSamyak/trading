import { describe, expect, it } from "vitest";
import { RequestBudget, budgetedFetch } from "../src/budget.js";

describe("RequestBudget (sliding 60s window)", () => {
  it("lets requests through until the limit, then says exactly how long to wait", () => {
    const b = new RequestBudget(5);
    for (let t = 0; t < 5; t++) b.record(t * 1000); // 5 requests at 0s..4s
    expect(b.used(4_000)).toBe(5);
    expect(b.waitFor(1, 4_000)).toBe(56_001); // oldest (t=0) leaves the window at 60s
    expect(b.waitFor(2, 4_000)).toBe(57_001); // two must leave: second oldest at 61s
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
});
