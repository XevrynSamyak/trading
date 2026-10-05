import { join } from "node:path";
import { loadConfig, type Mode } from "./config.js";
import { Funnel, STAGES, type OppRecord } from "./funnel.js";

/**
 * `npm run backtest`: replays the recorded opportunities (data/opps-*.jsonl)
 * under other settings, to see which rules would have done better.
 *
 * It can only judge candidates the bot actually acted on. A stricter rule is
 * a subset of what happened, so its result is known; a looser rule would need
 * quotes nobody re-checked, so it cannot be judged here (paper mode is how to
 * find out). Money is realized (real trades) when there are any, otherwise
 * simulated on-chain; quote-only amounts are shown apart and are never profit.
 */
export interface Outcome {
  acted: number;
  /** Still there at the fresh re-quote. */
  executable: number;
  simulatedOk: number;
  landed: number;
  profitable: number;
  moneyUsd: number;
  moneyBasis: "realized" | "simulated" | "none";
  /** Sum of quoted net amounts at decision time: NOT profit. */
  quotedUsd: number;
}

const reached = (r: OppRecord, stage: OppRecord["stage"]) => STAGES.indexOf(r.stage) >= STAGES.indexOf(stage);

export function outcomeOf(opps: OppRecord[]): Outcome {
  const landed = opps.filter((r) => r.realized?.landed);
  const sims = opps.filter((r) => r.simulated?.ok);
  const moneyBasis = landed.length ? "realized" : sims.length ? "simulated" : "none";
  const moneyUsd =
    moneyBasis === "realized"
      ? landed.reduce((s, r) => s + r.realized!.netUsd, 0)
      : moneyBasis === "simulated"
        ? sims.reduce((s, r) => s + r.simulated!.netUsd, 0)
        : 0;
  return {
    acted: opps.length,
    executable: opps.filter((r) => reached(r, "executable")).length,
    simulatedOk: sims.length,
    landed: landed.length,
    profitable: landed.filter((r) => r.realized!.netUsd > 0).length,
    moneyUsd,
    moneyBasis,
    quotedUsd: opps.reduce((s, r) => s + r.quoted.netUsd, 0),
  };
}

export interface Scenario {
  name: string;
  keep: (r: OppRecord) => boolean;
}

/** Value used to judge a token: realized if it has real trades, else simulated, else nothing. */
function evidenceUsd(r: OppRecord): number | null {
  if (r.realized?.landed) return r.realized.netUsd;
  if (r.simulated) return r.simulated.ok ? r.simulated.netUsd : 0;
  return null;
}

export function scenarios(opps: OppRecord[]): Scenario[] {
  const out: Scenario[] = [{ name: "as recorded", keep: () => true }];
  for (const bps of [30, 50, 100]) out.push({ name: `quoted net >= ${bps}bps`, keep: (r) => r.quoted.netBps >= bps });
  for (const usd of [0.005, 0.02]) out.push({ name: `expected value >= $${usd}`, keep: (r) => r.expected.evUsd >= usd });
  for (const bps of [10, 30]) out.push({ name: `price impact <= ${bps}bps`, keep: (r) => r.costs.priceImpactBps <= bps });
  out.push({ name: "quote <= 500ms old at decision", keep: (r) => r.lat.quoteToDecisionMs <= 500 });
  const kinds = new Set(opps.map((r) => r.kind));
  if (kinds.size > 1) for (const k of kinds) out.push({ name: `${k} only`, keep: (r) => r.kind === k });
  const evented = opps.some((r) => r.t.market !== undefined);
  const polled = opps.some((r) => r.t.market === undefined);
  if (evented && polled) {
    out.push({ name: "event-triggered only", keep: (r) => r.t.market !== undefined });
    out.push({ name: "polled only", keep: (r) => r.t.market === undefined });
  }
  // Leave out the token with the worst evidence (needs on-chain results to judge).
  const byToken = new Map<string, number>();
  for (const r of opps) {
    const v = evidenceUsd(r);
    if (v !== null) byToken.set(r.symbol, (byToken.get(r.symbol) ?? 0) + v);
  }
  const worst = [...byToken].sort((a, b) => a[1] - b[1])[0];
  if (worst && byToken.size > 1 && worst[1] < 0) out.push({ name: `without ${worst[0]}`, keep: (r) => r.symbol !== worst[0] });
  return out;
}

