"""Loss-side guards only. Nothing here limits profit."""

from dataclasses import dataclass

from .util import js_str, now_ms, to_fixed


@dataclass
class RiskLimits:
    #: Drawdown floor: below this wallet value the bot halts for good (data/HALTED).
    loss_floor_usd: float
    daily_loss_limit_usd: float
    #: Landed-on-chain failures in a row before a cooldown.
    max_consecutive_failures: int
    #: Losing real or simulated trades in a row before a cooldown.
    max_consecutive_losses: int
    failure_cooldown_ms: float
    #: A single trade losing more than this is "unexpected" and trips the kill switch.
    unexpected_loss_usd: float


@dataclass
class RiskDecision:
    ok: bool
    reason: str = ""
    halt: bool = False


class RiskManager:
    def __init__(self, limits):
        """`limits` is a RiskLimits, or the Config (it has the same fields)."""
        self.limits = limits
        self._consecutive_failures = 0
        self._consecutive_losses = 0
        self._cooldown_until = 0.0
        self._cooldown_reason = ""

    def check(self, wallet_value_usd: float, today_pnl_usd: float, now: float | None = None) -> RiskDecision:
        now = now_ms() if now is None else now
        lim = self.limits
        if wallet_value_usd <= lim.loss_floor_usd:
            return RiskDecision(
                False,
                f"wallet value ${to_fixed(wallet_value_usd, 2)} hit loss floor ${to_fixed(lim.loss_floor_usd, 2)}",
                halt=True,
            )
        if today_pnl_usd <= -lim.daily_loss_limit_usd:
            return RiskDecision(False, f"daily loss limit reached (${to_fixed(today_pnl_usd, 2)})")
        if now < self._cooldown_until:
            return RiskDecision(False, f"cooling down: {self._cooldown_reason}")
        return RiskDecision(True)

    def record_result(self, status: str, now: float | None = None, net_usd: float = 0) -> None:
        """
        Feed every outcome. Only on-chain failures and money-losing trades
        count; stale/rejected/skipped attempts cost nothing.
        """
        now = now_ms() if now is None else now
        if status == "failed":
            self._consecutive_failures += 1
            if self._consecutive_failures >= self.limits.max_consecutive_failures:
                self._start_cooldown(now, f"{self._consecutive_failures} failed transactions in a row")
                self._consecutive_failures = 0
        elif status == "filled":
            self._consecutive_failures = 0
        if status in ("filled", "failed"):
            if net_usd < 0:
                self._consecutive_losses += 1
                if self._consecutive_losses >= self.limits.max_consecutive_losses:
                    self._start_cooldown(now, f"{self._consecutive_losses} losing trades in a row")
                    self._consecutive_losses = 0
            else:
                self._consecutive_losses = 0

    def _start_cooldown(self, now: float, reason: str) -> None:
        self._cooldown_until = now + self.limits.failure_cooldown_ms
        self._cooldown_reason = reason

    def unexpected(self, status: str, net_usd: float) -> str | None:
        """
        Outcomes that mean something is wrong, not just unlucky; the bot then
        disables trading until a person checks:
         - a real transaction whose landing could not be confirmed
         - a single trade losing more than UNEXPECTED_LOSS_USD (the on-chain
           floor should make large losses impossible)
        """
        if status == "timeout":
            return "a real transaction's landing could not be confirmed"
        if status in ("filled", "failed") and net_usd < -self.limits.unexpected_loss_usd:
            return (
                f"a single trade lost ${to_fixed(-net_usd, 4)}, more than UNEXPECTED_LOSS_USD "
                f"${js_str(self.limits.unexpected_loss_usd)}"
            )
        return None
