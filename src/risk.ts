/** Loss-side guards only. Nothing here limits profit. */
export interface RiskLimits {
  lossFloorUsd: number;
  dailyLossLimitUsd: number;
  maxConsecutiveFailures: number;
  failureCooldownMs: number;
}

export type RiskDecision = { ok: true } | { ok: false; reason: string; halt: boolean };

export class RiskManager {
  private consecutiveFailures = 0;
  private cooldownUntil = 0;

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
      return { ok: false, halt: false, reason: "cooling down after repeated failures" };
    }
    return { ok: true };
  }

  recordResult(status: "filled" | "skipped" | "failed", now = Date.now()): void {
    if (status === "failed") {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.limits.maxConsecutiveFailures) {
        this.cooldownUntil = now + this.limits.failureCooldownMs;
        this.consecutiveFailures = 0;
      }
    } else if (status === "filled") {
      this.consecutiveFailures = 0;
    }
  }
}
