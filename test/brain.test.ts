import { mkdtempSync } from "node:fs";
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
