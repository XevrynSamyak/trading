import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { USDC_MINT } from "./config.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export function loadKeypair(base58Secret: string): Keypair {
  return Keypair.fromSecretKey(bs58.decode(base58Secret.trim()));
}

export interface Balances {
  lamports: number;
  usdcAtoms: bigint;
  /**
   * SOL held as refundable deposits ("rent") in the wallet's token accounts.
   * Each new token the bot trades opens one (~0.002 SOL). It is still the
   * owner's money, so it counts toward wallet value, not as a loss.
   */
  rentLamports: number;
}

export async function getBalances(conn: Connection, owner: PublicKey): Promise<Balances> {
  const [lamports, tokenAccounts] = await Promise.all([
    conn.getBalance(owner, "confirmed"),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, "confirmed"),
  ]);
  let usdcAtoms = 0n;
  let rentLamports = 0;
  for (const acc of tokenAccounts.value) {
    rentLamports += acc.account.lamports;
    const info = acc.account.data.parsed.info;
    if (info.mint === USDC_MINT) usdcAtoms += BigInt(info.tokenAmount.amount as string);
  }
  return { lamports, usdcAtoms, rentLamports };
}

export function walletValueUsd(b: Balances, solPriceUsd: number): number {
  return Number(b.usdcAtoms) / 1e6 + ((b.lamports + b.rentLamports) / 1e9) * solPriceUsd;
}

/** The wallet's standard USDC token account (associated token account). */
export function usdcAta(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), new PublicKey(USDC_MINT).toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/** Reads the amount (u64 at byte 64) out of raw SPL token account data. */
export function tokenAmountFromData(data: Buffer): bigint {
  if (data.length < 72) throw new Error(`not a token account (${data.length} bytes)`);
  return data.readBigUInt64LE(64);
}

/**
 * Reads balances at most once per `maxAgeMs` (default 1 minute) to save RPC
 * credits: the free Helius plan has a monthly limit, and in paper mode the
 * balance barely changes. Call invalidate() after anything that moves money.
 */
export class BalanceCache {
  private cached?: { balances: Balances; at: number };

  constructor(
    private readonly conn: Connection,
    private readonly owner: PublicKey,
    private readonly maxAgeMs = 60_000,
  ) {}

  async get(now = Date.now()): Promise<Balances> {
    if (!this.cached || now - this.cached.at >= this.maxAgeMs) {
      this.cached = { balances: await getBalances(this.conn, this.owner), at: now };
    }
    return this.cached.balances;
  }

  invalidate(): void {
    this.cached = undefined;
  }
}