/** How fast gaps die: share still there at the fresh re-quote, by how old the scan quote was then. */
export function survivalByAge(opps: OppRecord[]): { bucket: string; n: number; stillThere: number }[] {
  const edges = [250, 500, 1_000, 2_000, 5_000];
  const label = (ms: number) => {
    const i = edges.findIndex((e) => ms < e);
    return i === -1 ? `>= ${edges[edges.length - 1]} ms` : i === 0 ? `< ${edges[0]} ms` : `${edges[i - 1]}-${edges[i]} ms`;
  };
  const order = [`< ${edges[0]} ms`, ...edges.slice(1).map((e, i) => `${edges[i]}-${e} ms`), `>= ${edges[edges.length - 1]} ms`];
  const rows = new Map(order.map((b) => [b, { bucket: b, n: 0, stillThere: 0 }]));
  for (const r of opps) {
    if (r.t.requoteEnd === undefined) continue;
    const row = rows.get(label(r.t.requoteEnd - r.t.quoteEnd))!;
    row.n += 1;
    if (reached(r, "executable")) row.stillThere += 1;
  }
  return order.map((b) => rows.get(b)!).filter((r) => r.n > 0);
}

/** Sizes the ladder compared (quoted at decision time only; not profit). */
export function sizePolicies(opps: OppRecord[]): { name: string; n: number; quotedUsd: number }[] {
  const withLadder = opps.filter((r) => (r.ladder?.length ?? 0) > 1);
  if (!withLadder.length) return [];
  const pick = (f: (pts: NonNullable<OppRecord["ladder"]>) => number) =>
    withLadder.reduce((s, r) => s + f(r.ladder!), 0);
  return [
    { name: "size the ladder chose", n: withLadder.length, quotedUsd: withLadder.reduce((s, r) => s + r.quoted.netUsd, 0) },
    { name: "always the smallest size", n: withLadder.length, quotedUsd: pick((p) => p[0].netUsd) },
    { name: "always the largest size", n: withLadder.length, quotedUsd: pick((p) => p[p.length - 1].netUsd) },
  ];
}

const usd = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(4)}`;
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : "n/a");

export function renderBacktest(opps: OppRecord[]): string {
  const out: string[] = [];
  out.push(`Backtest over ${opps.length} recorded opportunities (what the bot actually acted on).`);
  if (!opps.length) {
    out.push("Nothing recorded yet: let the bot run in paper mode first.");
    return out.join("\n");
  }
  const base = outcomeOf(opps);
  out.push(
    base.moneyBasis === "none"
      ? "No on-chain results yet (quote-only paper mode): only 'still there at re-quote' can be compared. Set WALLET_PUBLIC_KEY for simulated results."
      : `Money column: ${base.moneyBasis} results only. Quoted amounts are shown apart and are not profit.`,
  );
  out.push("");
  out.push("Rule                               acted  still there  sim OK  landed  money            quoted (NOT profit)");
  for (const sc of scenarios(opps)) {
    const o = outcomeOf(opps.filter(sc.keep));
    out.push(
      `${sc.name.padEnd(34)} ${String(o.acted).padStart(5)}  ${pct(o.executable, o.acted).padStart(11)}  ${String(o.simulatedOk).padStart(6)}  ` +
        `${String(o.landed).padStart(6)}  ${(o.moneyBasis === "none" ? "n/a" : usd(o.moneyUsd)).padEnd(15)}  ${usd(o.quotedUsd)}`,
    );
  }
  const surv = survivalByAge(opps);
  if (surv.length) {
    out.push("");
    out.push("How fast gaps die (scan quote age at the fresh re-quote -> share still there)");
    for (const r of surv) out.push(`  ${r.bucket.padEnd(14)} ${pct(r.stillThere, r.n).padStart(5)}  (n=${r.n})`);
  }
  const sizes = sizePolicies(opps);
  if (sizes.length) {
    out.push("");
    out.push("Size policies (quoted at decision time only; NOT profit)");
    for (const s of sizes) out.push(`  ${s.name.padEnd(28)} ${usd(s.quotedUsd)}  (n=${s.n})`);
  }
  out.push("");
  out.push("Looser rules can't be judged from this data: candidates below the bar were never re-checked.");
  return out.join("\n");
}

if (process.argv[1]?.endsWith("backtest.ts")) {
  const cfg = loadConfig();
  const arg = process.argv.find((a) => a.startsWith("--mode="))?.slice(7) as Mode | undefined;
  const modes: Mode[] = arg ? [arg] : ["paper", "micro", "live"];
  const opps = modes.flatMap((m) => Funnel.read(join(cfg.dataDir, `opps-${m}.jsonl`)));
  console.log(renderBacktest(opps));
}
