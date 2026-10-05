import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, type AccountInfo, type ParsedAccountData } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  TokenSafety,
  canAct,
  canScan,
  classifyToken,
  parseMintAccount,
  type MintFacts,
  type SafetyThresholds,
} from "../src/tokensafety.js";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const DAY = 86_400_000;
const T: SafetyThresholds = { minLiquidityUsd: 1_000_000, minHolders: 1_000, minPoolAgeDays: 7, maxTopHoldersPct: 60 };

function mintAccount(program: string, info: Record<string, unknown>): AccountInfo<ParsedAccountData> {
  return {
    executable: false,
    lamports: 1_461_600,
    owner: Keypair.generate().publicKey,
    data: { program, parsed: { type: "mint", info: { decimals: 6, supply: "1000", isInitialized: true, ...info } }, space: 82 },
  };
}
const ext = (extension: string, state: Record<string, unknown> = {}) => ({ extension, state });
const clean: MintFacts = { program: "spl-token", mintAuthority: null, freezeAuthority: null, extensions: [] };

describe("reading a mint account", () => {
  it("reads authorities and Token-2022 extensions", () => {
    expect(parseMintAccount(null).program).toBe("missing");
    expect(parseMintAccount({ executable: false, lamports: 1, owner: Keypair.generate().publicKey, data: Buffer.alloc(82) }).program).toBe("other");
    expect(parseMintAccount(mintAccount("spl-token", { mintAuthority: "MintAuth", freezeAuthority: null }))).toEqual({
      program: "spl-token", mintAuthority: "MintAuth", freezeAuthority: null, decimals: 6, extensions: [],
    });
    const t22 = parseMintAccount(
      mintAccount("spl-token-2022", {
        mintAuthority: null,
        freezeAuthority: "Freezer",
        extensions: [
          ext("transferFeeConfig", { olderTransferFee: { transferFeeBasisPoints: 0 }, newerTransferFee: { transferFeeBasisPoints: 50 } }),
          ext("transferHook", { authority: "A", programId: "HookProgram" }),
          ext("permanentDelegate", { delegate: "Delegate" }),
          ext("defaultAccountState", { accountState: "frozen" }),
          ext("pausableConfig", { authority: "P", paused: false }),
          ext("metadataPointer", { metadataAddress: "M" }),
        ],
      }),
    );
    expect(t22).toMatchObject({
      program: "spl-token-2022", freezeAuthority: "Freezer", transferFeeBps: 50, transferHookProgram: "HookProgram",
      permanentDelegate: "Delegate", defaultFrozen: true, paused: false,
    });
    expect(t22.extensions).toEqual(["transferFeeConfig", "transferHook", "permanentDelegate", "defaultAccountState", "pausableConfig", "metadataPointer"]);
    // A hook or delegate slot that is set to nothing is harmless.
    const unset = parseMintAccount(mintAccount("spl-token-2022", { extensions: [ext("transferHook", { programId: null }), ext("permanentDelegate", { delegate: null })] }));
    expect(classifyToken({ configured: false, allowlisted: false, chain: unset, now: NOW, t: T }).state).toBe("PAPER_ONLY");
  });
});

