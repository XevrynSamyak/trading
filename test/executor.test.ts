import { Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { USDC_MINT, loadConfig, type Config } from "../src/config.js";
import { liveExecute, simulateExecute, type ExecDeps } from "../src/executor.js";
import type { JitoClient } from "../src/jito.js";
import type { JupiterClient, QuoteResponse } from "../src/jupiter.js";
import { evaluateRoundTrip } from "../src/profit.js";
import type { Opportunity } from "../src/scanner.js";
import { usdcAta } from "../src/wallet.js";

const SOL_PRICE = 120;
const TOKEN = Keypair.generate().publicKey.toBase58();
const DEX = Keypair.generate().publicKey;

const quote = (input: string, output: string, inAmt: bigint, outAmt: bigint, threshold = outAmt): QuoteResponse => ({
  inputMint: input, outputMint: output, inAmount: inAmt.toString(), outAmount: outAmt.toString(),
  otherAmountThreshold: threshold.toString(), slippageBps: 0, priceImpactPct: "0",
  routePlan: [{ swapInfo: { label: "Fake" } }],
});

/** $10 -> token -> $10.10: a 1% gap. */
function opportunity(cfg: Config): Opportunity {
  const leg1 = quote(USDC_MINT, TOKEN, 10_000_000n, 5_000_000n);
  const leg2 = quote(TOKEN, USDC_MINT, 5_000_000n, 10_100_000n);
  return {
    symbol: "TKN", mint: TOKEN, leg1, leg2, routes: "Fake | Fake",
    eval: evaluateRoundTrip(10_000_000n, 10_100_000n, cfg.priorityFeeLamports + cfg.jitoTipLamports, SOL_PRICE),
  };
}

function fakeJup(leg2Threshold?: bigint): JupiterClient {
  return {
    async quote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }) {
      const out = 10_100_000n;
      const min = leg2Threshold ?? (out * BigInt(10_000 - p.slippageBps)) / 10_000n;
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
      if (!chain.lands) return { value: [null] };
      landed = true;
      return { value: [{ confirmationStatus: "confirmed", err: null }] };
    },
    async getBlockHeight() { return 101; },
  } as unknown as ExecDeps["conn"];
}

const cfg = loadConfig({});
const tip = Keypair.generate().publicKey;

describe("on-chain simulation (realistic paper mode)", () => {
  const owner = Keypair.generate().publicKey;

  it("reports what the trade would really make", async () => {
    const conn = fakeConn({ usdcBefore: 20_000_000n, usdcAfter: 20_100_000n, lamportsBefore: 0, lamportsAfter: 0, lands: true });
    const r = await simulateExecute(opportunity(cfg), owner, { conn, jup: fakeJup(), cfg, solPriceUsd: SOL_PRICE, tipAccount: tip });
    const fee = ((5_000 + cfg.priorityFeeLamports + cfg.jitoTipLamports) / 1e9) * SOL_PRICE;
    expect(r).toMatchObject({ status: "filled", verified: true });
    expect(r.netUsd).toBeCloseTo(0.1 - fee, 9);
  });

  it("marks a gap that would revert as fake, at no cost", async () => {
    const conn = fakeConn({ simErr: { InstructionError: [4, { Custom: 6001 }] }, usdcBefore: 1n, usdcAfter: 1n, lamportsBefore: 0, lamportsAfter: 0, lands: false });
    const r = await simulateExecute(opportunity(cfg), owner, { conn, jup: fakeJup(), cfg, solPriceUsd: SOL_PRICE });
    expect(r).toMatchObject({ status: "rejected", netUsd: 0, feeUsd: 0, verified: true });
  });

  it("skips when the price moved before building the transaction", async () => {
    const conn = fakeConn({ usdcBefore: 1n, usdcAfter: 1n, lamportsBefore: 0, lamportsAfter: 0, lands: false });
    const r = await simulateExecute(opportunity(cfg), owner, { conn, jup: fakeJup(9_000_000n), cfg, solPriceUsd: SOL_PRICE });
    expect(r).toMatchObject({ status: "skipped", reason: "price moved before execution" });
  });

  it("derives the standard USDC account deterministically", () => {
    expect(usdcAta(owner).equals(usdcAta(owner))).toBe(true);
    expect(PublicKey.isOnCurve(usdcAta(owner).toBytes())).toBe(false); // PDAs are off-curve
  });
});

describe("live trading via Jito", () => {
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

  it("sends one signed transaction with both legs and the tip, and measures real profit", async () => {
    const { jito, sent } = fakeJito();
    // SOL drops by fee + tip + a 0.00204 SOL deposit for the new token account.
    const conn = fakeConn({ usdcBefore: 20_000_000n, usdcAfter: 20_100_000n, lamportsBefore: 50_000_000, lamportsAfter: 50_000_000 - 16_000 - 2_039_280, lands: true });
    const r = await liveExecute(opportunity(cfg), wallet, { conn, jup: fakeJup(), cfg, solPriceUsd: SOL_PRICE, tipAccount: tip, jito });

    expect(r.status).toBe("filled");
    expect(r.signature).toBe("sig123");
    // Only fee (6000) + tip (10000) count; the refundable deposit does not.
    expect(r.netUsd).toBeCloseTo(0.1 - (16_000 / 1e9) * SOL_PRICE, 9);

    const msg = sent[0].message;
    const keys = msg.staticAccountKeys.map((k) => k.toBase58());
    const programs = msg.compiledInstructions.map((ix) => keys[ix.programIdIndex]);
    expect(programs.filter((p) => p === DEX.toBase58())).toHaveLength(2); // both legs, one transaction
    expect(programs.at(-1)).toBe(SystemProgram.programId.toBase58()); // tip is last
    expect(keys).toContain(tip.toBase58());
    expect(sent[0].signatures[0].some((b) => b !== 0)).toBe(true); // really signed
  });

  it("does not send at all when the free simulation says it would revert", async () => {
    const { jito, sent } = fakeJito();
    const conn = fakeConn({ simErr: "boom", usdcBefore: 1n, usdcAfter: 1n, lamportsBefore: 0, lamportsAfter: 0, lands: false });
    const r = await liveExecute(opportunity(cfg), wallet, { conn, jup: fakeJup(), cfg, solPriceUsd: SOL_PRICE, tipAccount: tip, jito });
    expect(r.status).toBe("rejected");
    expect(sent).toHaveLength(0);
  });

  it("costs nothing when Jito drops it", async () => {
    const { jito } = fakeJito();
    const conn = fakeConn({ usdcBefore: 1n, usdcAfter: 1n, lamportsBefore: 0, lamportsAfter: 0, lands: false });
    const r = await liveExecute(opportunity(cfg), wallet, { conn, jup: fakeJup(), cfg, solPriceUsd: SOL_PRICE, tipAccount: tip, jito });
    expect(r).toMatchObject({ status: "rejected", netUsd: 0, feeUsd: 0, reason: "did not land (no fee paid)" });
  });

  it("refuses to trade via Jito without a tip account", async () => {
    const { jito } = fakeJito();
    const conn = fakeConn({ usdcBefore: 1n, usdcAfter: 1n, lamportsBefore: 0, lamportsAfter: 0, lands: true });
    const r = await liveExecute(opportunity(cfg), wallet, { conn, jup: fakeJup(), cfg, solPriceUsd: SOL_PRICE, jito });
    expect(r).toMatchObject({ status: "skipped", reason: "Jito not available" });
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
