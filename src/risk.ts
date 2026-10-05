/** Loss-side guards only. Nothing here limits profit. */
export interface RiskLimits {
  /** Drawdown floor: below this wallet value the bot halts for good (data/HALTED). */
  lossFloorUsd: number;
  dailyLossLimitUsd: number;
  /** Landed-on-chain failures in a row before a cooldown. */
  maxConsecutiveFailures: number;
  /** Losing real or simulated trades in a row before a cooldown. */
  maxConsecutiveLosses: number;
  failureCooldownMs: number;
  /** A single trade losing more than this is "unexpected" and trips the kill switch. */
  unexpectedLossUsd: number;
}

export type RiskDecision = { ok: true } | { ok: false; reason: string; halt: boolean };

type Status = "filled" | "rejected" | "skipped" | "failed" | "stale" | "timeout";

export class RiskManager {
  private consecutiveFailures = 0;
  private consecutiveLosses = 0;
  private cooldownUntil = 0;
  private cooldownReason = "";

  constructor(private readonly limits: RiskLimits) {}

  check(walletValueUsd: number, todayPnlUsd: number, now = Date.now()): RiskDecision {
    if (walletValueUsd <= this.limits.lossFloorUsd) {
      return {
        ok: false,
        halt: true,
        reason: `wallet value $${walletValueUsd.toFixed(2)} hit loss floor $${this.limits.lossFloorUsd.toFixed(2)}`,
      };
    }
    if (todayPnlUsd <= -this.limits.dailyLossLimitUsd) {
      return { ok: false, halt: false, reason: `daily loss limit reached ($${todayPnlUsd.toFixed(2)})` };
    }
    if (now < this.cooldownUntil) {
      return { ok: false, halt: false, reason: `cooling down: ${this.cooldownReason}` };
    }
    return { ok: true };
  }

  /**
   * Feed every outcome. Only on-chain failures and money-losing trades count;
   * stale/rejected/skipped attempts cost nothing.
   */
  recordResult(status: Status, now = Date.now(), netUsd = 0): void {
    if (status === "failed") {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.limits.maxConsecutiveFailures) {
        this.startCooldown(now, `${this.consecutiveFailures} failed transactions in a row`);
        this.consecutiveFailures = 0;
      }
    } else if (status === "filled") {
      this.consecutiveFailures = 0;
    }
    if (status === "filled" || status === "failed") {
      if (netUsd < 0) {
        this.consecutiveLosses += 1;
        if (this.consecutiveLosses >= this.limits.maxConsecutiveLosses) {
          this.startCooldown(now, `${this.consecutiveLosses} losing trades in a row`);
          this.consecutiveLosses = 0;
        }
      } else {
        this.consecutiveLosses = 0;
      }
    }
  }

  private startCooldown(now: number, reason: string): void {
    this.cooldownUntil = now + this.limits.failureCooldownMs;
    this.cooldownReason = reason;
  }

  /**
   * Outcomes that mean something is wrong, not just unlucky; the bot then
   * disables trading until a person checks:
   *  - a real transaction whose landing could not be confirmed
   *  - a single trade losing more than UNEXPECTED_LOSS_USD (the on-chain
   *    floor should make large losses impossible)
   */
  unexpected(status: Status, netUsd: number): string | null {
    if (status === "timeout") return "a real transaction's landing could not be confirmed";
    if ((status === "filled" || status === "failed") && netUsd < -this.limits.unexpectedLossUsd) {
      return `a single trade lost $${(-netUsd).toFixed(4)}, more than UNEXPECTED_LOSS_USD $${this.limits.unexpectedLossUsd}`;
    }
    return null;
  }
}