describe("token safety states", () => {
  const verdict = (o: Partial<Parameters<typeof classifyToken>[0]>) =>
    classifyToken({ configured: false, allowlisted: false, chain: clean, now: NOW, t: T, ...o });

  it("blocks tokens whose transfers don't behave like the quotes assume, even configured ones", () => {
    const blocked: [Partial<MintFacts>, RegExp][] = [
      [{ program: "missing" }, /not found/],
      [{ program: "other" }, /not an SPL token/],
      [{ program: "spl-token-2022", transferFeeBps: 25, extensions: ["transferFeeConfig"] }, /25bps fee on every transfer/],
      [{ program: "spl-token-2022", transferHookProgram: "X", extensions: ["transferHook"] }, /transfer hook/],
      [{ program: "spl-token-2022", permanentDelegate: "X", extensions: ["permanentDelegate"] }, /permanent delegate/],
      [{ program: "spl-token-2022", defaultFrozen: true, extensions: ["defaultAccountState"] }, /start frozen/],
      [{ program: "spl-token-2022", paused: true, extensions: ["pausableConfig"] }, /paused/],
      [{ program: "spl-token-2022", extensions: ["nonTransferable"] }, /non-transferable/],
      [{ program: "spl-token-2022", extensions: ["unparseableExtension"] }, /could not read/],
    ];
    for (const [facts, why] of blocked) {
      for (const configured of [true, false]) {
        const v = verdict({ configured, chain: { ...clean, ...facts } });
        expect(v.state).toBe("BLOCKED");
        expect(v.reasons.join()).toMatch(why);
      }
    }
  });

  it("trusts configured tokens once checked, noting issuer powers", () => {
    expect(verdict({ configured: true })).toEqual({ state: "LIVE_ALLOWED", reasons: [] });
    expect(verdict({ configured: true, chain: { ...clean, freezeAuthority: "F" } })).toEqual({
      state: "LIVE_ALLOWED",
      reasons: ["note: issuer can freeze token accounts"],
    });
    expect(verdict({ configured: true, chain: undefined })).toEqual({ state: "PAPER_ONLY", reasons: ["not checked on-chain yet"] });
  });

  it("only watches discovered tokens with issuer powers or a weak market, and never lets them trade real money unless allowlisted", () => {
    expect(verdict({ chain: undefined }).state).toBe("WATCH");
    expect(verdict({})).toEqual({ state: "PAPER_ONLY", reasons: ["discovered: real trades need it in LIVE_TOKENS"] });
    expect(verdict({ allowlisted: true }).state).toBe("LIVE_ALLOWED");
    const watch: [Parameters<typeof classifyToken>[0]["market"] | undefined, Partial<MintFacts>, RegExp][] = [
      [undefined, { mintAuthority: "M" }, /can mint more/],
      [undefined, { freezeAuthority: "F" }, /can freeze/],
      [undefined, { program: "spl-token-2022", extensions: ["pausableConfig"], paused: false }, /can pause/],
      [undefined, { program: "spl-token-2022", extensions: ["someNewExtension"] }, /unfamiliar token extension\(s\): someNewExtension/],
      [{ liquidityUsd: 250_000 }, {}, /liquidity \$250,000 < \$1,000,000/],
      [{ holders: 300 }, {}, /only 300 holders/],
      [{ poolCreatedAt: NOW - 2 * DAY }, {}, /first pool only 2\.0 days old/],
      [{ topHoldersPct: 85 }, {}, /top holders own 85%/],
    ];
    for (const [market, facts, why] of watch) {
      // Allowlisting doesn't override a weak token.
      const v = verdict({ allowlisted: true, market, chain: { ...clean, ...facts } });
      expect(v.state).toBe("WATCH");
      expect(v.reasons.join()).toMatch(why);
    }
    // Healthy market facts pass.
    expect(verdict({ market: { liquidityUsd: 5e6, holders: 20_000, poolCreatedAt: NOW - 400 * DAY, topHoldersPct: 20 } }).state).toBe("PAPER_ONLY");
  });

  it("decides what each mode may quote and act on", () => {
    expect(canScan("BLOCKED", "paper")).toBe(false);
    expect(canScan("WATCH", "paper")).toBe(true);
    expect(canAct("WATCH", "paper")).toBe(false);
    expect(canAct("PAPER_ONLY", "paper")).toBe(true);
    for (const mode of ["micro", "live"] as const) {
      expect(canScan("PAPER_ONLY", mode)).toBe(false);
      expect(canAct("PAPER_ONLY", mode)).toBe(false);
      expect(canScan("LIVE_ALLOWED", mode)).toBe(true);
      expect(canAct("LIVE_ALLOWED", mode)).toBe(true);
    }
  });
});

