import { SOL_MINT, USDC_MINT } from "./config.js";
import type { JupiterClient, QuoteResponse } from "./jupiter.js";
import { evaluateRoundTrip, type Evaluation } from "./profit.js";

/** Accounts per leg; two legs plus compute-budget instructions must fit one transaction. */
export const MAX_ACCOUNTS_PER_LEG = 28;

export interface Opportunity {
  symbol: string;
  mint: string;
  leg1: QuoteResponse;
  leg2: QuoteResponse;
  eval: Evaluation;
  routes: string;
}

const routeLabel = (q: QuoteResponse) => q.routePlan.map((r) => r.swapInfo.label ?? "?").join(">");

export async function quoteRoundTrip(
  jup: JupiterClient,
  symbol: string,
  mint: string,
  inAtoms: bigint,
  priorityFeeLamports: number,
  solPriceUsd: number,
): Promise<Opportunity> {
  const leg1 = await jup.quote({
    inputMint: USDC_MINT,
    outputMint: mint,
    amount: inAtoms,
    slippageBps: 0,
    maxAccounts: MAX_ACCOUNTS_PER_LEG,
  });
  const leg2 = await jup.quote({
    inputMint: mint,
    outputMint: USDC_MINT,
    amount: BigInt(leg1.outAmount),
    slippageBps: 0,
    maxAccounts: MAX_ACCOUNTS_PER_LEG,
  });
  return {
    symbol,
    mint,
    leg1,
    leg2,
    eval: evaluateRoundTrip(inAtoms, BigInt(leg2.outAmount), priorityFeeLamports, solPriceUsd),
    routes: `${routeLabel(leg1)} | ${routeLabel(leg2)}`,
  };
}

/** Quotes every token (each at its own size) and returns them best-first. Failed quotes are skipped. */
export async function scan(
  jup: JupiterClient,
  tokens: Record<string, string>,
  sizeFor: (symbol: string) => bigint,
  priorityFeeLamports: number,
  solPriceUsd: number,
  onError: (symbol: string, err: unknown) => void = () => {},
  /** If given, tokens are quoted one after another, awaiting this before each (rate-limit pacing). */
  beforeEach?: () => Promise<void>,
): Promise<Opportunity[]> {
  const entries = Object.entries(tokens);
  if (beforeEach) {
    // One token at a time: its buy and sell quotes stay back-to-back, and
    // requests are spread out instead of bursting.
    const results: Opportunity[] = [];
    for (const [symbol, mint] of entries) {
      try {
        await beforeEach();
        results.push(await quoteRoundTrip(jup, symbol, mint, sizeFor(symbol), priorityFeeLamports, solPriceUsd));
      } catch (err) {
        onError(symbol, err);
      }
    }
    return results.sort((a, b) => b.eval.netUsd - a.eval.netUsd);
  }
  // All tokens at once (no pacing hook).
  const settled = await Promise.allSettled(
    entries.map(([symbol, mint]) => quoteRoundTrip(jup, symbol, mint, sizeFor(symbol), priorityFeeLamports, solPriceUsd)),
  );
  const results: Opportunity[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") results.push(r.value);
    else onError(entries[i][0], r.reason);
  });
  return results.sort((a, b) => b.eval.netUsd - a.eval.netUsd);
}

export async function fetchSolPriceUsd(jup: JupiterClient): Promise<number> {
  const q = await jup.quote({ inputMint: SOL_MINT, outputMint: USDC_MINT, amount: 1_000_000_000n, slippageBps: 50 });
  return Number(q.outAmount) / 1e6;
}
