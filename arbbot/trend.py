"""
Price-direction predictions, PAPER ONLY.

From the price watch (every token's price every few seconds) the bot builds
1-minute prices per token. Every minute, for every token with an hour of
history, it predicts: "will this token rise by more than its trading costs
within the next HORIZON minutes?" The costs are what this bot measured for
that token: a round trip USDC -> token -> USDC through Jupiter (DEX fees,
price impact, network fees), from its own scans.

The inputs are chart-style measurements, scaled by the token's own recent
volatility so one model fits every token:
  moves over the last 1, 5, 15 and 60 minutes; a fast-vs-slow average
  crossover (like MACD); how jumpy the price is; where the price sits in its
  last-hour range.

Every prediction is scored when its HORIZON minutes are up, before the model
learns from it, and compared with always saying "no". After WARMUP checked
predictions, a confident prediction opens a paper position: bought at the
watched price, sold when HORIZON minutes are up (or at a stop loss), with the
measured costs subtracted. Spot trading can only profit from rises, so it
never "sells short".

Nothing here is ever sent: there is no real-money path for this strategy.
Its results live in their own files (trend.json, trend-paper.jsonl) and never
count toward P&L, the go-live gate or the arbitrage funnel.
"""

import json
import math
import os
from collections import deque
from typing import Callable

from .atomic import read_json_with_backup, write_json_atomic
from .jsonl import append_jsonl, read_jsonl
from .predict import Logistic, Scorecard, clamp
from .tail import tail_lines
from .util import to_fixed

MINUTE_MS = 60_000
#: Minutes of history a prediction needs (60 one-minute moves).
HISTORY = 61
#: Minutes of prices kept per token.
KEEP = 240
N_FEATURES = 8
#: Checked predictions before paper positions open.
WARMUP = 200
#: Round-trip cost assumed for a token the bot hasn't scanned enough yet (bps).
DEFAULT_COST_BPS = 40.0
#: Missing minutes (bot paused) tolerated inside the last hour.
MAX_MISSING = 5
#: The minute-price file is trimmed to its recent part when it grows past this.
MAX_MINUTES_FILE = 20_000_000


def _ema(values: list[float], span: int) -> float:
    a = 2 / (span + 1)
    e = values[0]
    for v in values[1:]:
        e = a * v + (1 - a) * e
    return e


def features(closes: list[float]) -> list[float]:
    """Chart measurements from HISTORY one-minute closes (oldest first), scaled by volatility."""
    c = closes
    moves = [math.log(c[i] / c[i - 1]) for i in range(1, len(c))]
    mean = sum(moves) / len(moves)
    sigma = max(math.sqrt(sum((m - mean) ** 2 for m in moves) / len(moves)), 1e-5)
    last = c[-1]

    def z(k: int) -> float:
        return clamp(math.log(last / c[-1 - k]) / (sigma * math.sqrt(k)), -4, 4) / 2

    macd = clamp(math.log(_ema(c, 12) / _ema(c, 26)) / (sigma * math.sqrt(12)), -4, 4) / 2
    lo, hi = min(c), max(c)
    position = (last - lo) / (hi - lo) - 0.5 if hi > lo else 0.0
    return [1.0, z(1), z(5), z(15), z(60), macd, min(sigma * 10_000 / 20, 5) / 2, position]


