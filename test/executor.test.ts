import { Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { USDC_MINT, loadConfig } from "../src/config.js";
import { valueCycle, type CostSettings, type Valuation } from "../src/costs.js";
import { triangleSpec, twoLegSpec, type Cycle, type CycleSpec } from "../src/cycle.js";
import { failedLegOf, liveExecute, quoteOnlyExecute, simulateExecute, type ExecDeps } from "../src/executor.js";
import type { JitoClient } from "../src/jito.js";
import type { JupiterClient, QuoteResponse } from "../src/jupiter.js";
import { usdcAta } from "../src/wallet.js";

const SOL_PRICE = 120;
const TOKEN = Keypair.generate().publicKey.toBase58();
const TOKEN_B = Keypair.generate().publicKey.toBase58();
const DEX = Keypair.generate().publicKey;

/** Fixed 10 000-lamport tip, no buffer: same fee math as the original tests. */
const COSTS: CostSettings = {
  priorityFeeLamports: 1_000, sendVia: "jito", tipShare: 0, minTipLamports: 10_000, maxTipLamports: 10_000,
  safetyBufferBps: 0, safetyBufferUsd: 0,
};
const NETWORK_USD = ((5_000 + 1_000 + 10_000) / 1e9) * SOL_PRICE;

const quote = (input: string, output: string, inAmt: bigint, outAmt: bigint, threshold = outAmt): QuoteResponse => ({
  inputMint: input, outputMint: output, inAmount: inAmt.toString(), outAmount: outAmt.toString(),
  otherAmountThreshold: threshold.toString(), slippageBps: 0, priceImpactPct: "0",
  routePlan: [{ swapInfo: { label: "Fake", ammKey: `pool-${input.slice(0, 4)}-${output.slice(0, 4)}` } }],
});

/** A candidate as the scanner would produce it: $10 -> ... -> $10.10 (a 1% gap). */
function candidate(spec: CycleSpec = twoLegSpec("TKN", TOKEN)): { cycle: Cycle; val: Valuation } {
  const n = spec.path.length - 1;
  const legs = Array.from({ length: n }, (_, i) =>
    quote(spec.path[i], spec.path[i + 1], i === 0 ? 10_000_000n : 10_100_000n, 10_100_000n),
  );
  const cycle: Cycle = {
    ...spec, inAtoms: 10_000_000n, legs, outAtoms: 10_100_000n, quoteStartedAt: 0, quotedAt: 0,
    routes: "Fake | Fake", priceImpactBps: 0, dexFeeBps: 0, pools: [],
  };
  return { cycle, val: valueCycle(cycle, SOL_PRICE, COSTS) };
}

/** Fake Jupiter: every quote returns 10.1 units; records each quote request. */
function fakeJup(lastLegThreshold?: bigint) {
  const quotes: { inputMint: string; outputMint: string; slippageBps: number }[] = [];
  const jup = {
    async quote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }) {
      quotes.push({ inputMint: p.inputMint, outputMint: p.outputMint, slippageBps: p.slippageBps });
      const out = 10_100_000n;
      const min =
        p.outputMint === USDC_MINT && lastLegThreshold !== undefined
          ? lastLegThreshold
          : (out * BigInt(10_000 - p.slippageBps)) / 10_000n;
      return quote(p.inputMint, p.outputMint, p.amount, out, min);
    },
    async swapInstructions(_q: QuoteResponse, user: string) {
      const ix = {
        programId: DEX.toBase58(),
        accounts: [
          { pubkey: user, isSigner: true, isWritable: true },
          { pubkey: Keypair.generate().publicKey.toBase58(), isSigner: false, isWritable: true },
        ],
        data: Buffer.from([1, 2, 3]).toString("base64"),
      };
      return { computeBudgetInstructions: [], setupInstructions: [], swapInstruction: ix, cleanupInstruction: null, addressLookupTableAddresses: [] };
    },
  } as unknown as JupiterClient;
  return { jup, quotes };
}

const tokenAccountData = (amount: bigint) => {
  const buf = Buffer.alloc(165);
  buf.writeBigUInt64LE(amount, 64);
  return buf.toString("base64");
};

interface FakeChain {
  simErr?: unknown;
  usdcBefore: bigint;
  usdcAfter: bigint;
  lamportsBefore: number;
  lamportsAfter: number;
  lands: boolean;
  /** Status lookups never answer and the blockhash never expires (for the timeout test). */
  hangs?: boolean;
  landErr?: unknown;
}

