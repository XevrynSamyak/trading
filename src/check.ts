import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { readJsonWithBackup } from "./atomic.js";
import { isRealMoney, loadConfig, maxScansPerMin, safetyThresholds, type Config } from "./config.js";
import { gateThresholds, goLiveVerdict, loadGateInput } from "./gate.js";
import { halted, tradingDisabled } from "./killswitch.js";
import { checkServerOptions } from "./server.js";
import { TokenSafety } from "./tokensafety.js";
import { timeoutFetch } from "./http.js";
import { installConsoleRedaction } from "./log.js";
import { checkSecrets } from "./secrets.js";
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

/** The loss-side limits in one line (there is no profit cap). */
export function limitsLine(cfg: Pick<Config, "mode" | "tradeSizePct" | "maxTradeUsd" | "microMaxTradeUsd" | "lossFloorUsd" | "dailyLossLimitUsd">): string {
  const caps = [`${Math.round(cfg.tradeSizePct * 100)}% of the USDC on hand`];
  if (cfg.maxTradeUsd > 0) caps.push(`$${cfg.maxTradeUsd} (MAX_TRADE_USD)`);
  if (cfg.mode === "micro") caps.push(`$${cfg.microMaxTradeUsd} (MICRO cap)`);
  return (
    `per trade at most ${caps.join(", ")}; stops for good at $${cfg.lossFloorUsd}, ` +
    `pauses for the day after -$${cfg.dailyLossLimitUsd}; no profit cap`
  );
}

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
  installConsoleRedaction();
  const cfg = loadConfig();
  console.log(`Mode: ${cfg.mode}${isRealMoney(cfg.mode) ? "  (REAL MONEY)" : "  (nothing is ever sent)"}`);
  console.log(`RPC:  ${maskUrl(cfg.rpcUrl)}\n`);

  const secrets = checkSecrets(process.env, { mode: cfg.mode, envFilePath: ".env" });
  for (const e of secrets.errors) console.log(`FAIL  Settings: ${e}`);
  for (const w of secrets.warnings) console.log(`WARN  Settings: ${w}`);
  if (!secrets.errors.length) console.log("OK    Settings: no secrets in the wrong place");

  const httpFetch = timeoutFetch();
  const conn = new Connection(cfg.rpcUrl, { commitment: "confirmed", fetch: httpFetch, wsEndpoint: cfg.rpcWsUrl });
  const jup = new JupiterClient(cfg.jupiterApi, httpFetch, cfg.jupiterApiKey);
  let solPrice = 0;

  const results = [
    await step("RPC", async () => {
      const [slot, version] = await Promise.all([conn.getSlot(), conn.getVersion()]);
      return `slot ${slot}, solana-core ${version["solana-core"]}`;
    }),
    await step("Jupiter", async () => {
      try {
        solPrice = await fetchSolPriceUsd(jup);
      } catch (err) {
        if (cfg.jupiterApiKey && /Jupiter quote (401|403)/.test(String(err))) {
          throw new Error("Jupiter rejected your API key: check JUPITER_API_KEY in .env (copy it again from the portal)");
        }
        throw err;
      }
      const keyNote = cfg.jupiterApiKey ? "with your API key" : "no API key";
      return (
        `SOL = $${solPrice.toFixed(2)} (${keyNote}: ${cfg.jupiterRpm} requests/min, ` +
        `up to ~${maxScansPerMin(cfg.jupiterMsPerRequest).toFixed(1)} full scans/min)`
      );
    }),
  ];

  const owner = cfg.walletPublicKey
    ? new PublicKey(cfg.walletPublicKey)
    : cfg.signingKey
      ? loadKeypair(cfg.signingKey).publicKey
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

  if (isRealMoney(cfg.mode) && cfg.sendVia === "jito") {
    results.push(
      await step("Jito", async () => `${(await new JitoClient(cfg.jitoUrl, httpFetch).getTipAccounts()).length} tip accounts`),
    );
  }

  console.log(`INFO  Limits: ${limitsLine(cfg)}`);

  results.push(
    await step("Data folder", async () => {
      mkdirSync(cfg.dataDir, { recursive: true });
      const probe = join(cfg.dataDir, ".write-test");
      writeFileSync(probe, "ok");
      rmSync(probe);
      return `${cfg.dataDir} is writable`;
    }),
  );

  const stop = halted(cfg.dataDir);
  if (stop) {
    console.log(`FAIL  Halted: ${stop} (read it, then delete ${join(cfg.dataDir, "HALTED")} to allow a start)`);
    results.push(false);
  }
  const kill = tradingDisabled(cfg.dataDir);
  if (kill.disabled) console.log(`WARN  Trading is disabled: ${kill.reason} (the bot will wait; re-enable after checking: npm run enable-trading)`);

  // The go-live gate, as the bot itself will apply it at startup.
  const verdict = goLiveVerdict(loadGateInput(cfg.dataDir), gateThresholds(cfg));
  if (cfg.mode === "live") {
    if (verdict.live.ok) console.log("OK    Go-live gate: LIVE allowed by the MICRO results");
    else {
      console.log(`FAIL  Go-live gate: LIVE will be refused: ${verdict.live.reasons.join("; ")}`);
      results.push(false);
    }
  } else {
    console.log(
      `INFO  Go-live gate: MICRO ${verdict.micro.ok ? "YES" : "NO"}, LIVE ${verdict.live.ok ? "YES" : "NO"}` +
        (verdict.micro.ok ? "" : ` (${verdict.micro.reasons[0]})`),
    );
  }

  // Token safety, checked on-chain now (the bot re-checks daily).
  const brainState = readJsonWithBackup<{ discovered?: Record<string, string> }>(join(cfg.dataDir, `brain-${cfg.mode}.json`))?.value;
  const pool = { ...(brainState?.discovered ?? {}), ...cfg.tokens };
  const safety = new TokenSafety(join(cfg.dataDir, "token-safety.json"), { liveTokens: cfg.liveTokens, thresholds: safetyThresholds(cfg), recheckMs: 0 });
  results.push(
    await step("Token safety", async () => {
      await safety.refresh(conn, pool);
      const lines = Object.entries(pool).map(([sym, mint]) => {
        const v = safety.verdict(sym, mint, sym in cfg.tokens);
        return `\n        ${sym.padEnd(10)} ${v.state.padEnd(13)} ${v.reasons.join("; ")}`.trimEnd();
      });
      return `${Object.keys(pool).length} tokens checked on-chain${lines.join("")}`;
    }),
  );

  if (cfg.eventTriggers) {
    results.push(
      await step("WebSocket", async () => {
        let n = 0;
        const id = conn.onSlotChange(() => (n += 1));
        await new Promise((r) => setTimeout(r, 3_000));
        await conn.removeSlotChangeListener(id);
        if (!n) throw new Error("no new-block notices in 3s: event triggers won't work (set RPC_WS_URL, or EVENT_TRIGGERS=off)");
        return `${n} new-block notices in 3s (event triggers can work)`;
      }),
    );
  }

  if (cfg.statusHttpPort !== undefined) {
    const problem = checkServerOptions({ host: cfg.statusHttpHost, port: cfg.statusHttpPort, token: cfg.statusHttpToken });
    if (problem) {
      console.log(`FAIL  Status page: ${problem}`);
      results.push(false);
    } else {
      console.log(`OK    Status page: http://${cfg.statusHttpHost}:${cfg.statusHttpPort}/${cfg.statusHttpToken ? " (needs ?token=)" : ""}`);
    }
  }

  const ok = results.every(Boolean) && secrets.errors.length === 0;
  console.log(ok ? "\nAll good. Start the bot." : "\nFix the FAIL lines above before starting the bot.");
  process.exit(ok ? 0 : 1);
}

if (process.argv[1]?.endsWith("check.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
