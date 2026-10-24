"""
Global emergency stop. While data/TRADING_DISABLED exists the bot does
nothing but wait. It is created by `npm run stop-trading`, by the status page,
or by the bot itself when something unexpected happens (a real trade whose
landing can't be confirmed, a loss far beyond what the floor allows). Only a
person can re-enable trading: `npm run enable-trading`.
"""

import os

from .util import iso

KILL_FILE = "TRADING_DISABLED"
HALT_FILE = "HALTED"


def kill_switch_path(data_dir: str) -> str:
    return os.path.join(data_dir, KILL_FILE)


def trading_disabled(data_dir: str) -> str | None:
    """The reason trading is disabled, or None."""
    p = kill_switch_path(data_dir)
    if not os.path.exists(p):
        return None
    try:
        with open(p, encoding="utf-8") as f:
            return f.read().strip() or "no reason recorded"
    except OSError:
        # Deleted between the two calls (re-enabled), or unreadable: only the latter stays disabled.
        return "kill switch file is unreadable" if os.path.exists(p) else None


def disable_trading(data_dir: str, reason: str, now_ms: int | None = None) -> None:
    os.makedirs(data_dir, exist_ok=True)
    with open(kill_switch_path(data_dir), "w", encoding="utf-8") as f:
        f.write(f"{iso(now_ms)} {reason}\n")


def enable_trading(data_dir: str) -> bool:
    """True if trading was disabled and is now re-enabled."""
    p = kill_switch_path(data_dir)
    if not os.path.exists(p):
        return False
    os.remove(p)
    return True


def halted(data_dir: str) -> str | None:
    p = os.path.join(data_dir, HALT_FILE)
    if not os.path.exists(p):
        return None
    try:
        with open(p, encoding="utf-8") as f:
            return f.read().strip() or "no reason recorded"
    except OSError:
        return "halt file is unreadable"
