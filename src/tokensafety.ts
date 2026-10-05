import { PublicKey, type AccountInfo, type Connection, type ParsedAccountData } from "@solana/web3.js";
import { readJsonWithBackup, writeJsonAtomic } from "./atomic.js";
import type { Mode } from "./config.js";

/**
 * Token safety. Every token gets a state before the bot may touch it:
 *
 *   BLOCKED       never quoted: the token can behave differently from what
 *                 quotes assume (transfer fees or hooks, a permanent delegate,
 *                 frozen-by-default or paused accounts, not a token at all)
 *   WATCH         quoted to learn, never acted on (a discovered token with an
 *                 issuer who can freeze or mint, thin liquidity, few holders,
 *                 a brand-new pool, or a few wallets holding most of it)
 *   PAPER_ONLY    paper trading only (discovered tokens unless allowlisted in
 *                 LIVE_TOKENS; configured tokens until checked on-chain)
 *   LIVE_ALLOWED  may be traded with real money
 *
 * Trades are atomic round trips (the bot never holds a token between
 * transactions), so the main dangers are tokens whose transfers don't behave
 * like the quote says, and thin or fake markets. On-chain facts come from the
 * mint account (one batched RPC call, re-checked daily) and are cached in
 * data/token-safety.json; market facts come from Jupiter's token list.
 */
export type SafetyState = "BLOCKED" | "WATCH" | "PAPER_ONLY" | "LIVE_ALLOWED";

/** What the chain says about a mint. */
export interface MintFacts {
  program: "spl-token" | "spl-token-2022" | "other" | "missing" | "invalid";
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals?: number;
  /** Token-2022 extension names, as the RPC's parser reports them. */
  extensions: string[];
  transferFeeBps?: number;
  transferHookProgram?: string | null;
  permanentDelegate?: string | null;
  defaultFrozen?: boolean;
  paused?: boolean;
}

/** What Jupiter's token list says (only for discovered tokens; any field may be missing). */
export interface MarketFacts {
  liquidityUsd?: number;
  holders?: number;
  poolCreatedAt?: number;
  /** Share of supply held by the top holders, percent. */
  topHoldersPct?: number;
  verified?: boolean;
}

export interface SafetyThresholds {
  minLiquidityUsd: number;
  minHolders: number;
  minPoolAgeDays: number;
  maxTopHoldersPct: number;
}

export interface SafetyVerdict {
  state: SafetyState;
  reasons: string[];
}

/** Extensions that don't change how a plain transfer or swap behaves. */
const HARMLESS_EXTENSIONS = new Set([
  "metadataPointer",
  "tokenMetadata",
  "groupPointer",
  "tokenGroup",
  "groupMemberPointer",
  "tokenGroupMember",
  "mintCloseAuthority",
  "interestBearingConfig",
  "scaledUiAmountConfig",
  "confidentialTransferMint",
  "confidentialTransferFeeConfig",
  "confidentialMintBurn",
]);
/** Extensions judged by their state below. */
const JUDGED_EXTENSIONS = new Set(["transferFeeConfig", "transferHook", "permanentDelegate", "defaultAccountState", "pausableConfig"]);

const DAY_MS = 86_400_000;

/** Reads a mint account as returned by getMultipleParsedAccounts / getParsedAccountInfo. */
export function parseMintAccount(acc: AccountInfo<Buffer | ParsedAccountData> | null): MintFacts {
  const none = (program: MintFacts["program"]): MintFacts => ({ program, mintAuthority: null, freezeAuthority: null, extensions: [] });
  if (!acc) return none("missing");
  const data = acc.data as ParsedAccountData | Buffer;
  if (!data || Buffer.isBuffer(data) || typeof data !== "object" || !("parsed" in data)) return none("other");
  const program = data.program === "spl-token" ? "spl-token" : data.program === "spl-token-2022" ? "spl-token-2022" : "other";
  const parsed = data.parsed as { type?: string; info?: Record<string, unknown> };
  if (program === "other" || parsed?.type !== "mint") return none("other");
  const info = parsed.info ?? {};
  const exts = (Array.isArray(info.extensions) ? info.extensions : []) as { extension?: string; state?: Record<string, unknown> }[];
  const facts: MintFacts = {
    program,
    mintAuthority: typeof info.mintAuthority === "string" ? info.mintAuthority : null,
    freezeAuthority: typeof info.freezeAuthority === "string" ? info.freezeAuthority : null,
    decimals: typeof info.decimals === "number" ? info.decimals : undefined,
    extensions: exts.map((e) => String(e.extension ?? "unknown")),
  };
  for (const e of exts) {
    const st = (e.state ?? {}) as Record<string, any>;
    if (e.extension === "transferFeeConfig") {
      facts.transferFeeBps = Math.max(
        Number(st.newerTransferFee?.transferFeeBasisPoints ?? 0),
        Number(st.olderTransferFee?.transferFeeBasisPoints ?? 0),
      );
    } else if (e.extension === "transferHook") {
      facts.transferHookProgram = typeof st.programId === "string" ? st.programId : null;
    } else if (e.extension === "permanentDelegate") {
      facts.permanentDelegate = typeof st.delegate === "string" ? st.delegate : null;
    } else if (e.extension === "defaultAccountState") {
      facts.defaultFrozen = st.accountState === "frozen";
    } else if (e.extension === "pausableConfig") {
      facts.paused = st.paused === true;
    }
  }
  return facts;
}