class Trend:
    def __init__(self, data_dir: str, horizon_min: int = 15, enter_prob: float = 0.6, max_positions: int = 3,
                 stop_pct: float = 1.5, warmup: int = WARMUP, readonly: bool = False):
        """`readonly`: for screens that only read (never trims the minute-price file)."""
        self.state_path = os.path.join(data_dir, "trend.json")
        self.minutes_path = os.path.join(data_dir, "minutes.jsonl")
        self.trades_path = os.path.join(data_dir, "trend-paper.jsonl")
        self.horizon = horizon_min
        self.enter_prob = enter_prob
        self.max_positions = max_positions
        self.stop_pct = stop_pct
        self.warmup = warmup
        self.closes: dict[str, deque] = {}
        self.cur_minute: int | None = None
        self.cur_prices: dict[str, float] = {}
        self.pending: list[dict] = []
        self.latest: list[tuple[str, float]] = []
        self.model = Logistic(N_FEATURES, lr=0.05, l2=0.01)
        self.score = Scorecard()
        self.positions: list[dict] = []
        self._load(readonly)
        trades = read_jsonl(self.trades_path)
        self.trades = len(trades)
        self.wins = sum(1 for t in trades if t.get("netUsd", 0) > 0)
        self.net_usd = sum(t.get("netUsd", 0) for t in trades)
        self.net_bps = [t.get("netBps", 0) for t in trades]

    # -- persistence ---------------------------------------------------------------------

    def _load(self, readonly: bool) -> None:
        read = read_json_with_backup(self.state_path)
        s = read[0] if read and isinstance(read[0], dict) else {}
        if s.get("horizonMin") == self.horizon:  # a different horizon means a different question: start over
            self.model = Logistic(N_FEATURES, lr=0.05, l2=0.01, weights=s.get("model"))
            self.score = Scorecard.from_dict(s.get("score"))
        self.positions = [p for p in s.get("positions", []) if isinstance(p, dict) and p.get("entry")]
        if not readonly and os.path.exists(self.minutes_path) and os.path.getsize(self.minutes_path) > MAX_MINUTES_FILE:
            keep = tail_lines(self.minutes_path, KEEP, max_bytes=4_000_000)
            with open(self.minutes_path, "w", encoding="utf-8") as f:
                f.write("".join(line + "\n" for line in keep))
        for line in tail_lines(self.minutes_path, KEEP, max_bytes=4_000_000):
            try:
                rec = json.loads(line)
                minute = int(rec["t"]) // MINUTE_MS
                for sym, price in rec["p"].items():
                    self._add(sym, minute, float(price))
            except (ValueError, KeyError, TypeError, AttributeError):
                continue

    def _save(self) -> None:
        try:
            write_json_atomic(self.state_path, {
                "horizonMin": self.horizon,
                "model": self.model.w,
                "score": self.score.to_dict(),
                "positions": self.positions,
            }, backup=True)
        except OSError:
            pass

    # -- prices ---------------------------------------------------------------------------

    def _add(self, sym: str, minute: int, price: float) -> None:
        if price <= 0 or not math.isfinite(price):
            return
        d = self.closes.setdefault(sym, deque(maxlen=KEEP))
        if d and d[-1][0] == minute:
            d[-1] = (minute, price)
        elif not d or d[-1][0] < minute:
            d.append((minute, price))

    def _price_at(self, sym: str, minute: int, within: int = 2) -> float | None:
        for m, p in self.closes.get(sym, ()):
            if minute <= m <= minute + within:
                return p
        return None

    def _series(self, sym: str, minute: int) -> list[float] | None:
        """The last HISTORY one-minute closes up to `minute`, small gaps filled; None if not enough."""
        by_minute = {m: p for m, p in self.closes.get(sym, ())}
        if minute not in by_minute:
            return None
        out: list[float] = []
        missing = 0
        for m in range(minute - HISTORY + 1, minute + 1):
            p = by_minute.get(m)
            if p is None:
                if not out:
                    return None
                missing += 1
                if missing > MAX_MISSING:
                    return None
                p = out[-1]
            out.append(p)
        return out

    # -- the minute cycle ---------------------------------------------------------------------

    def on_prices(self, prices: dict[str, float], now: int, cost_bps: Callable[[str], float],
                  size_usd: float, tradable: set[str] | None = None) -> list[str]:
        """Feed one price-watch result. Returns lines worth logging (paper trades)."""
        minute = now // MINUTE_MS
        events: list[str] = []
        if self.cur_minute is None:
            self.cur_minute = minute
        if minute > self.cur_minute:
            events += self._close_minute(self.cur_minute, cost_bps, size_usd, tradable)
            self.cur_minute = minute
            self.cur_prices = {}
        self.cur_prices.update({s: p for s, p in prices.items() if p > 0})
        events += self._check_stops(prices, now)
        return events

    def _close_minute(self, minute: int, cost_bps, size_usd: float, tradable) -> list[str]:
        if not self.cur_prices:
            return []
        try:
            append_jsonl(self.minutes_path, {"t": minute * MINUTE_MS, "p": {s: float(f"{p:.8g}") for s, p in self.cur_prices.items()}})
        except OSError:
            pass
        for sym, price in self.cur_prices.items():
            self._add(sym, minute, price)
        events = self._resolve(minute)
        events += self._time_exits(minute)
        events += self._predict(minute, cost_bps, size_usd, tradable)
        self._save()
        return events

    def _resolve(self, minute: int) -> list[str]:
        """Scores predictions whose time is up, then learns from them."""
        still: list[dict] = []
        for pr in self.pending:
            if pr["due"] > minute:
                still.append(pr)
                continue
            later = self._price_at(pr["sym"], pr["due"])
            if later is None:
                if minute <= pr["due"] + 2:
                    still.append(pr)
                continue  # no price for that minute (bot paused): drop it
            y = int(math.log(later / pr["price"]) * 10_000 > pr["cost"])
            self.score.record(pr["p"], y)
            self.model.update(pr["x"], y)
        self.pending = still
        return []

    def _predict(self, minute: int, cost_bps, size_usd: float, tradable) -> list[str]:
        preds: list[tuple[float, str, float]] = []
        for sym in list(self.closes):
            series = self._series(sym, minute)
            if not series:
                continue
            x = features(series)
            p = self.model.predict(x)
            cost = float(cost_bps(sym))
            self.pending.append({"due": minute + self.horizon, "sym": sym, "x": x, "p": p, "price": series[-1], "cost": cost})
            preds.append((p, sym, series[-1]))
        preds.sort(reverse=True)
        self.latest = [(sym, p) for p, sym, _ in preds[:3]]
        events: list[str] = []
        if self.score.n < self.warmup or size_usd < 1:
            return events
        for p, sym, price in preds:
            if p < self.enter_prob or len(self.positions) >= self.max_positions:
                break
            if (tradable is not None and sym not in tradable) or any(pos["symbol"] == sym for pos in self.positions):
                continue
            cost = float(cost_bps(sym))
            self.positions.append({"symbol": sym, "openedAt": minute * MINUTE_MS, "minute": minute, "entry": price,
                                   "sizeUsd": size_usd, "pUp": p, "costBps": cost})
            events.append(
                f"trend (paper): bought {sym} ${to_fixed(size_usd, 2)} at ${float(f'{price:.6g}')}; "
                f"{to_fixed(p * 100, 0)}% chance it rises more than its {to_fixed(cost, 0)}bps costs in {self.horizon} min"
            )
        return events

    def _time_exits(self, minute: int) -> list[str]:
        events: list[str] = []
        for pos in list(self.positions):
            if minute >= pos["minute"] + self.horizon:
                price = self._price_at(pos["symbol"], pos["minute"] + self.horizon, within=minute - pos["minute"] - self.horizon)
                if price is None:
                    price = self.cur_prices.get(pos["symbol"])
                if price is not None:
                    events.append(self._close(pos, price, minute * MINUTE_MS, "time"))
        return events

    def _check_stops(self, prices: dict[str, float], now: int) -> list[str]:
        events: list[str] = []
        for pos in list(self.positions):
            price = prices.get(pos["symbol"])
            if price is not None and price <= pos["entry"] * (1 - self.stop_pct / 100):
                events.append(self._close(pos, price, now, "stop loss"))
        if events:
            self._save()
        return events

    def _close(self, pos: dict, price: float, ts: int, why: str) -> str:
        self.positions.remove(pos)
        gross = (price / pos["entry"] - 1) * 10_000
        net = gross - pos["costBps"]
        usd = pos["sizeUsd"] * net / 10_000
        rec = {"ts": ts, "symbol": pos["symbol"], "side": "long", "openedAt": pos["openedAt"], "entry": pos["entry"],
               "exit": price, "sizeUsd": pos["sizeUsd"], "pUp": pos["pUp"], "grossBps": gross, "costBps": pos["costBps"],
               "netBps": net, "netUsd": usd, "exitReason": why, "paper": True}
        try:
            append_jsonl(self.trades_path, rec)
        except OSError:
            pass
        self.trades += 1
        self.wins += int(usd > 0)
        self.net_usd += usd
        self.net_bps.append(net)
        sign = "+" if usd >= 0 else "-"
        return (
            f"trend (paper): sold {pos['symbol']} ({why}): {to_fixed(gross, 1)}bps before costs, "
            f"{to_fixed(net, 1)}bps after ({sign}${to_fixed(abs(usd), 4)}, paper only)"
        )

    # -- reporting ---------------------------------------------------------------------------

    def evidence(self) -> str:
        """Do the paper trades beat their costs by more than luck would explain?"""
        n = len(self.net_bps)
        if n < 30:
            return f"not enough paper trades to judge ({n}; needs 30+)"
        mean = sum(self.net_bps) / n
        sd = math.sqrt(sum((x - mean) ** 2 for x in self.net_bps) / (n - 1)) or 1e-9
        t = mean / (sd / math.sqrt(n))
        if mean > 0 and t > 2:
            return f"paper trades beat their costs ({to_fixed(mean, 1)}bps a trade, t={to_fixed(t, 1)}); still paper only"
        return f"no evidence the predictions beat costs ({to_fixed(mean, 1)}bps a trade after costs, t={to_fixed(t, 1)})"

    def thoughts(self) -> list[str]:
        out: list[str] = []
        n = self.score.n
        if n == 0:
            ready = sum(1 for sym in self.closes if self.closes[sym] and len(self.closes[sym]) >= HISTORY)
            out.append(
                f"I'm collecting 1-minute prices for {len(self.closes)} token(s) to predict price direction "
                f"(paper only); predictions start once a token has an hour of prices ({ready} ready)."
            )
            return out
        acc, base = self.score.accuracy() * 100, self.score.accuracy_base() * 100
        better = self.score.skill() > 0 and acc > base
        out.append(
            f"I've checked {n} price predictions (will a token rise more than its trading costs in {self.horizon} min?): "
            f"right {to_fixed(acc, 0)}% of the time vs {to_fixed(base, 0)}% for always saying no, so "
            + ("slightly better than chance so far." if better else "no better than chance so far.")
        )
        if n < self.warmup:
            out.append(f"Paper trades on these predictions start after {self.warmup} checked predictions ({n} so far).")
        elif self.trades:
            sign = "+" if self.net_usd >= 0 else "-"
            out.append(
                f"Paper trades on them: {self.trades} ({self.wins} won), {sign}${to_fixed(abs(self.net_usd), 4)} after costs; "
                f"{self.evidence()}."
            )
        return out

    def status(self) -> dict:
        return {
            "tokens": sum(1 for d in self.closes.values() if len(d) >= HISTORY),
            "watching": len(self.closes),
            "predictions": self.score.n,
            "accuracyPct": self.score.accuracy() * 100,
            "baseAccuracyPct": self.score.accuracy_base() * 100,
            "skillPct": self.score.skill() * 100,
            "open": len(self.positions),
            "trades": self.trades,
            "netUsd": self.net_usd,
            "horizonMin": self.horizon,
            "top": [[s, p] for s, p in self.latest],
        }

