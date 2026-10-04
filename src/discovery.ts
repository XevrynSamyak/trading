import { USDC_MINT } from "./config.js";
import { jupiterHeaders, type FetchFn } from "./jupiter.js";

/**
 * Finds actively traded, verified tokens via Jupiter's token API so the brain
 * can look beyond the starting list. Busy tokens are where price gaps appear.
 */

export interface DiscoveryOptions {
  minLiquidityUsd: number;
  limit: number;
}

interface TokenInfo {
  id?: string;
  address?: string;
  mint?: string;
  symbol?: string;
  liquidity?: number;
  isVerified?: boolean;
  tags?: string[];
}

const STABLES = new Set([USDC_MINT, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" /* USDT */]);

export function parseTopTokens(body: unknown, opts: DiscoveryOptions): Record<string, string> {
  const list: TokenInfo[] = Array.isArray(body) ? body : [];
  const out: Record<string, string> = {};
  for (const t of list) {
    const mint = t.id ?? t.address ?? t.mint;
    const symbol = (t.symbol ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 12);
    const verified = t.isVerified === true || (t.tags ?? []).includes("verified");
    if (!mint || !symbol || !verified || STABLES.has(mint)) continue;
    if ((t.liquidity ?? 0) < opts.minLiquidityUsd) continue;
    const key = symbol in out ? `${symbol}-${mint.slice(0, 4)}` : symbol;
    out[key] = mint;
    if (Object.keys(out).length >= opts.limit) break;
  }
  return out;
}

export async function discoverTokens(
  tokensApi: string,
  opts: DiscoveryOptions,
  fetchFn: FetchFn = fetch,
  apiKey?: string,
): Promise<Record<string, string>> {
  const res = await fetchFn(`${tokensApi}/toptraded/1h?limit=50`, { headers: jupiterHeaders(apiKey) });
  if (!res.ok) throw new Error(`Jupiter tokens ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return parseTopTokens(await res.json(), opts);
}