/** Problems that make quotes untrustworthy for this token: never quoted. */
function hardBlocks(c: MintFacts): string[] {
  const out: string[] = [];
  if (c.program === "invalid") out.push("not a valid mint address");
  if (c.program === "missing") out.push("mint account not found");
  if (c.program === "other") out.push("not an SPL token mint");
  if ((c.transferFeeBps ?? 0) > 0) out.push(`charges a ${c.transferFeeBps}bps fee on every transfer`);
  if (c.transferHookProgram) out.push("runs a transfer hook program on every transfer");
  if (c.permanentDelegate) out.push("has a permanent delegate that can move anyone's tokens");
  if (c.defaultFrozen) out.push("new token accounts start frozen");
  if (c.paused) out.push("transfers are paused");
  if (c.extensions.includes("nonTransferable")) out.push("is non-transferable");
  if (c.extensions.includes("unparseableExtension")) out.push("has an extension the RPC could not read");
  return out;
}

/** Issuer powers and market weaknesses: discovered tokens with any of these are only watched. */
function softRisks(c: MintFacts, m: MarketFacts | undefined, now: number, t: SafetyThresholds): string[] {
  const out: string[] = [];
  if (c.freezeAuthority) out.push("issuer can freeze token accounts");
  if (c.mintAuthority) out.push("issuer can mint more");
  if (c.extensions.includes("pausableConfig") && !c.paused) out.push("issuer can pause transfers");
  const unknown = c.extensions.filter((e) => !HARMLESS_EXTENSIONS.has(e) && !JUDGED_EXTENSIONS.has(e) && e !== "nonTransferable" && e !== "unparseableExtension");
  if (unknown.length) out.push(`unfamiliar token extension(s): ${unknown.join(", ")}`);
  if (m?.liquidityUsd !== undefined && m.liquidityUsd < t.minLiquidityUsd) {
    out.push(`liquidity $${Math.round(m.liquidityUsd).toLocaleString("en-US")} < $${t.minLiquidityUsd.toLocaleString("en-US")}`);
  }
  if (m?.holders !== undefined && m.holders < t.minHolders) out.push(`only ${m.holders} holders (want ${t.minHolders}+)`);
  if (m?.poolCreatedAt !== undefined) {
    const days = (now - m.poolCreatedAt) / DAY_MS;
    if (days < t.minPoolAgeDays) out.push(`first pool only ${days.toFixed(1)} days old (want ${t.minPoolAgeDays}+)`);
  }
  if (m?.topHoldersPct !== undefined && m.topHoldersPct > t.maxTopHoldersPct) {
    out.push(`top holders own ${m.topHoldersPct.toFixed(0)}% (want ≤ ${t.maxTopHoldersPct}%)`);
  }
  return out;
}

/**
 * The state for one token. Configured tokens (the starting list or TOKENS) are
 * trusted unless the chain shows a hard problem; discovered ones must also look
 * healthy, and only an explicit LIVE_TOKENS entry lets them touch real money.
 */
export function classifyToken(a: {
  configured: boolean;
  allowlisted: boolean;
  chain?: MintFacts;
  market?: MarketFacts;
  now: number;
  t: SafetyThresholds;
}): SafetyVerdict {
  if (!a.chain) {
    return { state: a.configured || a.allowlisted ? "PAPER_ONLY" : "WATCH", reasons: ["not checked on-chain yet"] };
  }
  const hard = hardBlocks(a.chain);
  if (hard.length) return { state: "BLOCKED", reasons: hard };
  const soft = softRisks(a.chain, a.market, a.now, a.t);
  if (a.configured) return { state: "LIVE_ALLOWED", reasons: soft.map((r) => `note: ${r}`) };
  if (soft.length) return { state: "WATCH", reasons: soft };
  if (a.allowlisted) return { state: "LIVE_ALLOWED", reasons: ["discovered, allowlisted in LIVE_TOKENS"] };
  return { state: "PAPER_ONLY", reasons: ["discovered: real trades need it in LIVE_TOKENS"] };
}

/** May the bot quote this token in this mode? Real-money modes don't spend requests on tokens they can't trade. */
export const canScan = (s: SafetyState, mode: Mode) => (mode === "paper" ? s !== "BLOCKED" : s === "LIVE_ALLOWED");
/** May the bot act on a gap in this token in this mode? */
export const canAct = (s: SafetyState, mode: Mode) =>
  mode === "paper" ? s === "PAPER_ONLY" || s === "LIVE_ALLOWED" : s === "LIVE_ALLOWED";