function fakeConn(chain: FakeChain) {
  let landed = false;
  return {
    async getAddressLookupTable() { return { value: null }; },
    async getLatestBlockhash() { return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }; },
    async getTokenAccountBalance() { return { value: { amount: chain.usdcBefore.toString() } }; },
    async simulateTransaction() {
      return { value: { err: chain.simErr ?? null, accounts: [{ data: [tokenAccountData(chain.usdcAfter), "base64"] }] } };
    },
    async getBalance() { return landed ? chain.lamportsAfter : chain.lamportsBefore; },
    async getParsedTokenAccountsByOwner() {
      const amount = (landed ? chain.usdcAfter : chain.usdcBefore).toString();
      const usdc = { lamports: 2_039_280, data: { parsed: { info: { mint: USDC_MINT, tokenAmount: { amount } } } } };
      // After landing, a new token account holds a refundable deposit.
      const other = { lamports: 2_039_280, data: { parsed: { info: { mint: TOKEN, tokenAmount: { amount: "0" } } } } };
      return { value: (landed ? [usdc, other] : [usdc]).map((account) => ({ account })) };
    },
    async getTransaction() { return { meta: { fee: 6_000 } }; },
    async getSignatureStatuses() {
      if (chain.hangs || !chain.lands) return { value: [null] };
      landed = true;
      return { value: [{ confirmationStatus: "confirmed", err: chain.landErr ?? null }] };
    },
    async getBlockHeight() { return chain.hangs ? 50 : 101; },
  } as unknown as ExecDeps["conn"];
}

const cfg = loadConfig({});
const tip = Keypair.generate().publicKey;
const deps = (conn: ExecDeps["conn"], jup: JupiterClient, extra: Partial<ExecDeps> = {}): ExecDeps => ({
  conn, jup, cfg, costSettings: COSTS, solPriceUsd: SOL_PRICE, tipAccount: tip, floorBps: 20, ...extra,
});

describe("on-chain simulation (realistic paper mode)", () => {
  const owner = Keypair.generate().publicKey;

  it("reports what the trade would really make", async () => {
    const conn = fakeConn({ usdcBefore: 20_000_000n, usdcAfter: 20_100_000n, lamportsBefore: 0, lamportsAfter: 0, lands: true });
    const { cycle, val } = candidate();
    const r = await simulateExecute(cycle, val, owner, deps(conn, fakeJup().jup));
    expect(r).toMatchObject({ status: "filled", verified: true });
    expect(r.netUsd).toBeCloseTo(0.1 - NETWORK_USD, 9);
    expect(r.simulatedNetUsd).toBeCloseTo(0.1 - NETWORK_USD, 9);
    expect(r.executable?.netUsd).toBeCloseTo(0.1 - NETWORK_USD, 9);
  });

  it("re-quotes EVERY leg right before building (the first leg is never stale)", async () => {
    const conn = fakeConn({ usdcBefore: 20_000_000n, usdcAfter: 20_100_000n, lamportsBefore: 0, lamportsAfter: 0, lands: true });
    const { jup, quotes } = fakeJup();
    const { cycle, val } = candidate();
    await simulateExecute(cycle, val, owner, deps(conn, jup));
    expect(quotes.map((q) => [q.inputMint, q.outputMint])).toEqual([
      [USDC_MINT, TOKEN], // leg 1, fresh
      [TOKEN, USDC_MINT], // leg 2, fresh, carrying the profit floor
    ]);
    expect(quotes[0].slippageBps).toBe(0);
    expect(quotes[1].slippageBps).toBeGreaterThan(0);
  });

  it("marks a gap that would revert as fake, at no cost, and says which leg failed", async () => {
    const leg1Fail = fakeConn({ simErr: { InstructionError: [2, { Custom: 6001 }] }, usdcBefore: 1n, usdcAfter: 1n, lamportsBefore: 0, lamportsAfter: 0, lands: false });
    const { cycle, val } = candidate();
    const r = await simulateExecute(cycle, val, owner, deps(leg1Fail, fakeJup().jup));
    expect(r).toMatchObject({ status: "rejected", netUsd: 0, feeUsd: 0, verified: true, failedLeg: 1 });
    expect(r.reason).toMatch(/leg 1\/2: price moved/);

    const leg2Fail = fakeConn({ simErr: { InstructionError: [3, { Custom: 6001 }] }, usdcBefore: 1n, usdcAfter: 1n, lamportsBefore: 0, lamportsAfter: 0, lands: false });
    const r2 = await simulateExecute(cycle, val, owner, deps(leg2Fail, fakeJup().jup));
    expect(r2.failedLeg).toBe(2);
  });

  it("calls it stale when the gap is gone at the fresh re-quote (nothing is built)", async () => {
    const conn = fakeConn({ usdcBefore: 1n, usdcAfter: 1n, lamportsBefore: 0, lamportsAfter: 0, lands: false });
    const { cycle, val } = candidate();
    const r = await simulateExecute(cycle, val, owner, deps(conn, fakeJup(9_000_000n).jup));
    expect(r.status).toBe("stale");
    expect(r.reason).toMatch(/gap gone at fresh re-quote/);
    expect(r.executable).toBeDefined();
  });

  it("derives the standard USDC account deterministically", () => {
    expect(usdcAta(owner).equals(usdcAta(owner))).toBe(true);
    expect(PublicKey.isOnCurve(usdcAta(owner).toBytes())).toBe(false); // PDAs are off-curve
  });
});

