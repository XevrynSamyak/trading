import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { USDC_MINT } from "./config.js";

export function loadKeypair(base58Secret: string): Keypair {
  return Keypair.fromSecretKey(bs58.decode(base58Secret.trim()));
}

export interface Balances {
  lamports: number;
  usdcAtoms: bigint;
}

export async function getBalances(conn: Connection, owner: PublicKey): Promise<Balances> {
  const [lamports, tokenAccounts] = await Promise.all([
    conn.getBalance(owner, "confirmed"),
    conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(USDC_MINT) }, "confirmed"),
  ]);
  let usdcAtoms = 0n;
  for (const acc of tokenAccounts.value) {
    usdcAtoms += BigInt(acc.account.data.parsed.info.tokenAmount.amount as string);
  }
  return { lamports, usdcAtoms };
}

export function walletValueUsd(b: Balances, solPriceUsd: number): number {
  return Number(b.usdcAtoms) / 1e6 + (b.lamports / 1e9) * solPriceUsd;
}
