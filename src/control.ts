import { loadConfig } from "./config.js";
import { disableTrading, enableTrading, tradingDisabled } from "./killswitch.js";

/**
 * npm run stop-trading [reason]   emergency stop: the bot stops trading at once
 * npm run enable-trading          manual re-activation after checking why it stopped
 */
const cfg = loadConfig();
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "stop") {
  disableTrading(cfg.dataDir, rest.join(" ") || "stopped by hand (npm run stop-trading)");
  console.log("TRADING DISABLED. The bot stops trading within a few seconds. Re-enable with: npm run enable-trading");
} else if (cmd === "enable") {
  const was = tradingDisabled(cfg.dataDir);
  if (enableTrading(cfg.dataDir)) {
    console.log(`Trading re-enabled. It had been disabled because: ${was.reason}`);
  } else {
    console.log("Trading was not disabled; nothing to do.");
  }
} else {
  console.log("usage: npm run stop-trading [reason] | npm run enable-trading");
  process.exit(1);
}
