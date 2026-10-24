"""
One place for output. Every line is redacted first: API keys in URLs or
headers, Jupiter and Telegram tokens, status-page tokens, and anything shaped
like a Solana secret key.
"""

import json
import re
import sys
import time
from typing import Any

from .util import iso

PATTERNS: list[tuple[re.Pattern, str]] = [
    # ?api-key=... / &apiKey=... (Helius RPC URL, other providers)
    (re.compile(r"(api[-_]?key=)[^&\s\"'<>]+", re.I), r"\1***"),
    # ?token=... (status page links) and "Bearer ..." headers
    (re.compile(r"([?&]token=)[^&\s\"'<>]+", re.I), r"\1***"),
    (re.compile(r"(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}"), r"\1***"),
    # "x-api-key": "..." / x-api-key=...
    (re.compile(r"(\"?x-api-key\"?\s*[:=]\s*\"?)[^\"',\s}]+", re.I), r"\1***"),
    # Jupiter API keys
    (re.compile(r"\bjup_[0-9a-f]{16,}\b", re.I), "jup_***"),
    # Telegram bot tokens (they appear in the sendMessage URL)
    (re.compile(r"\bbot\d{6,}:[A-Za-z0-9_-]{20,}"), "bot***"),
    # base58 Solana secret keys (64 bytes ~ 87-88 chars); public keys are ~44 and stay readable
    (re.compile(r"\b[1-9A-HJ-NP-Za-km-z]{80,}\b"), "[REDACTED-SECRET-KEY]"),
    # secret keys as a JSON byte array (64 numbers)
    (re.compile(r"\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]"), "[REDACTED-KEY-BYTES]"),
]


def redact(text: str) -> str:
    for pattern, rep in PATTERNS:
        text = pattern.sub(rep, text)
    return text


def _stringify(arg: Any) -> str:
    if isinstance(arg, BaseException):
        cause = arg.__cause__ or arg.__context__
        text = f"{type(arg).__name__}: {arg}"
        return text + (f" (cause: {_stringify(cause)})" if cause else "")
    if isinstance(arg, str):
        return arg
    try:
        return json.dumps(arg, default=str)
    except (TypeError, ValueError):
        return str(arg)


def fmt(*args: Any) -> str:
    """Formats print-style arguments into one redacted line."""
    return redact(" ".join(_stringify(a) for a in args))


def make_repeat_filter(quiet_ms: int = 10 * 60_000, now=lambda: time.time() * 1000):
    """
    While the RPC's WebSocket is unreachable, reconnect errors repeat about
    once a second. Show the first one, then at most one every `quiet_ms`,
    with how many were hidden.
    """
    state = {"last": float("-inf"), "hidden": 0}

    def filt(line: str) -> str | None:
        if not line.startswith("ws error"):
            return line
        if now() - state["last"] < quiet_ms:
            state["hidden"] += 1
            return None
        state["last"] = now()
        note = f" ({state['hidden']} similar hidden)" if state["hidden"] else ""
        state["hidden"] = 0
        return f"{line}{note} [WebSocket unreachable; retrying quietly. Event triggers pause until it's back]"

    return filt


_filter = make_repeat_filter()


def _out(line: str | None, err: bool = False) -> None:
    if line is None:
        return
    stream = sys.stderr if err else sys.stdout
    print(line, file=stream, flush=True)


class _Log:
    def info(self, *args: Any) -> None:
        """Ordinary progress lines (scan results etc.)."""
        _out(_filter(fmt(*args)))

    def event(self, *args: Any) -> None:
        """Things worth noticing later; timestamped."""
        _out(f"[{iso()}] {fmt(*args)}")

    def warn(self, *args: Any) -> None:
        _out(f"[{iso()}] WARN {fmt(*args)}", err=True)

    def error(self, *args: Any) -> None:
        _out(f"[{iso()}] ERROR {fmt(*args)}", err=True)

    def ws_error(self, message: str) -> None:
        """A WebSocket reconnect failure: rate-limited by the repeat filter."""
        _out(_filter(fmt(f"ws error: {message}")), err=True)


log = _Log()


class RedactingStream:
    """Wraps stdout/stderr so anything printed (not only log lines) is redacted too."""

    def __init__(self, stream):
        self._stream = stream

    def write(self, text: str) -> int:
        return self._stream.write(redact(text))

    def __getattr__(self, name):
        return getattr(self._stream, name)


def install_output_redaction() -> None:
    if not isinstance(sys.stdout, RedactingStream):
        sys.stdout = RedactingStream(sys.stdout)
    if not isinstance(sys.stderr, RedactingStream):
        sys.stderr = RedactingStream(sys.stderr)
