import { existsSync, statSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

/**
 * Startup checks for the most damaging setup mistakes. Messages never repeat
 * the secret itself.
 *  - a seed phrase anywhere in the settings
 *  - a SECRET key in the public-address slot (WALLET_PUBLIC_KEY)
 *  - a public address in the signing-key slot
 *  - a signing key that does not belong to WALLET_PUBLIC_KEY
 *  - a signing key present in paper mode (not needed there)
 *  - a .env file other users can read
 */
export interface SecretCheck {
  errors: string[];
  warnings: string[];
}

const SEED_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);

export function looksLikeSeedPhrase(value: string): boolean {
  const words = value.trim().split(/\s+/);
  return SEED_WORD_COUNTS.has(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w));
}

function decodedLength(value: string): number | null {
  try {
    return bs58.decode(value.trim()).length;
  } catch {
    return null;
  }
}

/** The signing key, preferring the new name; WALLET_SECRET_KEY is the older name. */
export function signingKeyFrom(env: NodeJS.ProcessEnv): string | undefined {
  return env.PRIVATE_SIGNING_KEY?.trim() || env.WALLET_SECRET_KEY?.trim() || undefined;
}

export function checkSecrets(
  env: NodeJS.ProcessEnv,
  opts: { mode: string; envFilePath?: string } = { mode: "paper" },
): SecretCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && looksLikeSeedPhrase(value)) {
      errors.push(
        `${key} looks like a SEED PHRASE. Delete it from .env now. The bot never needs a seed phrase; ` +
          `if it was ever shared or pasted anywhere, move your funds to a new wallet.`,
      );
    }
  }

  const pub = env.WALLET_PUBLIC_KEY?.trim();
  if (pub) {
    const len = decodedLength(pub);
    if (len === 64) {
      errors.push(
        "WALLET_PUBLIC_KEY holds a SECRET key. Remove it from .env now; put only the public address " +
          "(about 44 characters) there.",
      );
    } else if (len !== 32) {
      errors.push("WALLET_PUBLIC_KEY is not a valid Solana address (copy the public address from Phantom).");
    }
  }

  if (env.PRIVATE_SIGNING_KEY?.trim() && env.WALLET_SECRET_KEY?.trim() &&
      env.PRIVATE_SIGNING_KEY.trim() !== env.WALLET_SECRET_KEY.trim()) {
    errors.push("PRIVATE_SIGNING_KEY and WALLET_SECRET_KEY are both set and differ. Keep only PRIVATE_SIGNING_KEY.");
  }

  const signing = signingKeyFrom(env);
  if (signing) {
    const len = decodedLength(signing);
    if (len === 32) {
      errors.push(
        "The signing key setting holds a PUBLIC address, not a signing key. Public addresses belong in WALLET_PUBLIC_KEY.",
      );
    } else if (len !== 64) {
      errors.push("The signing key is not a valid base58 Solana secret key.");
    } else if (pub && decodedLength(pub) === 32) {
      const derived = Keypair.fromSecretKey(bs58.decode(signing)).publicKey.toBase58();
      if (derived !== pub) {
        errors.push("The signing key does not belong to WALLET_PUBLIC_KEY. They must be the same wallet.");
      }
    }
    if (opts.mode === "paper") {
      warnings.push(
        "A signing key is set but paper mode never signs anything. It is safer to remove it from .env until you go MICRO.",
      );
    }
  }

  if (opts.envFilePath && existsSync(opts.envFilePath)) {
    const mode = statSync(opts.envFilePath).mode;
    if (mode & 0o077) {
      warnings.push(`${opts.envFilePath} can be read by other users. Run: chmod 600 ${opts.envFilePath}`);
    }
  }

  return { errors, warnings };
}
