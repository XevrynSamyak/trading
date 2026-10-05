import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonWithBackup, writeJsonAtomic } from "../src/atomic.js";
import { Brain } from "../src/brain.js";
import { Ledger, basisOf, totalsByBasis, type TradeRecord } from "../src/ledger.js";

const dir = () => mkdtempSync(join(tmpdir(), "persist-"));

describe("crash-safe saves", () => {
  it("keeps a backup and falls back to it when the main file is corrupt", () => {
    const p = join(dir(), "state.json");
    writeJsonAtomic(p, { v: 1 }, { backup: true });
    writeJsonAtomic(p, { v: 2 }, { backup: true });
    expect(readJsonWithBackup<{ v: number }>(p)).toEqual({ value: { v: 2 }, fromBackup: false });
    writeFileSync(p, '{"v": 3, "half-writ'); // simulated crash mid-write
    expect(readJsonWithBackup<{ v: number }>(p)).toEqual({ value: { v: 1 }, fromBackup: true });
    expect(existsSync(`${p}.tmp`)).toBe(false);
  });

  it("the brain survives a corrupted file", () => {
    const p = join(dir(), "brain.json");
    const b = new Brain(p, { baseMinProfitBps: 20 });
    b.observeTrade("A", "failed", -0.001);
    b.save();
    b.save(); // second save moves the first to .bak
    writeFileSync(p, "garbage");
    const again = new Brain(p, { baseMinProfitBps: 20 });
    expect(again.restoredFromBackup).toBe(true);
    expect(again.minProfitBps).toBe(25);
  });
});

describe("ledger labels", () => {
  const rec = (o: Partial<TradeRecord>): TradeRecord => ({
    ts: 1, mode: "paper", symbol: "SOL", status: "filled", inUsd: 10, netUsd: 0.01, feeUsd: 0.001, ...o,
  });

  it("infers quoted / simulated / realized for old records", () => {
    expect(basisOf(rec({}))).toBe("quoted");
    expect(basisOf(rec({ verified: true }))).toBe("simulated");
    expect(basisOf(rec({ mode: "live", verified: true }))).toBe("realized");
    expect(basisOf(rec({ mode: "micro" }))).toBe("realized");
  });

  it("never mixes quoted amounts with real ones", () => {
    const t = totalsByBasis([rec({ netUsd: 0.05 }), rec({ verified: true, netUsd: -0.01 }), rec({ status: "skipped" })]);
    expect(t.quoted).toEqual({ count: 1, wins: 1, netUsd: 0.05 });
    expect(t.simulated).toEqual({ count: 1, wins: 0, netUsd: -0.01 });
    expect(t.realized.count).toBe(0);
  });

  it("keeps records in memory after the first read, skips a torn last line", () => {
    const p = join(dir(), "trades.jsonl");
    writeFileSync(p, JSON.stringify(rec({ netUsd: 1 })) + "\n" + '{"ts": 2, "mo');
    const l = new Ledger(p);
    expect(l.all()).toHaveLength(1);
    l.append(rec({ netUsd: 2, verified: true }));
    expect(l.all()).toHaveLength(2);
    expect(l.pnlBetween(0, undefined, undefined, ["simulated"])).toBe(2);
  });
});
