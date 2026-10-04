import "dotenv/config";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;
export const SOL_MINT = "So11111111111111111111111111111111111111112";

/** Liquid tokens worth scanning by default. Override with TOKENS=SYMBOL:mint,... */
export const DEFAULT_TOKENS: Record<string, string> = {
  SOL: SOL_MINT,
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  JTO: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
};

export type Mode = "paper" | "live";

/** Tokens quoted per scan; each needs 2 Jupiter requests (buy leg + sell leg). */
export const TOKENS_PER_SCAN = 3;
export const REQUESTS_PER_SCAN = TOKENS_PER_SCAN * 2;

/**
 * Jupiter's limits (per minute, across all its APIs): 30 without a key,
 * 60 with a free key. lite-api.jup.ag is keyless-only and being retired, so
 * with a key the bot uses api.jup.ag, which reads the key from `x-api-key`.
 */
export const JUPITER_KEYLESS_RPM = 30;
export const JUPITER_FREE_KEY_RPM = 60;

/** Room left each minute for requests outside scans (SOL price, token list). */
export const EXTRA_REQUESTS_PER_MIN = 2;

/**
 * Limits the bot holds itself to. Jupiter's limit is per minute, but a "too
 * many requests" seen at ~43 requests/min (6-request scans fired all at once,
 * every ~8.4s) suggests short bursts count too. So besides the per-minute
 * window (2 requests of slack), any 10-second window gets at most a sixth of
 * the per-minute limit minus 1, which spreads requests out evenly.
 */
export function jupiterRateWindows(requestsPerMinute: number): { ms: number; limit: number }[] {
  return [
    { ms: 60_000, limit: Math.max(1, requestsPerMinute - 2) },
    { ms: 10_000, limit: Math.max(2, Math.floor(requestsPerMinute / 6) - 1) },
  ];
}

/**
 * Even spacing per request that fits every window: 60/min -> ~1.11s per
 * request (a 6-request scan every ~6.7s, or a 2-request focus scan every
 * ~2.2s); 30/min -> 2.5s.
 */
export function jupiterMsPerRequest(requestsPerMinute: number): number {
  const usable = requestsPerMinute - EXTRA_REQUESTS_PER_MIN;
  if (usable <= 0) return 60_000;
  const per10s = jupiterRateWindows(requestsPerMinute)[1].limit;
  return Math.max(Math.ceil(60_000 / usable), Math.ceil(10_000 / per10s));
}

/** Full scans per minute the budget allows (every token in a scan costs 2 requests). */
export function maxScansPerMin(msPerRequest: number, requestsPerScan = REQUESTS_PER_SCAN): number {
  return 60_000 / (msPerRequest * requestsPerScan);
}

/** lite-api ignores API keys, so a key only helps on api.jup.ag. */
function jupiterUrl(configured: string | undefined, fallbackPath: string, apiKey: string | undefined): string {
  const host = apiKey ? "https://api.jup.ag" : "https://lite-api.jup.ag";
  const url = (configured || `${host}${fallbackPath}`).replace(/\/$/, "");
  return apiKey ? url.replace("://lite-api.jup.ag", "://api.jup.ag") : url;
}

