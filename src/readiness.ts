import type { TradeRecord } from "./ledger.js";

/**
 * Answers "should I go live?" from the paper-test results. Only trades
 * checked against the real chain count as evidence; quote-only results are
 * too optimistic to trust.
 */
export type ReadinessVerdict = "keep-testing" | "no-gaps" | "verify-first" | "all-fake" | "not-worth-it" | "try-live";

export interface Readiness {
  verdict: ReadinessVerdict;
  days: number;
  quoteOnlyWins: number;
  verifiedWins: number;
  fakeGaps: number;
  verifiedNetUsd: number;
  projectedMonthlyUsd: number;
  monthlyCostsUsd: number;
  message: string;
}

const MIN_DAYS = 2;
const DAY_MS = 86_400_000;

export function assessReadiness(
  records: TradeRecord[],
  startedAt: number,
  now: number,
  monthlyCosts: Record<string, number>,
): Readiness {
  const days = Math.max(0, (now - startedAt) / DAY_MS);
  const wins = records.filter((r) => r.status === "filled");
  const quoteOnlyWins = wins.filter((r) => !r.verified).length;
  const verifiedWins = wins.filter((r) => r.verified).length;
  const fakeGaps = records.filter((r) => r.status === "rejected").length;
  const verifiedNetUsd = records.filter((r) => r.verified).reduce((s, r) => s + r.netUsd, 0);
  const projectedMonthlyUsd = days > 0 ? (verifiedNetUsd / days) * 30 : 0;
  const monthlyCostsUsd = Object.values(monthlyCosts).reduce((a, b) => a + b, 0);
  const d = days.toFixed(1);
  const base = { days, quoteOnlyWins, verifiedWins, fakeGaps, verifiedNetUsd, projectedMonthlyUsd, monthlyCostsUsd };

  const say = (verdict: ReadinessVerdict, message: string): Readiness => ({ ...base, verdict, message });

  if (days < MIN_DAYS) {
    return say("keep-testing", `Only ${d} days of data. Let it run at least ${MIN_DAYS}–3 days before deciding.`);
  }
  if (verifiedWins === 0 && fakeGaps === 0 && quoteOnlyWins === 0) {
    return say("no-gaps", `In ${d} days no gap was big enough to pay its fees. Going live would not make money right now.`);
  }
  if (verifiedWins === 0 && fakeGaps === 0) {
    return say(
      "verify-first",
      `${quoteOnlyWins} trades looked profitable on quotes alone. Put your funded wallet's public address in ` +
        `WALLET_PUBLIC_KEY so the bot can check them on-chain before you trust them.`,
    );
  }
  if (verifiedWins === 0) {
    return say("all-fake", `All ${fakeGaps} gaps it found were gone when checked on-chain. Going live would not make money.`);
  }
  if (verifiedNetUsd > 0 && projectedMonthlyUsd > monthlyCostsUsd) {
    return say(
      "try-live",
      `Checked on-chain: +$${verifiedNetUsd.toFixed(4)} in ${d} days (~$${projectedMonthlyUsd.toFixed(2)}/month vs ` +
        `$${monthlyCostsUsd.toFixed(2)} bills). Worth a careful live test: start with MAX_TRADE_USD=1.`,
    );
  }
  return say(
    "not-worth-it",
    `Checked on-chain it would make ~$${projectedMonthlyUsd.toFixed(2)}/month, which does not beat ` +
      `$${monthlyCostsUsd.toFixed(2)} of bills. Not worth going live yet.`,
  );
}
