import { describe, expect, it } from "vitest";
import { DEFAULT_TOKENS, loadConfig, parseShard, shardTokens } from "../src/config.js";

const found = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`T${i}`, `Mint${i * 7919}x${i}`]));

describe("splitting tokens between phones", () => {
  it("reads SHARD like 1/2, defaults to a single phone, rejects nonsense", () => {
    expect(parseShard(undefined)).toEqual({ index: 1, count: 1 });
    expect(parseShard(" 2 / 2 ")).toEqual({ index: 2, count: 2 });
    expect(() => parseShard("3/2")).toThrow(/between 1 and 2/);
    expect(() => parseShard("phone2")).toThrow(/like 1\/2/);
    expect(loadConfig({ SHARD: "1/2" }).shard).toEqual({ index: 1, count: 2 });
  });

  it("a single phone watches everything", () => {
    expect(shardTokens(DEFAULT_TOKENS, found, { index: 1, count: 1 })).toEqual({ ...found, ...DEFAULT_TOKENS });
  });

  it("two phones split the starting list evenly, every token watched by exactly one phone", () => {
    const p1 = shardTokens(DEFAULT_TOKENS, {}, { index: 1, count: 2 });
    const p2 = shardTokens(DEFAULT_TOKENS, {}, { index: 2, count: 2 });
    expect(Object.keys(p1)).toEqual(["SOL", "BONK", "JTO"]);
    expect(Object.keys(p2)).toEqual(["JUP", "WIF", "RAY"]);
  });

  it("found tokens are split too, and both phones agree even if they found different ones", () => {
    const all = Object.keys(found);
    const p1 = Object.keys(shardTokens({}, found, { index: 1, count: 2 }));
    const p2 = Object.keys(shardTokens({}, found, { index: 2, count: 2 }));
    expect([...p1, ...p2].sort()).toEqual([...all].sort()); // nothing missed
    expect(p1.filter((t) => p2.includes(t))).toEqual([]); // nothing doubled
    expect(p1.length).toBeGreaterThan(10); // roughly balanced
    expect(p2.length).toBeGreaterThan(10);

    // Phone 2 only found half of them: each token still goes to the same phone.
    const partial = Object.fromEntries(Object.entries(found).slice(0, 20));
    const p2partial = Object.keys(shardTokens({}, partial, { index: 2, count: 2 }));
    expect(p2partial.every((t) => p2.includes(t))).toBe(true);
  });
});
