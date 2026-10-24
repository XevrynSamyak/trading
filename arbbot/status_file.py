"""
Snapshot the bot writes after every cycle (data/status.json) so `status` can
show live progress. Plain camelCase JSON, same fields as the TypeScript bot:
pid, mode, startedAt, updatedAt, cycles, state ("scanning" | "paused" |
"waiting" | "disabled" | "stopped"), note, onChainTesting, sendVia, solPrice,
walletValueUsd, tradeSizeUsd, lastBest, hot, nextScanInMs, paceFloorMs, focus,
jupiterUsed, jupiterLimit, scansLastMin, funnelToday, quoteMs, events, lastOpp.
"""

import json
import os

from .atomic import write_json_atomic


def write_status(path: str, status: dict) -> None:
    # Write then rename, so a reader never sees a half-written file.
    write_json_atomic(path, {k: v for k, v in status.items() if v is not None})


def read_status(path: str) -> dict | None:
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            value = json.load(f)
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def is_alive(pid: int | None) -> bool:
    """Whether a process with this id is running (the bot's pid from status.json)."""
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
        return True
    except PermissionError:
        return True
    except (OSError, ValueError, OverflowError):
        return False
