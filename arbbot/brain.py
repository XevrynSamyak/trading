"""
The bot's learning "brain". No AI API calls (too slow for arbitrage and it
would cost money); it learns from its own scans and trades:
 - which tokens tend to show price gaps -> scans those more often
 - which trade size works best per token -> smaller trades move the price less
 - which hours of the day are best -> scans faster then, slower otherwise
 - how close it is to a gap -> speeds up when one is nearly there
 - how its trades turn out -> tunes how much profit it demands per trade
 - which newly discovered tokens are worth keeping -> forgets the useless ones
 - which tokens show fake gaps (quotes that don't hold on-chain) -> trusts them less
 - how much each token's quotes overstate reality -> discounts its quotes by that
 - sudden price moves (when gaps tend to appear) -> watches that token closely
 - how fast the free price API lets it scan -> runs as fast as is safe
 - where to spend its limited requests -> when a token is moving or a gap is
   nearly big enough, it re-checks just that token every couple of seconds
It also explains what it noticed in plain language (thoughts()).

State is saved to disk (same JSON format as the TypeScript bot, so a phone's
existing brain file carries over) and kept across restarts.
"""

import math
import random as _random
from typing import Callable

from .atomic import read_json_with_backup, write_json_atomic
from .util import iso, js_round, js_str, now_ms, to_fixed, utc_hour

#: Trade size as a share of the maximum the wallet allows.
SIZE_BUCKETS = (0.25, 0.5, 1)

EDGE_SMOOTHING = 0.2
HOUR_SMOOTHING = 0.05
#: Tries each size this many times before trusting the averages.
SIZE_WARMUP = 3
#: A discovered token this bad after this many scans is dropped.
PRUNE_AFTER_SCANS = 50
PRUNE_BELOW_BPS = -30
HAIRCUT_SMOOTHING = 0.3
#: Pace learning: start here, speed up 10% after this many clean scans, halve speed on a rate limit.
START_MS_PER_REQUEST = 1_333
MAX_MS_PER_REQUEST = 10_000
CLEAN_SCANS_TO_SPEED_UP = 5
#: On restart, start no slower than this multiple of the budget's even spacing.
RESTART_PACE_CAP = 1.5
#: Focus mode: up to this many focus scans in a row, then one full scan so nothing is ignored.
FOCUS_TURNS = 2
FOCUS_MAX_TOKENS = 2
#: A best gap within this many bps of the bar puts that token in focus for a minute.
NEAR_GAP_BPS = 5
NEAR_GAP_FOCUS_MS = 60_000
#: A move this big (bps) between two scans of a token marks it "hot"...
HOT_MOVE_BPS = 30
#: ...if the two scans were at most this far apart.
HOT_WINDOW_MS = 5 * 60_000
#: How long a hot token gets extra attention.
HOT_FOR_MS = 2 * 60_000


def ewma(prev: float, nxt: float, a: float) -> float:
    return prev * (1 - a) + nxt * a


#: Edge ranges (bps) for the "how close did gaps get" histogram.
EDGE_BINS: list[tuple[str, float]] = [
    ("< -20", -20),
    ("-20..-5", -5),
    ("-5..0", 0),
    ("0..5", 5),
    ("5..10", 10),
    ("10..20", 20),
    ("20+", math.inf),
]


def edge_bin(bps: float) -> str:
    return next(label for label, up_to in EDGE_BINS if bps < up_to)


def bucket_key(bucket: float) -> str:
    """Size buckets are stored as "0.25", "0.5", "1" (JavaScript object keys)."""
    return js_str(float(bucket))


def _js_entries(d: dict) -> list[tuple[str, dict]]:
    """Object.entries order: integer-like keys ascending first, then the rest as inserted."""
    ints = sorted((k for k in d if k.isdigit() and (k == "0" or not k.startswith("0"))), key=int)
    return [(k, d[k]) for k in ints] + [(k, v) for k, v in d.items() if k not in ints]


def _fmt_time(ms: float) -> str:
    return iso(int(ms))[5:16].replace("T", " ") + " UTC"


