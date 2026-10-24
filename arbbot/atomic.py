"""
Crash-safe JSON files: write a temp file, keep the previous version as
`.bak`, then rename. A crash at any point leaves either the new file, the
old file, or the backup readable, never a half-written file in their place.
"""

import json
import os
from typing import Any


def write_json_atomic(path: str, value: Any, backup: bool = False, pretty: bool = False) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2 if pretty else None, separators=None if pretty else (",", ":"))
    if backup and os.path.exists(path):
        os.replace(path, f"{path}.bak")
    os.replace(tmp, path)


def read_json_with_backup(path: str) -> tuple[Any, bool] | None:
    """(value, from_backup), falling back to `.bak` if the main file is missing or corrupt."""
    for p, from_backup in ((path, False), (f"{path}.bak", True)):
        if not os.path.exists(p):
            continue
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f), from_backup
        except (OSError, ValueError):
            continue
    return None
