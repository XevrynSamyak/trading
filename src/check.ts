import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "./config.js";
import { JitoClient } from "./jito.js";
import { JupiterClient } from "./jupiter.js";
import { fetchSolPriceUsd } from "./scanner.js";
import { getBalances, loadKeypair, walletValueUsd } from "./wallet.js";

/** `npm run check`: confirms RPC, Jupiter and wallet work before starting the bot. */

export function maskUrl(url: string): string {
  return url.replace(/(api[-_]?key=)([^&]+)/i, (_, k: string, v: string) =>
    v.length > 8 ? `${k}${v.slice(0, 4)}…${v.slice(-4)}` : `${k}****`,
  );
}

const MIN_SOL_FOR_FEES = 0.01;

async function step(name: string, fn: () => Promise<string>): Promise<boolean> {
  try {
    console.log(`OK    ${name}: ${await fn()}`);
    return true;
  } catch (err) {
    console.log(`FAIL  ${name}: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
    return false;
  }
}

async function main() {
  const cfg = loadConfig();
  console.log(`Mode: ${cfg.mode}`);
  console.log(`RPC:  ${maskUrl(cfg.rpcUrl)}\n`);

  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const jup = new JupiterClient(cfg.jupiterApi);
  let solPrice = 0;

  const results = [
    await step("RPC", async () => {
      const [slot, version] = await Promise.all([conn.getSlot(), conn.getVersion()]);
      return `slot ${slot}, solana-core ${version["solana-core"]}`;
    }),
    await step("Jupiter", async () => {
      solPrice = await fetchSolPriceUsd(jup);
      return `SOL = $${solPrice.toFixed(2)}`;
    }),
  ];

  const owner = cfg.walletSecretKey
    ? loadKeypair(cfg.walletSecretKey).publicKey
    : cfg.walletPublicKey
      ? new PublicKey(cfg.walletPublicKey)
      : undefined;
  if (owner) {
    results.push(
      await step("Wallet", async () => {
        const b = await getBalances(conn, owner);
        const sol = b.lamports / 1e9;
        const usdc = Number(b.usdcAtoms) / 1e6;
        const warn =
          sol < MIN_SOL_FOR_FEES
            ? " (WARNING: add some SOL, it pays the network fees)"
            : usdc < 1
              ? " (WARNING: add USDC, the bot trades with it)"
              : cfg.mode === "paper"
                ? " -> paper trades will be tested on-chain"
                : "";
        return (
          `${owner.toBase58()}  SOL ${sol.toFixed(4)}, USDC ${usdc.toFixed(2)}` +
          (solPrice ? `, total ~$${walletValueUsd(b, solPrice).toFixed(2)}` : "") +
          warn
        );
      }),
    );
  } else {
    console.log("SKIP  Wallet: none set (add WALLET_PUBLIC_KEY for realistic on-chain paper testing)");
  }

  if (cfg.mode === "live" && cfg.sendVia === "jito") {
    results.push(
      await step("Jito", async () => `${(await new JitoClient(cfg.jitoUrl).getTipAccounts()).length} tip accounts`),
    );
  }

  const ok = results.every(Boolean);
  console.log(ok ? "\nAll good. Start the bot." : "\nFix the FAIL lines above before starting the bot.");
  process.exit(ok ? 0 : 1);
}

if (process.argv[1]?.endsWith("check.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
