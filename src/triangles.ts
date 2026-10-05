import { triangleSpec, type CycleSpec } from "./cycle.js";

/**
 * Triangular cycles through a liquid pivot (SOL by default):
 *   USDC → SOL → X → USDC   and   USDC → X → SOL → USDC
 * They catch an X/SOL price that is out of line with X/USDC and SOL/USDC.
 * Jupiter's router already mixes such paths into single legs, so explicit
 * triangles mostly matter when the best route for each leg alone is not the
 * best cycle; the report shows per kind whether they ever hold up.
 * Each costs 3 quotes (one per leg), so only a few run per scan, in turn.
 */
export function triangleSpecs(tokens: Record<string, string>, pivot: string): CycleSpec[] {
  const pivotMint = tokens[pivot];
  if (!pivotMint) return [];
  const out: CycleSpec[] = [];
  for (const [sym, mint] of Object.entries(tokens)) {
    if (sym === pivot || mint === pivotMint) continue;
    out.push(triangleSpec([pivot, pivotMint], [sym, mint]), triangleSpec([sym, mint], [pivot, pivotMint]));
  }
  return out;
}

/** Hands out items a few at a time, in turn, even as the list changes. */
export class Rotation<T> {
  private next = 0;

  take(items: T[], n: number): T[] {
    if (!items.length || n <= 0) return [];
    const out: T[] = [];
    for (let i = 0; i < Math.min(n, items.length); i++) out.push(items[(this.next + i) % items.length]);
    this.next = (this.next + out.length) % items.length;
    return out;
  }
}