interface Entry {
  symbol: string;
  /** When the on-chain check last ran (successfully or not). */
  checkedAt: number;
  chain?: MintFacts;
  market?: MarketFacts;
  error?: string;
}

export interface SafetyOptions {
  /** Symbols or mints allowed to trade real money although discovered. */
  liveTokens: string[];
  thresholds: SafetyThresholds;
  /** Re-check a token's mint this often (authorities and extensions can change). */
  recheckMs?: number;
  /** After a failed check, retry this soon. */
  retryMs?: number;
}

type MintReader = Pick<Connection, "getMultipleParsedAccounts">;

/** Cached safety facts for every token the bot knows, keyed by mint. */
export class TokenSafety {
  private entries: Record<string, Entry> = {};
  private readonly recheckMs: number;
  private readonly retryMs: number;

  constructor(
    private readonly path: string,
    private readonly opts: SafetyOptions,
  ) {
    this.recheckMs = opts.recheckMs ?? DAY_MS;
    this.retryMs = opts.retryMs ?? 10 * 60_000;
    this.entries = readJsonWithBackup<Record<string, Entry>>(path)?.value ?? {};
  }

  /** Mints whose on-chain facts are missing, stale, or due for a retry. */
  due(mints: string[], now = Date.now()): string[] {
    return [...new Set(mints)].filter((mint) => {
      const e = this.entries[mint];
      if (!e) return true;
      return now - e.checkedAt >= (e.chain && !e.error ? this.recheckMs : this.retryMs);
    });
  }

  /**
   * Checks every due mint of `tokens` (symbol -> mint) in one RPC call and saves
   * the cache. Returns how many were checked; throws if the RPC call failed
   * (the failed mints are retried after `retryMs`).
   */
  async refresh(conn: MintReader, tokens: Record<string, string>, now = Date.now()): Promise<number> {
    const symbolOf = new Map(Object.entries(tokens).map(([s, m]) => [m, s]));
    const due = this.due([...symbolOf.keys()], now);
    // A malformed address must not fail the whole batch: it is simply not a token.
    const valid = (m: string) => {
      try {
        new PublicKey(m);
        return true;
      } catch {
        return false;
      }
    };
    for (const mint of due.filter((m) => !valid(m))) {
      this.entries[mint] = {
        symbol: symbolOf.get(mint)!,
        checkedAt: now,
        chain: { program: "invalid", mintAuthority: null, freezeAuthority: null, extensions: [] },
        market: this.entries[mint]?.market,
      };
    }
    const mints = due.filter(valid);
    if (!mints.length) {
      if (due.length) this.save();
      return due.length;
    }
    try {
      for (let i = 0; i < mints.length; i += 100) {
        const batch = mints.slice(i, i + 100);
        const res = await conn.getMultipleParsedAccounts(batch.map((m) => new PublicKey(m)));
        batch.forEach((mint, j) => {
          const prev = this.entries[mint];
          this.entries[mint] = { symbol: symbolOf.get(mint)!, checkedAt: now, chain: parseMintAccount(res.value[j]), market: prev?.market };
        });
      }
    } catch (err) {
      for (const mint of mints) {
        const prev = this.entries[mint];
        if (prev?.chain && !prev.error && now - prev.checkedAt < this.recheckMs * 2) continue; // keep recent facts
        this.entries[mint] = { ...prev, symbol: symbolOf.get(mint)!, checkedAt: now, error: String(err).slice(0, 200) };
      }
      this.save();
      throw err;
    }
    this.save();
    return due.length;
  }

  /** Market facts from Jupiter's token list (kept with the on-chain facts). */
  noteMarket(mint: string, symbol: string, market: MarketFacts): void {
    const e = this.entries[mint];
    this.entries[mint] = e ? { ...e, market } : { symbol, checkedAt: 0, market };
  }

  verdict(symbol: string, mint: string, configured: boolean, now = Date.now()): SafetyVerdict {
    const e = this.entries[mint];
    const v = classifyToken({
      configured,
      allowlisted: this.opts.liveTokens.includes(symbol) || this.opts.liveTokens.includes(mint),
      chain: e?.error ? undefined : e?.chain,
      market: e?.market,
      now,
      t: this.opts.thresholds,
    });
    if (e?.error) v.reasons.push(`last on-chain check failed: ${e.error.slice(0, 80)}`);
    return v;
  }

  /** The weakest state among the tokens a cycle passes through. */
  cycleState(tokens: { symbol: string; mint: string; configured: boolean }[], now = Date.now()): SafetyState {
    const order: SafetyState[] = ["BLOCKED", "WATCH", "PAPER_ONLY", "LIVE_ALLOWED"];
    let worst = order.length - 1;
    for (const t of tokens) worst = Math.min(worst, order.indexOf(this.verdict(t.symbol, t.mint, t.configured, now).state));
    return order[worst];
  }

  save(): void {
    try {
      writeJsonAtomic(this.path, this.entries, { backup: true, pretty: true });
    } catch {
      // The cache only saves RPC calls; the bot still works without it.
    }
  }
}
