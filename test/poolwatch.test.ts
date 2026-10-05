import { describe, expect, it } from "vitest";
import { PoolWatcher, type AccountSubscriber, type WatchOptions } from "../src/poolwatch.js";

/** Fake WebSocket: records subscriptions and lets the test fire pool updates. */
function fakeSubscriber() {
  let next = 1;
  const live = new Map<number, { account: string; cb: (slot: number) => void }>();
  const sub: AccountSubscriber = {
    subscribe: (account, cb) => {
      const id = next++;
      live.set(id, { account, cb });
      return id;
    },
    unsubscribe: (id) => {
      live.delete(id);
    },
  };
  const fire = (account: string) => {
    for (const s of [...live.values()]) if (s.account === account) s.cb(1);
  };
  const watched = () => [...live.values()].map((s) => s.account).sort();
  return { sub, fire, watched };
}

const OPTS: WatchOptions = { maxPools: 3, dailyEventCap: 1_000, debounceMs: 1_000, busyPerMin: 30 };
const T0 = Date.parse("2026-10-05T12:00:00Z");

describe("pool event triggers", () => {
  it("watches the most promising tokens' pools up to the limit, and follows route changes", async () => {
    const f = fakeSubscriber();
    const w = new PoolWatcher(f.sub, OPTS, () => {}, () => T0);
    await w.watch([
      { symbol: "JUP", pools: ["p1", "p2"] },
      { symbol: "WIF", pools: ["p3", "p4"] },
    ]);
    expect(f.watched()).toEqual(["p1", "p2", "p3"]);
    await w.watch([
      { symbol: "WIF", pools: ["p4"] },
      { symbol: "JUP", pools: ["p1"] },
    ]);
    expect(f.watched()).toEqual(["p1", "p4"]);
    expect(w.stats().watching).toBe(2);
  });

  it("marks a token dirty when its pool changes, at most once per debounce, and wakes the loop", async () => {
    const f = fakeSubscriber();
    let now = T0;
    let wakes = 0;
    const w = new PoolWatcher(f.sub, OPTS, () => wakes++, () => now);
    await w.watch([
      { symbol: "JUP", pools: ["shared"] },
      { symbol: "WIF", pools: ["shared", "w1"] },
    ]);
    f.fire("shared");
    expect(wakes).toBe(1);
    now += 300;
    f.fire("w1"); // within WIF's debounce
    expect(wakes).toBe(1);
    expect(w.takeDirty()).toEqual([
      { symbol: "JUP", ts: T0 },
      { symbol: "WIF", ts: T0 },
    ]);
    expect(w.takeDirty()).toEqual([]);
    now += 1_000;
    f.fire("w1");
    expect(w.takeDirty()).toEqual([{ symbol: "WIF", ts: T0 + 1_300 }]);
    w.remark("WIF", T0 + 1_300);
    expect(w.takeDirty()).toEqual([{ symbol: "WIF", ts: T0 + 1_300 }]);
  });

  it("drops a pool that changes nearly every slot (no signal, most traffic) for a while", async () => {
    const f = fakeSubscriber();
    let now = T0;
    const w = new PoolWatcher(f.sub, { ...OPTS, busyPerMin: 5, busyCooldownMs: 3_600_000 }, () => {}, () => now);
    await w.watch([{ symbol: "SOL", pools: ["busy", "calm"] }]);
    for (let i = 0; i < 6; i++) {
      now += 2_000;
      f.fire("busy");
    }
    expect(f.watched()).toEqual(["calm"]);
    expect(w.stats().tooBusy).toBe(1);
    await w.watch([{ symbol: "SOL", pools: ["busy", "calm"] }]);
    expect(f.watched()).toEqual(["calm"]); // still resting
    now += 3_600_001;
    await w.watch([{ symbol: "SOL", pools: ["busy", "calm"] }]);
    expect(f.watched()).toEqual(["busy", "calm"]);
  });

  it("stops for the day at the event cap, then resumes the next UTC day", async () => {
    const f = fakeSubscriber();
    let now = T0;
    const warnings: string[] = [];
    const w = new PoolWatcher(f.sub, { ...OPTS, dailyEventCap: 3, debounceMs: 0 }, () => {}, () => now, (m) => warnings.push(m));
    await w.watch([{ symbol: "JUP", pools: ["p1"] }]);
    for (let i = 0; i < 3; i++) {
      now += 10_000;
      f.fire("p1");
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(w.stats()).toMatchObject({ capped: true, eventsToday: 3 });
    expect(f.watched()).toEqual([]);
    expect(warnings[0]).toMatch(/paused until tomorrow/);
    await w.watch([{ symbol: "JUP", pools: ["p1"] }]);
    expect(f.watched()).toEqual([]);
    now += 86_400_000;
    await w.watch([{ symbol: "JUP", pools: ["p1"] }]);
    expect(f.watched()).toEqual(["p1"]);
    expect(w.stats()).toMatchObject({ capped: false, eventsToday: 0 });
  });

  it("skips a pool it cannot subscribe to instead of failing", async () => {
    const warnings: string[] = [];
    const sub: AccountSubscriber = {
      subscribe: (account) => {
        if (account === "bad") throw new Error("socket closed");
        return 7;
      },
      unsubscribe: () => {},
    };
    const w = new PoolWatcher(sub, OPTS, () => {}, () => T0, (m) => warnings.push(m));
    await w.watch([{ symbol: "JUP", pools: ["bad", "good"] }]);
    expect(w.stats().watching).toBe(1);
    expect(warnings[0]).toMatch(/could not watch pool bad/);
  });

  it("never waits for an unsubscribe reply that may never come", async () => {
    let live = 0;
    const sub: AccountSubscriber = {
      subscribe: () => ++live,
      unsubscribe: () => new Promise<void>(() => {}), // half-dead socket: no reply, ever
    };
    const w = new PoolWatcher(sub, OPTS, () => {}, () => T0);
    await w.watch([{ symbol: "JUP", pools: ["p1", "p2"] }]);
    const done = await Promise.race([
      w.watch([{ symbol: "JUP", pools: ["p3"] }]).then(() => "returned"),
      new Promise((r) => setTimeout(() => r("hung"), 500)),
    ]);
    expect(done).toBe("returned");
    expect(w.stats().watching).toBe(1);
  });

  it("gives up on a subscribe that never answers", async () => {
    const sub: AccountSubscriber = { subscribe: () => new Promise<number>(() => {}), unsubscribe: () => {} };
    const warnings: string[] = [];
    const w = new PoolWatcher(sub, OPTS, () => {}, () => T0, (m) => warnings.push(m));
    await w.watch([{ symbol: "JUP", pools: ["p1"] }]);
    expect(w.stats().watching).toBe(0);
    expect(warnings[0]).toMatch(/no answer/);
  }, 10_000);
});
