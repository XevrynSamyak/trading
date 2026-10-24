"""Small shared helpers: time in milliseconds (as the data files store it), UTC day/month starts."""

import math
import time
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal


def now_ms() -> int:
    return int(time.time() * 1000)


def iso(ts_ms: int | None = None) -> str:
    """2026-10-05T12:00:00.000Z, like JavaScript's toISOString()."""
    t = datetime.fromtimestamp((now_ms() if ts_ms is None else ts_ms) / 1000, tz=timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def start_of_utc_day(ts_ms: int) -> int:
    d = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp() * 1000)


def start_of_utc_month(ts_ms: int, offset_months: int = 0) -> int:
    d = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    m = d.year * 12 + (d.month - 1) + offset_months
    return int(datetime(m // 12, m % 12 + 1, 1, tzinfo=timezone.utc).timestamp() * 1000)


def utc_hour(ts_ms: int) -> int:
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).hour


def js_round(x: float) -> int:
    """JavaScript's Math.round (halves round up, not to even)."""
    return math.floor(x + 0.5)


def to_fixed(x: float, digits: int) -> str:
    """JavaScript's Number.prototype.toFixed, so displayed numbers match the old bot."""
    if x == 0:
        x = 0.0  # JS prints -0 as "0.00"
    return str(Decimal(x).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP))


def js_str(x: float) -> str:
    """How JavaScript prints a number in a template string: 25 not 25.0."""
    if isinstance(x, float) and x.is_integer():
        return str(int(x))
    return str(x)