describe("token safety cache", () => {
  const A = Keypair.generate().publicKey.toBase58();
  const B = Keypair.generate().publicKey.toBase58();

  function fakeConn(byMint: Record<string, AccountInfo<ParsedAccountData> | null>) {
    const calls: string[][] = [];
    let fail = false;
    return {
      calls,
      failNext: () => (fail = true),
      getMultipleParsedAccounts: async (keys: { toBase58(): string }[]) => {
        if (fail) {
          fail = false;
          throw new Error("429 Too Many Requests");
        }
        calls.push(keys.map((k) => k.toBase58()));
        return { context: { slot: 1 }, value: keys.map((k) => byMint[k.toBase58()] ?? null) };
      },
    };
  }

  it("checks new mints in one call, re-checks daily, survives restarts, and keeps market facts", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "safety-")), "token-safety.json");
    const conn = fakeConn({
      [A]: mintAccount("spl-token", { mintAuthority: null, freezeAuthority: null }),
      [B]: mintAccount("spl-token-2022", { extensions: [ext("transferFeeConfig", { newerTransferFee: { transferFeeBasisPoints: 100 } })] }),
    });
    const s = new TokenSafety(path, { liveTokens: [], thresholds: T });
    s.noteMarket(B, "FEE", { holders: 50_000 });
    expect(await s.refresh(conn as never, { GOOD: A, FEE: B }, NOW)).toBe(2);
    expect(conn.calls).toEqual([[A, B]]);
    expect(s.verdict("GOOD", A, true, NOW).state).toBe("LIVE_ALLOWED");
    expect(s.verdict("FEE", B, false, NOW).state).toBe("BLOCKED");
    expect(await s.refresh(conn as never, { GOOD: A, FEE: B }, NOW + 1000)).toBe(0); // cached

    // A restart reads the cache instead of asking the RPC again.
    const again = new TokenSafety(path, { liveTokens: [], thresholds: T });
    expect(again.due([A, B], NOW + 1000)).toEqual([]);
    expect(again.due([A, B], NOW + DAY)).toEqual([A, B]);
    expect(await again.refresh(conn as never, { GOOD: A, FEE: B }, NOW + DAY)).toBe(2);
    expect(again.cycleState([{ symbol: "GOOD", mint: A, configured: true }, { symbol: "FEE", mint: B, configured: false }], NOW + DAY)).toBe("BLOCKED");
  });

  it("blocks a malformed mint address without failing the others", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "safety-")), "token-safety.json");
    const conn = fakeConn({ [A]: mintAccount("spl-token", {}) });
    const s = new TokenSafety(path, { liveTokens: [], thresholds: T });
    expect(await s.refresh(conn as never, { GOOD: A, BAD: "not-a-mint!" }, NOW)).toBe(2);
    expect(conn.calls).toEqual([[A]]);
    expect(s.verdict("GOOD", A, true, NOW).state).toBe("LIVE_ALLOWED");
    expect(s.verdict("BAD", "not-a-mint!", false, NOW)).toEqual({ state: "BLOCKED", reasons: ["not a valid mint address"] });
  });

  it("on a failed check, keeps recent facts but never trusts unchecked tokens", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "safety-")), "token-safety.json");
    const conn = fakeConn({ [A]: mintAccount("spl-token", {}) });
    const s = new TokenSafety(path, { liveTokens: [], thresholds: T, retryMs: 600_000 });
    await s.refresh(conn as never, { GOOD: A }, NOW);
    conn.failNext();
    await expect(s.refresh(conn as never, { GOOD: A, NEW: B }, NOW + 1000)).rejects.toThrow(/429/);
    expect(s.verdict("GOOD", A, true, NOW + 1000).state).toBe("LIVE_ALLOWED");
    const unchecked = s.verdict("NEW", B, true, NOW + 1000);
    expect(unchecked.state).toBe("PAPER_ONLY");
    expect(unchecked.reasons.join()).toMatch(/last on-chain check failed: Error: 429/);
    // Retried after retryMs, not on every cycle.
    expect(s.due([A, B], NOW + 2000)).toEqual([]);
    expect(s.due([A, B], NOW + 1000 + 600_000)).toEqual([B]);
  });
});
