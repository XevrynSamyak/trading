import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { makeRepeatFilter, redact } from "../src/log.js";
import { checkSecrets, looksLikeSeedPhrase } from "../src/secrets.js";

const kp = Keypair.generate();
const secret = bs58.encode(kp.secretKey);
const pub = kp.publicKey.toBase58();
const seed = "abandon ability able about above absent absorb abstract absurd abuse access accident";

describe("log redaction", () => {
  it("removes API keys, tokens and secret keys, keeps normal text and public addresses", () => {
    const line =
      `fetch https://mainnet.helius-rpc.com/?api-key=fa4e0000-test-0000-0000-notarealkey1 failed; ` +
      `headers {"x-api-key":"abc123"} key jup_00000000deadbeef00000000deadbeef ` +
      `tg https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage ` +
      `secret ${secret} bytes [${Array.from(kp.secretKey).join(",")}] wallet ${pub}`;
    const out = redact(line);
    expect(out).not.toContain("fa4e0000");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("deadbeef");
    expect(out).not.toContain("AAHdqTcvCH1v");
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED-SECRET-KEY]");
    expect(out).toContain("[REDACTED-KEY-BYTES]");
    expect(out).toContain(pub); // public addresses stay readable
    expect(redact("best SOL $20.00: quoted net -0.8bps")).toBe("best SOL $20.00: quoted net -0.8bps");
  });
});

describe("secret checks at startup", () => {
  it("detects seed phrases anywhere in the settings", () => {
    expect(looksLikeSeedPhrase(seed)).toBe(true);
    expect(looksLikeSeedPhrase("wallet needs at least one dollar")).toBe(false);
    expect(checkSecrets({ SOMETHING: seed }).errors[0]).toMatch(/SEED PHRASE/);
  });

  it("refuses a secret key in the public-address slot", () => {
    const r = checkSecrets({ WALLET_PUBLIC_KEY: secret });
    expect(r.errors[0]).toMatch(/WALLET_PUBLIC_KEY holds a SECRET key/);
    expect(r.errors.join(" ")).not.toContain(secret); // never echo the secret
  });

  it("refuses a public address in the signing-key slot, and keys from different wallets", () => {
    expect(checkSecrets({ PRIVATE_SIGNING_KEY: pub }).errors[0]).toMatch(/PUBLIC address/);
    const other = Keypair.generate().publicKey.toBase58();
    expect(checkSecrets({ PRIVATE_SIGNING_KEY: secret, WALLET_PUBLIC_KEY: other }, { mode: "micro" }).errors[0]).toMatch(
      /does not belong/,
    );
    expect(checkSecrets({ PRIVATE_SIGNING_KEY: secret, WALLET_PUBLIC_KEY: pub }, { mode: "micro" }).errors).toEqual([]);
  });

  it("warns when a signing key sits in .env during paper mode, and about a readable .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-"));
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "x=1");
    chmodSync(envFile, 0o644);
    const r = checkSecrets({ WALLET_SECRET_KEY: secret }, { mode: "paper", envFilePath: envFile });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join("\n")).toMatch(/paper mode never signs/);
    expect(r.warnings.join("\n")).toMatch(/chmod 600/);
  });
});

describe("modes and keys in config", () => {
  it("paper by default; micro and live need explicit confirmation and a signing key", () => {
    expect(loadConfig({}).mode).toBe("paper");
    expect(() => loadConfig({ MODE: "micro" })).toThrow(/LIVE_TRADING_CONFIRM/);
    expect(() => loadConfig({ MODE: "micro", LIVE_TRADING_CONFIRM: "yes" })).toThrow(/PRIVATE_SIGNING_KEY/);
    const micro = loadConfig({ MODE: "micro", LIVE_TRADING_CONFIRM: "yes", PRIVATE_SIGNING_KEY: secret });
    expect(micro.mode).toBe("micro");
    expect(micro.microMaxTradeUsd).toBe(5);
    expect(() => loadConfig({ MODE: "Live" })).not.toThrow(); // unknown spelling falls back to safe paper
    expect(loadConfig({ MODE: "Live" }).mode).toBe("paper");
  });

  it("accepts the older WALLET_SECRET_KEY name and a percentage loss floor", () => {
    expect(loadConfig({ WALLET_SECRET_KEY: secret }).signingKey).toBe(secret);
    expect(loadConfig({ STARTING_BALANCE_USD: "100", LOSS_FLOOR_PCT: "0.8" }).lossFloorUsd).toBe(80);
  });
});

describe("WebSocket error spam", () => {
  it("shows the first reconnect error, then at most one every quiet period", () => {
    let t = 0;
    const f = makeRepeatFilter(60_000, () => t);
    expect(f("ws error: connect ECONNREFUSED")).toMatch(/^ws error: connect ECONNREFUSED \[WebSocket unreachable/);
    t += 1_000;
    expect(f("ws error: connect ECONNREFUSED")).toBeNull();
    t += 1_000;
    expect(f("ws error: connect ECONNREFUSED")).toBeNull();
    expect(f("best SOL $20: quoted net -0.8bps")).toBe("best SOL $20: quoted net -0.8bps");
    t += 60_000;
    expect(f("ws error: connect ECONNREFUSED")).toMatch(/\(2 similar hidden\)/);
  });
});
