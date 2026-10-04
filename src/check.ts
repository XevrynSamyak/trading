import { Connection } from "@solana/web3.js";
import { loadConfig } from "./config.js";
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

  if (cfg.walletSecretKey) {
    results.push(
      await step("Wallet", async () => {
        const kp = loadKeypair(cfg.walletSecretKey!);
        const b = await getBalances(conn, kp.publicKey);
        const sol = b.lamports / 1e9;
        const warn = sol < MIN_SOL_FOR_FEES ? ` (WARNING: add some SOL, it pays the network fees)` : "";
        return (
          `${kp.publicKey.toBase58()}  SOL ${sol.toFixed(4)}, USDC ${(Number(b.usdcAtoms) / 1e6).toFixed(2)}` +
          (solPrice ? `, total ~$${walletValueUsd(b, solPrice).toFixed(2)}` : "") +
          warn
        );
      }),
    );
  } else {
    console.log("SKIP  Wallet: no WALLET_SECRET_KEY set (fine for paper mode)");
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
