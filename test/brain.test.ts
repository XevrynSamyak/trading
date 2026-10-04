import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Brain } from "../src/brain.js";

const tokens = { A: "a", B: "b", C: "c", D: "d" };
const tmp = () => join(mkdtempSync(join(tmpdir(), "brain-")), "brain.json");

describe("Brain", () => {
  it("tries every token first, then focuses on the ones with an edge", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20, tokensPerCycle: 2, exploreRate: 0 });
    for (let i = 0; i < 20; i++) {
      b.observeScan("A", -30);
      b.observeScan("B", 15);
      b.observeScan("C", -40);
      b.observeScan("D", 5);
    }
    expect(Object.keys(b.pickTokens(tokens)).sort()).toEqual(["B", "D"]);
  });

  it("gets pickier after failures and looser after wins, within bounds", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20 });
    b.observeTrade("A", "failed", -0.001);
    expect(b.minProfitBps).toBe(25);
    for (let i = 0; i < 50; i++) b.observeTrade("A", "filled", 0.01);
    expect(b.minProfitBps).toBe(10); // floor = base / 2
    for (let i = 0; i < 50; i++) b.observeTrade("A", "failed", -0.001);
    expect(b.minProfitBps).toBe(80); // ceiling = base * 4
  });

  it("remembers what it learned across restarts", () => {
    const path = tmp();
    const b = new Brain(path, { baseMinProfitBps: 20 });
    b.observeTrade("A", "failed", -0.001);
    b.save();
    expect(new Brain(path, { baseMinProfitBps: 20 }).minProfitBps).toBe(25);
  });
});

describe("Brain: smarter skills", () => {
  it("tries each trade size, then sticks with the one that nets the most dollars", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20, exploreRate: 0 });
    // warm-up: untested sizes come first
    expect(b.pickSize("A", 20).bucket).toBe(0.25);
    const net: Record<number, number> = { 0.25: -0.001, 0.5: 0.004, 1: -0.01 };
    for (let i = 0; i < 10; i++) {
      const { bucket } = b.pickSize("A", 20);
      b.observeScan("A", 0, net[bucket], bucket, 0);
    }
    expect(b.pickSize("A", 20)).toEqual({ usd: 10, bucket: 0.5 });
  });

  it("never picks a size below $1", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20 });
    expect(b.pickSize("A", 2)).toEqual({ usd: 2, bucket: 1 });
  });

  it("scans faster when a gap is close and slower when nothing is", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20 });
    expect(b.nextIntervalMs(18, 15_000, 0)).toBe(8_000); // 2bps short -> fast (clamped to 8s)
    expect(b.nextIntervalMs(5, 15_000, 0)).toBe(15_000);
    expect(b.nextIntervalMs(-50, 15_000, 0)).toBe(22_500); // far away -> slow down
  });

  it("learns which hours are good", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20 });
    for (let h = 0; h < 8; h++) b.observeScan("A", -20 - h, 0, 1, h); // -20 .. -27
    b.observeScan("A", 10, 0, 1, 14);
    expect(b.isGoodHour(14)).toBe(true);
    expect(b.isGoodHour(7)).toBe(false);
    expect(b.isGoodHour(20)).toBeNull(); // never seen
    expect(b.nextIntervalMs(5, 15_000, 14)).toBe(12_000);
  });

  it("adds discovered tokens, keeps configured ones, and forgets useless finds", () => {
    const b = new Brain(tmp(), { baseMinProfitBps: 20 });
    const configured = { SOL: "sol-mint" };
    const added = b.learnTokens({ SOL: "sol-mint", NEW: "new-mint", MORE: "more-mint" }, configured, 2);
    expect(added).toEqual(["NEW"]); // SOL already known; cap of 2 reached
    expect(Object.keys(b.tokenPool(configured)).sort()).toEqual(["NEW", "SOL"]);

    for (let i = 0; i < 60; i++) b.observeScan("NEW", -50);
    b.learnTokens({ MORE: "more-mint" }, configured, 2);
    expect(Object.keys(b.tokenPool(configured)).sort()).toEqual(["MORE", "SOL"]);
  });

  it("upgrades an old brain file without losing what it learned", () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ tokens: { A: { scans: 5, avgEdgeBps: -3, fills: 0, failures: 0, pnlUsd: 0 } }, minProfitBps: 25, totalScans: 5 }));
    const b = new Brain(path, { baseMinProfitBps: 20 });
    expect(b.minProfitBps).toBe(25);
    expect(b.state.hourEdgeBps).toHaveLength(24);
    expect(() => b.pickSize("A", 20)).not.toThrow();
    expect(b.summary()).toContain("A: edge -3.0bps");
  });
});