class Brain:
    def __init__(
        self,
        path: str,
        base_min_profit_bps: float,
        *,
        min_bps: float | None = None,
        max_bps: float | None = None,
        tokens_per_cycle: int = 3,
        explore_rate: float = 0.2,
        min_interval_ms: float = 1_000,
        min_ms_per_request: float = 1_000,
        max_interval_ms: float = 60_000,
        random: Callable[[], float] = _random.random,
        now: Callable[[], int] = now_ms,
    ):
        self.path = path
        self.min_bps = max(5, math.floor(base_min_profit_bps / 2)) if min_bps is None else min_bps
        self.max_bps = base_min_profit_bps * 4 if max_bps is None else max_bps
        self.tokens_per_cycle = tokens_per_cycle
        self.explore_rate = explore_rate
        self.min_interval_ms = min_interval_ms
        self.min_ms_per_request = min_ms_per_request
        self.max_interval_ms = max_interval_ms
        self.random = random
        self._now = now
        #: True when the main brain file was unreadable and the backup copy was used.
        self.restored_from_backup = False
        # Short-term memory (not saved): last price seen per token+size, and hot tokens.
        self._last_rate: dict[str, tuple[float, float]] = {}
        self._hot_until: dict[str, float] = {}
        self._clean_scans = 0
        self._focus_turns = 0

        loaded = self._load()
        state: dict = {"tokens": {}, "minProfitBps": base_min_profit_bps, "totalScans": 0}
        state.update(loaded or {})
        loaded = loaded or {}
        # Older brain files lack these; fill them in so they upgrade in place.
        hours = loaded.get("hourEdgeBps")
        if not isinstance(hours, list):
            hours = [None] * 24
        state["hourEdgeBps"] = (hours + [None] * 24)[:24]
        state["discovered"] = loaded.get("discovered") or {}
        state["edgeHistogram"] = loaded.get("edgeHistogram") or {}
        state["startedAt"] = loaded["startedAt"] if loaded.get("startedAt") is not None else self._now()
        state["bestGap"] = loaded.get("bestGap")
        # Older brains stored a pace per 6-request scan; convert it.
        if loaded.get("msPerRequest") is not None:
            state["msPerRequest"] = loaded["msPerRequest"]
        elif loaded.get("paceFloorMs"):
            state["msPerRequest"] = loaded["paceFloorMs"] / 6
        else:
            state["msPerRequest"] = START_MS_PER_REQUEST
        state["hotEvents"] = loaded.get("hotEvents") or 0
        state["lastHot"] = loaded.get("lastHot")
        state.pop("paceFloorMs", None)
        # Don't drag a slow pace from an old run forever: if it is still needed,
        # one "too many requests" re-learns it within seconds.
        state["msPerRequest"] = min(state["msPerRequest"], self.min_ms_per_request * RESTART_PACE_CAP)
        for s in state["tokens"].values():
            s.setdefault("sizes", {})
            s.setdefault("phantoms", 0)
            s.setdefault("haircutBps", 0)
            s.setdefault("realityChecks", 0)
        self.state = state

    def _load(self) -> dict | None:
        read = read_json_with_backup(self.path)
        if not read or not isinstance(read[0], dict):
            return None
        self.restored_from_backup = read[1]
        return read[0]

    def save(self) -> None:
        """Crash-safe: a power cut mid-save can't wipe what the brain learned."""
        write_json_atomic(self.path, self.state, backup=True, pretty=True)

    def _stats(self, symbol: str) -> dict:
        tokens = self.state["tokens"]
        if symbol not in tokens:
            tokens[symbol] = {
                "scans": 0,
                "avgEdgeBps": 0,
                "fills": 0,
                "failures": 0,
                "pnlUsd": 0,
                "phantoms": 0,
                "haircutBps": 0,
                "realityChecks": 0,
                "sizes": {},
            }
        return tokens[symbol]

    # ---- which tokens ------------------------------------------------------

    def rank_tokens(self, symbols) -> list[str]:
        """Symbols, most promising first (the same order scans use)."""
        return sorted(symbols, key=lambda s: -self.score(s))

    def forget_token(self, symbol: str) -> bool:
        """Drops a discovered token (e.g. one the safety check blocked). True if it was there."""
        return self.state["discovered"].pop(symbol, None) is not None

    def token_pool(self, configured: dict[str, str]) -> dict[str, str]:
        """Configured tokens plus the ones it discovered by itself."""
        return {**self.state["discovered"], **configured}

    def learn_tokens(self, found: dict[str, str], configured: dict[str, str], max_total: int) -> list[str]:
        """
        Adds newly discovered tokens, after first forgetting discovered tokens
        that proved useless. Configured tokens are never dropped.
        """
        discovered = self.state["discovered"]
        for sym in list(discovered):
            s = self.state["tokens"].get(sym)
            if s and s["scans"] >= PRUNE_AFTER_SCANS and s["avgEdgeBps"] < PRUNE_BELOW_BPS and s["fills"] == 0:
                del discovered[sym]
        known_mints = set(configured.values()) | set(discovered.values())
        added: list[str] = []
        for sym, mint in found.items():
            if len(self.token_pool(configured)) >= max_total:
                break
            if mint in known_mints or sym in configured or sym in discovered:
                continue
            discovered[sym] = mint
            known_mints.add(mint)
            added.append(sym)
        return added

    def score(self, symbol: str) -> float:
        """UCB-style score: tokens with a good edge rank high; rarely-scanned ones get a curiosity bonus."""
        s = self._stats(symbol)
        if s["scans"] == 0:
            return math.inf
        curiosity = 10 * math.sqrt(math.log(self.state["totalScans"] + 1) / s["scans"])
        # Tokens whose gaps turn out fake (phantoms) or fail lose trust.
        tries = s["fills"] + s["failures"] + s["phantoms"]
        reliability = (s["fills"] + 0.5) / (tries + 1) if tries > 0 else 0.5
        return s["avgEdgeBps"] + curiosity + 10 * reliability

    def pick_tokens(self, all_tokens: dict[str, str], now: float | None = None) -> dict[str, str]:
        """
        Picks which tokens to scan this cycle. While a token is hot (sudden
        move, or a gap nearly big enough) it gets focus scans of just itself,
        which cost a third of the requests and so can run about 3x as often;
        every third scan is a full one so nothing else is ignored.
        """
        now = self._now() if now is None else now
        symbols = list(all_tokens)
        n = min(self.tokens_per_cycle, len(symbols))
        ranked = self.rank_tokens(symbols)
        hot = [s for s in ranked if self.is_hot(s, now)]
        if hot and self._focus_turns < FOCUS_TURNS:
            self._focus_turns += 1
            return {s: all_tokens[s] for s in hot[:FOCUS_MAX_TOKENS]}
        self._focus_turns = 0
        chosen = (hot + [s for s in ranked if s not in hot])[:n]
        if len(hot) < n and self.random() < self.explore_rate and len(symbols) > n:
            rest = [s for s in ranked if s not in chosen]
            chosen[n - 1] = rest[math.floor(self.random() * len(rest))]
        return {s: all_tokens[s] for s in chosen}

    # ---- sudden moves ------------------------------------------------------

    def observe_price(self, symbol: str, bucket: float, rate: float, now: float | None = None) -> float | None:
        """
        Watches each token's price between scans (same trade size, so price
        impact doesn't fake a move). A sharp move marks it hot for a while:
        that is when gaps between exchanges tend to open.
        """
        now = self._now() if now is None else now
        key = f"{symbol}:{bucket_key(bucket)}"
        prev = self._last_rate.get(key)
        self._last_rate[key] = (rate, now)
        if not prev or prev[0] <= 0 or now - prev[1] > HOT_WINDOW_MS:
            return None
        move_bps = abs(rate / prev[0] - 1) * 10_000
        if move_bps >= HOT_MOVE_BPS:
            if not self.is_hot(symbol, now):
                self.state["hotEvents"] += 1
                self.state["lastHot"] = {"symbol": symbol, "bps": js_round(move_bps * 10) / 10, "at": now}
            self._hot_until[symbol] = now + HOT_FOR_MS
        return move_bps

    def hot_symbols(self, now: float | None = None) -> list[str]:
        now = self._now() if now is None else now
        return [sym for sym, until in self._hot_until.items() if until > now]

    def is_hot(self, symbol: str, now: float | None = None) -> bool:
        now = self._now() if now is None else now
        return self._hot_until.get(symbol, 0) > now

    # ---- how much to trust quotes ------------------------------------------

    def observe_reality(self, symbol: str, quoted_net_bps: float, real_net_bps: float) -> None:
        """
        Learns from an on-chain check how much the quote overstated reality.
        real_net_bps is what actually would have been made (0 for a fake gap).
        """
        s = self._stats(symbol)
        miss = quoted_net_bps - real_net_bps
        s["haircutBps"] = miss if s["realityChecks"] == 0 else ewma(s["haircutBps"], miss, HAIRCUT_SMOOTHING)
        s["realityChecks"] += 1

    def expected_net_bps(self, symbol: str, quoted_net_bps: float) -> float:
        """The quote, discounted by how much this token's quotes usually overstate reality."""
        s = self.state["tokens"].get(symbol)
        return quoted_net_bps - max(0, (s or {}).get("haircutBps") or 0)

    def should_attempt(self, symbol: str, quoted_net_bps: float) -> bool:
        """
        Whether to act on a quoted gap. Uses the discounted value; but if only
        the discount stands in the way, it still re-checks now and then, since
        conditions change.
        """
        if self.expected_net_bps(symbol, quoted_net_bps) >= self.min_profit_bps:
            return True
        return quoted_net_bps >= self.min_profit_bps and self.random() < self.explore_rate

    # ---- what size ---------------------------------------------------------

    def pick_size(self, symbol: str, max_usd: float) -> tuple[float, float]:
        """
        (usd, bucket): how much of `max_usd` to trade for this token. Smaller
        trades move the price less (better %), bigger ones make more per win;
        it learns which nets the most dollars per token.
        """
        sizes = self._stats(symbol)["sizes"]
        bucket = next((b for b in SIZE_BUCKETS if sizes.get(bucket_key(b), {}).get("n", 0) < SIZE_WARMUP), None)
        if bucket is None:
            if self.random() < self.explore_rate:
                bucket = SIZE_BUCKETS[math.floor(self.random() * len(SIZE_BUCKETS))]
            else:
                bucket = sorted(SIZE_BUCKETS, key=lambda b: -sizes[bucket_key(b)]["avgNetUsd"])[0]
        usd = math.floor(max_usd * bucket * 100) / 100
        # Tiny trades are all fees; fall back to the full size.
        return (usd, bucket) if usd >= 1 else (max_usd, 1)

    # ---- learning from scans and trades ------------------------------------

    def observe_scan(self, symbol: str, net_bps: float, net_usd: float = 0, bucket: float = 1, hour: int | None = None) -> None:
        hour = utc_hour(self._now()) if hour is None else hour
        s = self._stats(symbol)
        s["avgEdgeBps"] = net_bps if s["scans"] == 0 else ewma(s["avgEdgeBps"], net_bps, EDGE_SMOOTHING)
        s["scans"] += 1
        self.state["totalScans"] += 1

        b = s["sizes"].setdefault(bucket_key(bucket), {"n": 0, "avgNetUsd": net_usd})
        b["avgNetUsd"] = net_usd if b["n"] == 0 else ewma(b["avgNetUsd"], net_usd, EDGE_SMOOTHING)
        b["n"] += 1

        hours = self.state["hourEdgeBps"]
        prev = hours[hour]
        hours[hour] = net_bps if prev is None else ewma(prev, net_bps, HOUR_SMOOTHING)

    def observe_cycle(self, best_net_bps: float, symbol: str = "?", now: float | None = None) -> None:
        """Records the best edge of a scan cycle for the histogram."""
        now = self._now() if now is None else now
        hist = self.state["edgeHistogram"]
        label = edge_bin(best_net_bps)
        hist[label] = hist.get(label, 0) + 1
        best = self.state["bestGap"]
        if not best or best_net_bps > best["bps"]:
            self.state["bestGap"] = {"symbol": symbol, "bps": js_round(best_net_bps * 10) / 10, "at": now}
        # Nearly there: watch this token closely for a minute.
        if symbol != "?" and best_net_bps >= self.min_profit_bps - NEAR_GAP_BPS:
            self._hot_until[symbol] = max(self._hot_until.get(symbol, 0), now + NEAR_GAP_FOCUS_MS)

    def planned_requests(self, now: float | None = None) -> int:
        """Requests the next scan will make: a focus scan of the hot tokens, or a full one."""
        hot = len(self.hot_symbols(now))
        focus = hot > 0 and self._focus_turns < FOCUS_TURNS
        return 2 * (min(hot, FOCUS_MAX_TOKENS) if focus else self.tokens_per_cycle)

    def observe_trade(self, symbol: str, status: str, net_usd: float, verified: bool = True) -> None:
        """
        Learns from a trade outcome and adjusts how picky it is. Only results
        checked against the real chain may make it less picky: quote-only paper
        wins are too optimistic to learn from.
        """
        s = self._stats(symbol)
        s["pnlUsd"] += net_usd
        bps = self.state["minProfitBps"]
        if status in ("rejected", "stale"):
            # Gap was fake (gone at re-quote, or would revert) but cost nothing:
            # trust this token less, threshold unchanged.
            s["phantoms"] += 1
        elif status == "failed" or (status == "filled" and net_usd < 0):
            s["failures"] += 1 if status == "failed" else 0
            bps *= 1.25  # got burned: demand a fatter edge
        elif status == "filled":
            s["fills"] += 1
            if verified:
                bps *= 0.95  # really working: take slightly thinner edges for more trades
        self.state["minProfitBps"] = min(self.max_bps, max(self.min_bps, js_round(bps * 10) / 10))

    @property
    def min_profit_bps(self) -> float:
        return self.state["minProfitBps"]

    # ---- when to look ------------------------------------------------------

    def is_good_hour(self, hour: int) -> bool | None:
        """Better (True) or worse (False) than the typical hour; None if typical or not enough data."""
        known = [v for v in self.state["hourEdgeBps"] if v is not None]
        here = self.state["hourEdgeBps"][hour]
        if len(known) < 6 or here is None:
            return None  # not enough data yet
        median = sorted(known)[len(known) // 2]
        return True if here > median else False if here < median else None

    def next_interval_ms(
        self,
        best_net_bps: float | None,
        base_ms: float,
        hour: int | None = None,
        now: float | None = None,
        requests: int | None = None,
    ) -> int:
        """
        How long to wait before the next scan. Faster when a gap is nearly big
        enough or in a historically good hour; slower when nothing is close,
        which also saves the free API quota.
        """
        now = self._now() if now is None else now
        hour = utc_hour(self._now()) if hour is None else hour
        requests = self.planned_requests(now) if requests is None else requests
        factor = 1.0
        if any(until > now for until in self._hot_until.values()):
            factor *= 0.6
        if best_net_bps is not None:
            short_by = self.min_profit_bps - best_net_bps
            if short_by <= 5:
                factor *= 0.5
            elif short_by > 40:
                factor *= 1.5
        good = self.is_good_hour(hour)
        if good is True:
            factor *= 0.8
        elif good is False:
            factor *= 1.25
        return js_round(min(self.max_interval_ms, max(self.scan_pace_ms(requests), base_ms * factor)))

    # ---- how fast to scan --------------------------------------------------

    def observe_pace(self, rate_limited: bool) -> None:
        """
        Finds the fastest safe pace by itself: a little faster after every run
        of clean scans, twice as slow as soon as the price API says "too many
        requests". Remembered across restarts.
        """
        if rate_limited:
            self._clean_scans = 0
            self.state["msPerRequest"] = min(MAX_MS_PER_REQUEST, self.state["msPerRequest"] * 2)
            return
        self._clean_scans += 1
        if self._clean_scans >= CLEAN_SCANS_TO_SPEED_UP:
            self._clean_scans = 0
            self.state["msPerRequest"] = max(self.min_ms_per_request, js_round(self.state["msPerRequest"] * 0.9))

    @property
    def ms_per_request(self) -> float:
        """Learned safe spacing per request, never below the budget's even spacing."""
        return max(self.min_ms_per_request, self.state["msPerRequest"])

    def scan_pace_ms(self, requests: int) -> int:
        """Time a scan of `requests` requests needs at the learned safe pace."""
        return max(self.min_interval_ms, js_round(requests * self.ms_per_request))

    @property
    def pace_floor_ms(self) -> int:
        """Pace of a full scan (all tokens), for display."""
        return self.scan_pace_ms(self.tokens_per_cycle * 2)

    # ---- reporting ---------------------------------------------------------

    def thoughts(self, base_min_profit_bps: float) -> list[str]:
        """What the brain has noticed and why it acts the way it does, in plain language."""
        t: list[str] = []
        bps = self.state["minProfitBps"]
        tokens = self.state["tokens"]

        t.append(
            f"I only trade when a gap pays at least {js_str(bps)}bps ({to_fixed(bps / 100, 2)}%) after fees"
            + (
                ", stricter than at the start because some trades went badly."
                if bps > base_min_profit_bps
                else ", looser than at the start because trades have been working."
                if bps < base_min_profit_bps
                else "."
            )
        )

        best = self.state["bestGap"]
        if best:
            if best["bps"] >= bps:
                t.append(f"The best gap I've seen was {best['symbol']} at +{js_str(best['bps'])}bps ({_fmt_time(best['at'])}).")
            else:
                t.append(
                    f"The closest I've come is {best['symbol']} at {js_str(best['bps'])}bps ({_fmt_time(best['at'])}); "
                    f"I need {js_str(bps)}. The market hasn't offered a profitable gap yet."
                )

        liars = sorted(
            ((sym, s) for sym, s in tokens.items() if s["realityChecks"] >= 3 and s["haircutBps"] > 1),
            key=lambda e: -e[1]["haircutBps"],
        )[:2]
        for sym, s in liars:
            t.append(
                f"{sym}'s quotes look ~{to_fixed(s['haircutBps'], 1)}bps better than what really happens on-chain, "
                "so I discount them by that."
            )

        fakest = sorted(((sym, s) for sym, s in tokens.items() if s["phantoms"] >= 3), key=lambda e: -e[1]["phantoms"])
        if fakest:
            t.append(f"{fakest[0][0]} showed {fakest[0][1]['phantoms']} fake gaps, so I check it less often.")

        h = self.state["lastHot"]
        if h:
            t.append(
                f"I've reacted to {self.state['hotEvents']} sudden price move(s); the latest was {h['symbol']} "
                f"moving {to_fixed(h['bps'] / 100, 2)}% within minutes ({_fmt_time(h['at'])}), so I watched it closely."
            )

        hours = [(hr, v) for hr, v in enumerate(self.state["hourEdgeBps"]) if v is not None]
        if len(hours) >= 6:
            best_hour = sorted(hours, key=lambda x: -x[1])[0][0]
            t.append(f"Gaps have been best around {best_hour}:00 UTC, so I scan faster then.")

        found = list(self.state["discovered"])
        if found:
            t.append(f"I found {len(found)} extra token(s) to watch by myself: {', '.join(found)}.")

        ranked = self.rank_tokens(list(tokens))
        if ranked and self.state["totalScans"] > 20:
            t.append(f"Right now {ranked[0]} looks most promising to me.")
        return t

    def summary(self) -> str:
        lines = [f"profit threshold: {js_str(self.state['minProfitBps'])}bps"]

        hours = sorted(
            ((hr, v) for hr, v in enumerate(self.state["hourEdgeBps"]) if v is not None), key=lambda x: -x[1]
        )[:3]
        if hours:
            lines.append("best hours (UTC): " + ", ".join(f"{hr}:00 ({to_fixed(v, 1)}bps)" for hr, v in hours))

        hist = self.state["edgeHistogram"]
        total = sum(hist.values())
        if total:
            parts = [
                f"{label}: {to_fixed(hist[label] / total * 100, 1)}%" for label, _ in EDGE_BINS if hist.get(label, 0) > 0
            ]
            lines.append(f"best gap per scan (bps): {', '.join(parts)}")

        discovered = list(self.state["discovered"])
        if discovered:
            lines.append(f"found by itself: {', '.join(discovered)}")

        tokens = self.state["tokens"]
        for sym in self.rank_tokens(list(tokens)):
            s = tokens[sym]
            sizes = sorted(_js_entries(s["sizes"]), key=lambda e: -e[1]["avgNetUsd"])
            size = f", best size {js_round(float(sizes[0][0]) * 100)}%" if sizes else ""
            lines.append(
                f"{sym}: edge {to_fixed(s['avgEdgeBps'], 1)}bps, {s['fills']} fills, {s['failures']} fails, "
                f"{s['phantoms']} fake gaps, ${to_fixed(s['pnlUsd'], 4)}{size}"
                + (f", quotes discounted {to_fixed(max(0, s['haircutBps']), 1)}bps" if s["realityChecks"] else "")
            )
        return "\n".join(lines)