describe("quote-only paper mode", () => {
  it("re-quotes every leg and reports the executable edge, labelled unverified", async () => {
    const conn = fakeConn({ usdcBefore: 1n, usdcAfter: 1n, lamportsBefore: 0, lamportsAfter: 0, lands: false });
    const { cycle, val } = candidate();
    const r = await quoteOnlyExecute(cycle, val, deps(conn, fakeJup().jup));
    expect(r).toMatchObject({ status: "filled", verified: false });
    expect(r.executable?.netUsd).toBeCloseTo(0.1 - NETWORK_USD, 9);
    const gone = await quoteOnlyExecute(cycle, val, deps(conn, fakeJup(9_000_000n).jup));
    expect(gone.status).toBe("stale");
  });
});

describe("real trading via Jito (micro/live)", () => {
  const wallet = Keypair.generate();

  function fakeJito() {
    const sent: VersionedTransaction[] = [];
    const jito = {
      async getTipAccounts() { return [tip.toBase58()]; },
      async sendTransaction(b64: string) {
        sent.push(VersionedTransaction.deserialize(Buffer.from(b64, "base64")));
        return "sig123";
      },
    } as unknown as JitoClient;
    return { jito, sent };
  }

  const programsOf = (tx: VersionedTransaction) => {
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    return { keys, programs: tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]) };
  };

  it("sends one signed transaction with both legs and the tip, and measures realized profit", async () => {
    const { jito, sent } = fakeJito();
    // SOL drops by fee + tip + a 0.00204 SOL deposit for the new token account.
    const conn = fakeConn({ usdcBefore: 20_000_000n, usdcAfter: 20_100_000n, lamportsBefore: 50_000_000, lamportsAfter: 50_000_000 - 16_000 - 2_039_280, lands: true });
    const { cycle, val } = candidate();
    const r = await liveExecute(cycle, val, wallet, { ...deps(conn, fakeJup().jup), jito });

    expect(r.status).toBe("filled");
    expect(r.signature).toBe("sig123");
    // Only fee (6000) + tip (10000) count; the refundable deposit does not.
    expect(r.netUsd).toBeCloseTo(0.1 - (16_000 / 1e9) * SOL_PRICE, 9);
    expect(r.t.submitted).toBeDefined();
    expect(r.t.landed).toBeDefined();

    const { keys, programs } = programsOf(sent[0]);
    expect(programs.filter((p) => p === DEX.toBase58())).toHaveLength(2); // both legs, one transaction
    expect(programs.at(-1)).toBe(SystemProgram.programId.toBase58()); // tip is last
    expect(keys).toContain(tip.toBase58());
    expect(sent[0].signatures[0].some((b) => b !== 0)).toBe(true); // really signed
  });

  it("puts all three legs of a triangle in one transaction", async () => {
    const { jito, sent } = fakeJito();
    const conn = fakeConn({ usdcBefore: 20_000_000n, usdcAfter: 20_100_000n, lamportsBefore: 50_000_000, lamportsAfter: 49_984_000, lands: true });
    const { cycle, val } = candidate(triangleSpec(["AAA", TOKEN], ["BBB", TOKEN_B]));
    const { jup, quotes } = fakeJup();
    const r = await liveExecute(cycle, val, wallet, { ...deps(conn, jup), jito });
    expect(r.status).toBe("filled");
    expect(quotes).toHaveLength(3); // every leg re-quoted
    expect(programsOf(sent[0]).programs.filter((p) => p === DEX.toBase58())).toHaveLength(3);
  });

  it("does not send at all when the free simulation says it would revert", async () => {
    const { jito, sent } = fakeJito();
    const conn = fakeConn({ simErr: "boom", usdcBefore: 1n, usdcAfter: 1n, lamportsBefore: 0, lamportsAfter: 0, lands: false });
    const { cycle, val } = candidate();
    const r = await liveExecute(cycle, val, wallet, { ...deps(conn, fakeJup().jup), jito });
    expect(r.status).toBe("rejected");
    expect(sent).toHaveLength(0);
  });

  it("costs nothing when Jito drops it", async () => {
    const { jito } = fakeJito();
    const conn = fakeConn({ usdcBefore: 1n, usdcAfter: 1n, lamportsBefore: 0, lamportsAfter: 0, lands: false });
    const { cycle, val } = candidate();
    const r = await liveExecute(cycle, val, wallet, { ...deps(conn, fakeJup().jup), jito });
    expect(r).toMatchObject({ status: "rejected", netUsd: 0, feeUsd: 0, reason: "did not land (no fee paid)" });
  });

  it("reports a landed-but-failed transaction with its fee and the failing leg", async () => {
    const { jito } = fakeJito();
    const conn = fakeConn({ usdcBefore: 20_000_000n, usdcAfter: 20_000_000n, lamportsBefore: 50_000_000, lamportsAfter: 49_984_000, lands: true, landErr: { InstructionError: [3, { Custom: 6001 }] } });
    const { cycle, val } = candidate();
    const r = await liveExecute(cycle, val, wallet, { ...deps(conn, fakeJup().jup), jito });
    expect(r).toMatchObject({ status: "failed", failedLeg: 2, verified: true });
    expect(r.netUsd).toBeCloseTo(-(16_000 / 1e9) * SOL_PRICE, 9);
  });

  it("times out instead of hanging when landing can't be confirmed", async () => {
    const { jito } = fakeJito();
    const conn = fakeConn({ usdcBefore: 1n, usdcAfter: 1n, lamportsBefore: 0, lamportsAfter: 0, lands: false, hangs: true });
    let clock = 0;
    const { cycle, val } = candidate();
    const r = await liveExecute(cycle, val, wallet, {
      ...deps(conn, fakeJup().jup, { cfg: { ...cfg, landingTimeoutMs: 5_000 }, now: () => (clock += 10_000) }),
      jito,
    });
    expect(r.status).toBe("timeout");
    expect(r.reason).toMatch(/could not confirm/);
  });

  it("refuses to trade via Jito without a tip account", async () => {
    const { jito } = fakeJito();
    const conn = fakeConn({ usdcBefore: 1n, usdcAfter: 1n, lamportsBefore: 0, lamportsAfter: 0, lands: true });
    const { cycle, val } = candidate();
    const r = await liveExecute(cycle, val, wallet, { ...deps(conn, fakeJup().jup, { tipAccount: undefined }), jito });
    expect(r).toMatchObject({ status: "skipped", reason: "Jito not available" });
  });
});

