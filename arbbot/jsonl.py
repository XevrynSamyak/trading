"""Append-only JSON-lines files (one record per line), tolerant of a torn last line."""

import json
import os
from typing import Any


def append_jsonl(path: str, record: dict) -> None:
    # After a crash the last line can be half-written; start on a fresh line so
    # the new record isn't glued onto it (and lost).
    prefix = ""
    if os.path.exists(path) and os.path.getsize(path) > 0:
        with open(path, "rb") as f:
            f.seek(-1, os.SEEK_END)
            if f.read(1) != b"\n":
                prefix = "\n"
    with open(path, "a", encoding="utf-8") as f:
        f.write(prefix + json.dumps(record, separators=(",", ":")) + "\n")


def read_jsonl(path: str) -> list[Any]:
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except ValueError:
                pass  # a torn line after a crash: skip it rather than refuse to start
    return out


class JsonlReader:
    """Incremental reader for screens that refresh: parses only complete lines added since the last call."""

    def __init__(self, path: str):
        self.path = path
        self.offset = 0
        self.records: list[Any] = []

    def read(self) -> list[Any]:
        if not os.path.exists(self.path):
            self.offset, self.records = 0, []
            return self.records
        size = os.path.getsize(self.path)
        if size < self.offset:  # replaced (e.g. a reset): start over
            self.offset, self.records = 0, []
        if size == self.offset:
            return self.records
        with open(self.path, "rb") as f:
            f.seek(self.offset)
            buf = f.read(size - self.offset)
        end = buf.rfind(b"\n")
        if end < 0:
            return self.records  # a line still being written is read next time
        for line in buf[:end].decode("utf-8", errors="replace").split("\n"):
            if not line:
                continue
            try:
                self.records.append(json.loads(line))
            except ValueError:
                pass
        self.offset += end + 1
        return self.records