export interface Config {
  mode: Mode;
  rpcUrl: string;
  jupiterApi: string;
  /** Free key from Jupiter's developer portal: doubles the request limit. */
  jupiterApiKey?: string;
  /** Jupiter requests allowed per minute (30 keyless, 60 free key, more on paid plans). */
  jupiterRpm: number;
  walletSecretKey?: string;
  /** Public address only: lets paper mode test trades on-chain without the secret key. */
  walletPublicKey?: string;
  /** How live trades are sent: "jito" (failed attempts cost nothing) or plain "rpc". */
  sendVia: "jito" | "rpc";
  jitoUrl: string;
  jitoTipLamports: number;
  tokens: Record<string, string>;
  /** Fraction of the wallet's USDC used per trade; trades grow as the wallet grows. */
  tradeSizePct: number;
  /** Optional ceiling per trade in USD; 0 = no ceiling. */
  maxTradeUsd: number;
  minProfitBps: number;
  priorityFeeLamports: number;
  computeUnitLimit: number;
  startingBalanceUsd: number;
  lossFloorUsd: number;
  dailyLossLimitUsd: number;
  maxConsecutiveFailures: number;
  failureCooldownMs: number;
  scanIntervalMs: number;
  /** Absolute fastest the bot may ever scan, whatever the budget allows. */
  minScanIntervalMs: number;
  /** Even spacing per Jupiter request that uses the whole budget. */
  jupiterMsPerRequest: number;
  monthlyCostsUsd: Record<string, number>;
  sustainStopAfterMonths: number;
  /** Let the brain find extra actively-traded tokens by itself. */
  tokenDiscovery: boolean;
  jupiterTokensApi: string;
  maxTokens: number;
  minTokenLiquidityUsd: number;
  telegramBotToken?: string;
  telegramChatId?: string;
  dataDir: string;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got "${raw}"`);
  return n;
}

/** Parses "name:value,name:value" into a record. */
export function parsePairs(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const [k, v] = part.split(":").map((s) => s.trim());
    if (k && v) out[k] = v;
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode: Mode = env.MODE === "live" ? "live" : "paper";
  if (mode === "live" && env.LIVE_TRADING_CONFIRM !== "yes") {
    throw new Error("MODE=live also requires LIVE_TRADING_CONFIRM=yes (real money will be traded)");
  }
  if (mode === "live" && !env.WALLET_SECRET_KEY) {
    throw new Error("MODE=live requires WALLET_SECRET_KEY (base58) of a fresh, dedicated wallet");
  }

  const startingBalanceUsd = num(env, "STARTING_BALANCE_USD", 25);
  const sendVia = env.SEND_VIA === "rpc" ? "rpc" : "jito";
  const jupiterApiKey = env.JUPITER_API_KEY?.trim() || undefined;
  const jupiterRpm = num(env, "JUPITER_RPM", jupiterApiKey ? JUPITER_FREE_KEY_RPM : JUPITER_KEYLESS_RPM);
  const tokens = env.TOKENS ? parsePairs(env.TOKENS) : DEFAULT_TOKENS;
  const costs = Object.fromEntries(
    Object.entries(parsePairs(env.MONTHLY_COSTS_USD ?? "server:0,rpc:0")).map(([k, v]) => [k, Number(v)]),
  );

  const cfg: Config = {
    mode,
    rpcUrl: env.RPC_URL || "https://api.mainnet-beta.solana.com",
    jupiterApi: jupiterUrl(env.JUPITER_API, "/swap/v1", jupiterApiKey),
    jupiterApiKey,
    jupiterRpm,
    walletSecretKey: env.WALLET_SECRET_KEY || undefined,
    walletPublicKey: env.WALLET_PUBLIC_KEY || undefined,
    sendVia,
    jitoUrl: (env.JITO_URL || "https://mainnet.block-engine.jito.wtf/api/v1").replace(/\/$/, ""),
    jitoTipLamports: num(env, "JITO_TIP_LAMPORTS", 10_000),
    tokens,
    tradeSizePct: num(env, "TRADE_SIZE_PCT", 0.8),
    maxTradeUsd: num(env, "MAX_TRADE_USD", 0),
    minProfitBps: num(env, "MIN_PROFIT_BPS", 20),
    // Through Jito the tip does the work, so the priority fee can be tiny.
    priorityFeeLamports: num(env, "PRIORITY_FEE_LAMPORTS", sendVia === "jito" ? 1_000 : 10_000),
    computeUnitLimit: num(env, "COMPUTE_UNIT_LIMIT", 600_000),
    startingBalanceUsd,
    lossFloorUsd: num(env, "LOSS_FLOOR_USD", +(startingBalanceUsd * 0.7).toFixed(2)),
    dailyLossLimitUsd: num(env, "DAILY_LOSS_LIMIT_USD", 2),
    maxConsecutiveFailures: num(env, "MAX_CONSECUTIVE_FAILURES", 5),
    failureCooldownMs: num(env, "FAILURE_COOLDOWN_MS", 10 * 60_000),
    scanIntervalMs: num(env, "SCAN_INTERVAL_MS", 5_000),
    minScanIntervalMs: num(env, "MIN_SCAN_INTERVAL_MS", 1_000),
    jupiterMsPerRequest: jupiterMsPerRequest(jupiterRpm),
    monthlyCostsUsd: costs,
    sustainStopAfterMonths: num(env, "SUSTAIN_STOP_AFTER_MONTHS", 2),
    tokenDiscovery: env.TOKEN_DISCOVERY !== "off",
    jupiterTokensApi: jupiterUrl(env.JUPITER_TOKENS_API, "/tokens/v2", jupiterApiKey),
    maxTokens: num(env, "MAX_TOKENS", 12),
    minTokenLiquidityUsd: num(env, "MIN_TOKEN_LIQUIDITY_USD", 1_000_000),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: env.TELEGRAM_CHAT_ID || undefined,
    dataDir: env.DATA_DIR || "./data",
  };

  if (!(cfg.tradeSizePct > 0 && cfg.tradeSizePct <= 1)) {
    throw new Error("TRADE_SIZE_PCT must be in (0, 1]");
  }
  if (cfg.lossFloorUsd >= cfg.startingBalanceUsd) {
    throw new Error("LOSS_FLOOR_USD must be below STARTING_BALANCE_USD");
  }
  return cfg;
}

/**
 * USD to put into the next trade: a share of the USDC on hand (compounding),
 * optionally capped. Both legs settle in one atomic transaction, so the
 * position is never left half-open.
 */
export function tradeSizeUsd(cfg: Pick<Config, "tradeSizePct" | "maxTradeUsd">, usdcBalanceUsd: number): number {
  const size = usdcBalanceUsd * cfg.tradeSizePct;
  const capped = cfg.maxTradeUsd > 0 ? Math.min(size, cfg.maxTradeUsd) : size;
  return Math.floor(capped * 100) / 100;
}

/** Everything a landed trade pays the network on top of the 5000-lamport base fee. */
export function extraFeeLamports(cfg: Pick<Config, "priorityFeeLamports" | "sendVia" | "jitoTipLamports">): number {
  return cfg.priorityFeeLamports + (cfg.sendVia === "jito" ? cfg.jitoTipLamports : 0);
}