describe("failing-leg attribution", () => {
  it("maps an instruction index to its leg", () => {
    const ranges: [number, number][] = [[2, 4], [5, 6]];
    expect(failedLegOf({ InstructionError: [3, {}] }, ranges)).toBe(1);
    expect(failedLegOf({ InstructionError: [6, {}] }, ranges)).toBe(2);
    expect(failedLegOf({ InstructionError: [0, {}] }, ranges)).toBe(0); // compute budget / tip
    expect(failedLegOf("BlockhashNotFound", ranges)).toBeUndefined();
  });
});

describe("wallet value", () => {
  it("counts token-account deposits as the owner's money, not a loss", async () => {
    const { getBalances, walletValueUsd } = await import("../src/wallet.js");
    const conn = fakeConn({ usdcBefore: 20_000_000n, usdcAfter: 20_000_000n, lamportsBefore: 50_000_000, lamportsAfter: 0, lands: false });
    const b = await getBalances(conn, Keypair.generate().publicKey);
    expect(b).toEqual({ lamports: 50_000_000, usdcAtoms: 20_000_000n, rentLamports: 2_039_280 });
    expect(walletValueUsd(b, 100)).toBeCloseTo(20 + 0.05203928 * 100, 6);
  });
});

describe("balance cache (saves RPC credits)", () => {
  it("reads balances at most once a minute, and again right after invalidate()", async () => {
    const { BalanceCache } = await import("../src/wallet.js");
    const conn = fakeConn({ usdcBefore: 5_000_000n, usdcAfter: 5_000_000n, lamportsBefore: 1, lamportsAfter: 1, lands: false });
    let reads = 0;
    const orig = conn.getBalance.bind(conn);
    (conn as unknown as { getBalance: typeof orig }).getBalance = async (...a: Parameters<typeof orig>) => {
      reads++;
      return orig(...a);
    };
    const cache = new BalanceCache(conn, Keypair.generate().publicKey, 60_000);
    await cache.get(0);
    await cache.get(30_000);
    await cache.get(59_999);
    expect(reads).toBe(1);
    await cache.get(60_000);
    expect(reads).toBe(2);
    cache.invalidate();
    await cache.get(60_001);
    expect(reads).toBe(3);
  });
});
