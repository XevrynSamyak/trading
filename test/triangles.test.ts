import { describe, expect, it } from "vitest";
import { USDC_MINT } from "../src/config.js";
import { Rotation, triangleSpecs } from "../src/triangles.js";

describe("triangular cycles", () => {
  it("builds both directions through the pivot for every other token", () => {
    const specs = triangleSpecs({ SOL: "sol", JUP: "jup", WIF: "wif" }, "SOL");
    expect(specs.map((s) => s.symbol)).toEqual(["SOL>JUP", "JUP>SOL", "SOL>WIF", "WIF>SOL"]);
    expect(specs[0]).toEqual({ kind: "triangle", symbol: "SOL>JUP", tokens: ["SOL", "JUP"], path: [USDC_MINT, "sol", "jup", USDC_MINT] });
    expect(triangleSpecs({ JUP: "jup", WIF: "wif" }, "SOL")).toEqual([]); // no pivot, no triangles
  });

  it("takes a few at a time, in turn", () => {
    const r = new Rotation<string>();
    const items = ["a", "b", "c", "d", "e"];
    expect(r.take(items, 2)).toEqual(["a", "b"]);
    expect(r.take(items, 2)).toEqual(["c", "d"]);
    expect(r.take(items, 2)).toEqual(["e", "a"]);
    expect(r.take(["x"], 3)).toEqual(["x"]);
    expect(r.take([], 2)).toEqual([]);
  });
});
