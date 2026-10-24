"""
"Does the bot pay its own bills?" The bills are charged by the providers to
a card the owner set up; this only checks whether trading profit covered them.
"""

from datetime import datetime, timezone

from .util import start_of_utc_month


def month_verdict(records: list[dict], month_start: int, monthly_costs: dict[str, float]) -> dict:
    end = start_of_utc_month(month_start, 1)
    pnl = sum(r["netUsd"] for r in records if month_start <= r["ts"] < end)
    costs = sum(monthly_costs.values())
    return {
        "month": datetime.fromtimestamp(month_start / 1000, tz=timezone.utc).strftime("%Y-%m"),
        "tradingPnlUsd": pnl,
        "costsUsd": costs,
        "surplusUsd": pnl - costs,
        "paidItsWay": pnl - costs >= 0,
    }


def should_retire(records: list[dict], now: int, monthly_costs: dict[str, float], months: int, first_trade_ts: int | None) -> bool:
    """True if each of the last `months` completed months failed to cover costs."""
    if months <= 0 or first_trade_ts is None:
        return False
    for i in range(1, months + 1):
        start = start_of_utc_month(now, -i)
        if start < start_of_utc_month(first_trade_ts):
            return False  # not running long enough to judge
        if month_verdict(records, start, monthly_costs)["paidItsWay"]:
            return False
    return True


def format_verdict(v: dict) -> str:
    sign = lambda n: f"+${n:.2f}" if n >= 0 else f"-${abs(n):.2f}"  # noqa: E731
    tail = f"paid its own way ({sign(v['surplusUsd'])} left over)" if v["paidItsWay"] else f"short by ${abs(v['surplusUsd']):.2f}"
    return f"{v['month']}: trading {sign(v['tradingPnlUsd'])}, bills ${v['costsUsd']:.2f} -> {tail}"
