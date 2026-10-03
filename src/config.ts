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

export interface Config {
  mode: Mode;
  rpcUrl: string;
  jupiterApi: string;
  walletSecretKey?: string;
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
  monthlyCostsUsd: Record<string, number>;
  sustainStopAfterMonths: number;
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
  const tokens = env.TOKENS ? parsePairs(env.TOKENS) : DEFAULT_TOKENS;
  const costs = Object.fromEntries(
    Object.entries(parsePairs(env.MONTHLY_COSTS_USD ?? "server:0,rpc:0")).map(([k, v]) => [k, Number(v)]),
  );

  const cfg: Config = {
    mode,
    rpcUrl: env.RPC_URL || "https://api.mainnet-beta.solana.com",
    jupiterApi: (env.JUPITER_API || "https://lite-api.jup.ag/swap/v1").replace(/\/$/, ""),
    walletSecretKey: env.WALLET_SECRET_KEY || undefined,
    tokens,
    tradeSizePct: num(env, "TRADE_SIZE_PCT", 0.8),
    maxTradeUsd: num(env, "MAX_TRADE_USD", 0),
    minProfitBps: num(env, "MIN_PROFIT_BPS", 20),
    priorityFeeLamports: num(env, "PRIORITY_FEE_LAMPORTS", 10_000),
    computeUnitLimit: num(env, "COMPUTE_UNIT_LIMIT", 600_000),
    startingBalanceUsd,
    lossFloorUsd: num(env, "LOSS_FLOOR_USD", +(startingBalanceUsd * 0.7).toFixed(2)),
    dailyLossLimitUsd: num(env, "DAILY_LOSS_LIMIT_USD", 2),
    maxConsecutiveFailures: num(env, "MAX_CONSECUTIVE_FAILURES", 5),
    failureCooldownMs: num(env, "FAILURE_COOLDOWN_MS", 10 * 60_000),
    scanIntervalMs: num(env, "SCAN_INTERVAL_MS", 15_000),
    monthlyCostsUsd: costs,
    sustainStopAfterMonths: num(env, "SUSTAIN_STOP_AFTER_MONTHS", 2),
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
