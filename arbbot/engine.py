"""
The trading engine: the main loop that scans, decides, executes (or tests)
and learns. Same behaviour as the TypeScript bot it replaces, reading and
writing the same data files.
"""

import asyncio
import os
import random
import signal
import socket
import sys
import threading
import time

from .brain import Brain
from .budget import RequestBudget
from .config import TOKENS_PER_SCAN, is_real_money, jupiter_rate_windows, load_config, max_scans_per_min, trade_size_usd
from .costs import CostSettings, value_cycle
from .cycle import quote_cycle, spec_of, two_leg_spec
from .discovery import discover_tokens
from .executor import ExecDeps, ExecResult, live_execute, quote_only_execute, simulate_execute
from .funnel import STAGES, Funnel, build_opp_record
from .gate import GateThresholds, go_live_verdict, load_gate_input
from .http import make_client
from .jito import JitoClient
from .jupiter import JupiterClient
from .killswitch import HALT_FILE, disable_trading, trading_disabled
from .ledger import Ledger, basis_of, money_basis
from .log import log
from .notify import make_notifier
from .poolwatch import PoolWatcher, RpcSubscriber, WatchOptions
from .pricewatch import fetch_prices, requests_needed
from .gappredict import GapPredictor
from .probes import ProbeBudget, ProbeLog, held, probe_from_opp, venues_of
from .profit import usd_to_usdc_atoms
from .report import build_report_data, render_report
from .risk import RiskManager
from .scanner import fetch_sol_price_usd, scan_cycles
from .secret_checks import check_secrets
from .server import ServerDeps, ServerOptions, StatusServer, check_server_options
from .sizer import evaluate_ladder, ladder_sizes, pick_best_size
from .solana.rpc import Rpc
from .solana.ws import RpcWebSocket, ws_url_from
from .stats import LearningStats, Priors, score_opportunity
from .status import gather_status
from .status_file import write_status
from .sustain import format_verdict, month_verdict, should_retire
from .tokensafety import SafetyThresholds, TokenSafety, can_act, can_scan
from .trend import Trend
from .triangles import Rotation, triangle_specs
from .util import iso, js_round, js_str, now_ms, start_of_utc_day, start_of_utc_month, to_fixed
from .wallet import BalanceCache, load_keypair, wallet_value_usd

SOL_PRICE_REFRESH_MS = 5 * 60_000
DISCOVERY_INTERVAL_MS = 6 * 60 * 60_000
TIP_ACCOUNTS_RETRY_MS = 10 * 60_000
#: Short pause after "too many requests"; the learned pace does the real slowing down.
RATE_LIMIT_BACKOFF_MS = 10_000
#: On-chain tests need SOL for fees and for opening token accounts (~0.002 SOL each).
MIN_SOL_TO_SIMULATE = 0.01
#: While the kill switch is on, look for it being lifted this often.
KILL_SWITCH_POLL_MS = 5_000
#: Exit code for "refused to start" (bad settings, LIVE gate not passed).
#: deploy/termux-run.sh does not restart on it: restarting cannot fix it.
EXIT_REFUSED = 2
#: A cycle can legitimately wait for a landing (LANDING_TIMEOUT_MS, 2 min) plus requests; beyond this it hung.
WATCHDOG_MS = 6 * 60_000
#: A pool event can start the next scan early, but only this many in a row before a full scan.
MAX_EVENT_SCANS_IN_A_ROW = 2
#: At most this many dirty tokens per event scan (each costs a quote per leg).
EVENT_SCAN_TOKENS = 2
#: Triangles per triangle scan: 2 x 3 legs costs the same as a 3-token two-leg scan.
TRIANGLES_PER_SCAN = 2


class _Halt(Exception):
    """The bot halts for good (data/HALTED); exit code 0 so the runner stops too."""


class _Preempted(Exception):
    """A pool changed during a routine scan: skip the rest of it and quote that token now."""


def _lan_addresses(host: str) -> list[str]:
    if host not in ("0.0.0.0", "::"):
        return [host]
    try:
        # No packet is sent: connecting a UDP socket only picks the outgoing interface.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return [s.getsockname()[0]]
    except OSError:
        return [host]


class Engine:
    def __init__(self, cfg):
        self.cfg = cfg
        self.running = True
        # Sleep that a stop signal can cut short, so stopping the bot is immediate. The idle
        # sleep between scans can also be cut short by a pool event; waits for the rate
        # limit cannot (that would send requests before there is room for them).
        self._wake_any: asyncio.Event | None = None
        self._wake_idle: asyncio.Event | None = None
        self.last_progress_at = time.time() * 1000
        self._finished = threading.Event()

    # -- sleeping and stopping ------------------------------------------------------

    async def sleep(self, ms: float, idle: bool = False) -> None:
        if not self.running:
            return  # a stop that came in mid-cycle must not wait out the next pause
        ev = asyncio.Event()
        self._wake_any = ev
        if idle:
            self._wake_idle = ev
        try:
            await asyncio.wait_for(ev.wait(), max(0, ms) / 1000)
        except asyncio.TimeoutError:
            pass
        finally:
            self._wake_any = None
            if idle:
                self._wake_idle = None

    def wake_idle(self) -> None:
        if self._wake_idle:
            self._wake_idle.set()

    def stop(self) -> None:
        self.running = False
        if self._wake_any:
            self._wake_any.set()

    def _start_watchdog(self, watchdog_ms: float) -> None:
        """If the loop makes no progress for this long (something hung that no timeout caught),
        exit with an error so deploy/termux-run.sh restarts the bot. A thread, so it fires even
        if the event loop itself is stuck."""

        def watch() -> None:
            while not self._finished.wait(30):
                if time.time() * 1000 - self.last_progress_at > watchdog_ms:
                    log.error(f"no progress for {round(watchdog_ms / 60_000)} minutes: restarting")
                    os._exit(1)

        threading.Thread(target=watch, name="watchdog", daemon=True).start()

    # -- the run ------------------------------------------------------------------------

    async def run(self) -> int:
        cfg = self.cfg
        secrets = check_secrets(dict(os.environ), cfg.mode, ".env")
        for w in secrets.warnings:
            log.warn(w)
        if secrets.errors:
            for e in secrets.errors:
                log.error(e)
            log.error("Refusing to start until the settings above are fixed.")
            return EXIT_REFUSED
        halt_file = os.path.join(cfg.data_dir, HALT_FILE)
        if os.path.exists(halt_file):
            log.error(f"Bot is halted ({halt_file}). Read it, then delete it to restart.")
            return EXIT_REFUSED

        # Optional status server: status page, JSON, report, emergency stop. Never starts trading.
        server_opts = (
            ServerOptions(cfg.status_http_host, cfg.status_http_port, cfg.status_http_token)
            if cfg.status_http_port is not None
            else None
        )
        if server_opts:
            problem = check_server_options(server_opts)
            if problem:
                log.error(f"Refusing to start: {problem}")
                return EXIT_REFUSED

        # The go-live gate: paper profits are never evidence. LIVE (adaptive size) needs proven
        # MICRO results; MICRO is only warned about, since every trade is capped at
        # MICRO_MAX_TRADE_USD and its purpose is to collect that proof.
        if is_real_money(cfg.mode):
            verdict = go_live_verdict(load_gate_input(cfg.data_dir), GateThresholds.from_config(cfg))
            if cfg.mode == "live" and not verdict.live.ok:
                log.error("LIVE mode refused: real execution has not proven itself yet.")
                for r in verdict.live.reasons:
                    log.error(f"  - {r}")
                log.error("Prove execution with tiny capped trades first (npm run micro), then check: npm run report")
                return EXIT_REFUSED
            if cfg.mode == "micro" and not verdict.micro.ok:
                log.warn("MICRO is starting although the paper results do not recommend it yet:")
                for r in verdict.micro.reasons:
                    log.warn(f"  - {r}")
                log.warn(f"Every trade is capped at ${js_str(cfg.micro_max_trade_usd)}.")

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, self.stop)
            except (NotImplementedError, RuntimeError):
                pass

        async with make_client() as http:
            self.ws = RpcWebSocket(cfg.rpc_ws_url or ws_url_from(cfg.rpc_url))
            try:
                return await self._run(http, halt_file, server_opts)
            except _Halt:
                return 0
            finally:
                self._finished.set()
                await self.ws.close()

    async def _run(self, http, halt_file: str, server_opts: ServerOptions | None) -> int:
        cfg = self.cfg
        notify = make_notifier(cfg, http)
        # Every Jupiter request goes through one counter covering a 60s and a 10s window, and the
        # bot waits for room before each request group, so it never bursts over Jupiter's limits.
        budget = RequestBudget(jupiter_rate_windows(cfg.jupiter_rpm))
        jup = JupiterClient(cfg.jupiter_api, http, cfg.jupiter_api_key, on_request=budget.record)
        rpc = Rpc(cfg.rpc_url, http)
        # Only real-money modes ever hold a signer. Paper mode only needs the public address.
        wallet = load_keypair(cfg.signing_key) if is_real_money(cfg.mode) and cfg.signing_key else None
        owner = (
            wallet.public_key
            if wallet
            else cfg.wallet_public_key or (load_keypair(cfg.signing_key).public_key if cfg.signing_key else None)
        )
        money = money_basis(cfg.mode)
        jito = JitoClient(cfg.jito_url, http) if cfg.send_via == "jito" else None
        ledger = Ledger(os.path.join(cfg.data_dir, f"trades-{cfg.mode}.jsonl"))
        brain = Brain(
            os.path.join(cfg.data_dir, f"brain-{cfg.mode}.json"),
            cfg.min_profit_bps,
            min_interval_ms=cfg.min_scan_interval_ms,
            min_ms_per_request=cfg.jupiter_ms_per_request,
            tokens_per_cycle=TOKENS_PER_SCAN,
        )
        balance_cache = BalanceCache(rpc, owner) if owner else None
        # The opportunity funnel is the source of truth for learning; replay it at startup.
        funnel_path = os.path.join(cfg.data_dir, f"opps-{cfg.mode}.jsonl")
        funnel = Funnel(funnel_path)
        # Today's funnel counts for the status screen: how many reached at least each stage.
        funnel_today: dict[str, int] = {}
        funnel_day = start_of_utc_day(now_ms())

        def count_stage(o: dict) -> None:
            if o.get("stage") not in STAGES:
                return
            for st in STAGES[: STAGES.index(o["stage"]) + 1]:
                funnel_today[st] = funnel_today.get(st, 0) + 1

        # What re-checks taught: probes (paper) plus every re-quoted opportunity.
        probe_path = os.path.join(cfg.data_dir, f"probes-{cfg.mode}.jsonl")
        probe_log = ProbeLog(probe_path)
        probe_budget = ProbeBudget(cfg.probes_per_hour)
        past = Funnel.read(funnel_path)
        for o in past:
            if o["ts"] >= funnel_day:
                count_stage(o)
        # Predicts which gaps are real; replays every re-check, scoring each prediction first.
        gap_predictor = GapPredictor.from_records(ProbeLog.read(probe_path), past)
        learn = LearningStats.from_records(past, Priors(landing=cfg.landing_prior))
        del past
        # Price-direction predictions with paper trades only (never real money).
        trend = (
            Trend(cfg.data_dir, cfg.trend_horizon_min, cfg.trend_enter_prob, cfg.trend_max_positions, cfg.trend_stop_pct)
            if cfg.trend_paper and cfg.price_watch
            else None
        )
        risk = RiskManager(cfg)
        # Token safety: what each token's mint allows (fees, hooks, freezes...) and how healthy its market is.
        safety = TokenSafety(os.path.join(cfg.data_dir, "token-safety.json"), cfg.live_tokens, SafetyThresholds.from_config(cfg))
        last_safety: dict[str, str] = {}
        # Event triggers: re-quote a token as soon as a pool its route uses changes.
        watcher = (
            PoolWatcher(
                RpcSubscriber(self.ws),
                WatchOptions(cfg.max_watched_pools, cfg.event_daily_cap, cfg.event_debounce_ms, cfg.busy_pool_per_min),
                on_dirty=self.wake_idle,
                on_warn=log.warn,
            )
            if cfg.event_triggers
            else None
        )
        last_pools: dict[str, list[str]] = {}
        quote_ms_avg: float | None = None
        event_scans = 0
        full_scans = 0
        triangle_turns = Rotation()
        if brain.restored_from_backup:
            log.warn("brain file was unreadable; restored what it learned from the backup copy")
        # Older versions let quote-only paper wins lower the profit bar. Without any result
        # checked on-chain, there is no real evidence for that: undo it.
        if brain.min_profit_bps < cfg.min_profit_bps and not any(
            r.get("verified") and r.get("status") == "filled" for r in ledger.all()
        ):
            brain.state["minProfitBps"] = cfg.min_profit_bps
        costs = CostSettings.from_config(cfg)

        async def halt(reason: str) -> None:
            with open(halt_file, "w", encoding="utf-8") as f:
                f.write(f"{iso()} {reason}\n")
            await notify(f"HALTED: {reason}. Remaining funds stay in the wallet.")
            brain.save()
            raise _Halt(reason)

        server = None
        if server_opts:
            server = StatusServer(
                server_opts,
                ServerDeps(
                    status=lambda: {**gather_status(cfg), "processAlive": True},
                    report=lambda: render_report(build_report_data(cfg)),
                    stop_trading=lambda reason: (disable_trading(cfg.data_dir, reason), self.wake_idle()),
                ),
            )
            try:
                await server.start()
                hosts = _lan_addresses(server_opts.host)
                log.info(
                    "status page: " + " or ".join(f"http://{h}:{server_opts.port}/" for h in hosts)
                    + (" (add ?token=<STATUS_HTTP_TOKEN>)" if server_opts.token else "")
                )
            except OSError as err:
                log.warn(f"status server: {err}")
                server = None

        watchdog_ms = max(WATCHDOG_MS, cfg.landing_timeout_ms + 4 * 60_000)
        self.last_progress_at = time.time() * 1000
        self._start_watchdog(watchdog_ms)

        tip_accounts: list[str] = []
        tip_accounts_at = 0.0

        async def refresh_tip_accounts() -> None:
            nonlocal tip_accounts, tip_accounts_at
            # Only needed to build real transactions (live, or on-chain paper testing).
            if not jito or not owner or tip_accounts or now_ms() - tip_accounts_at < TIP_ACCOUNTS_RETRY_MS:
                return
            tip_accounts_at = now_ms()
            try:
                tip_accounts = await jito.get_tip_accounts()
            except Exception as err:  # noqa: BLE001
                log.warn(f"could not load Jito tip accounts (will retry): {str(err)[:120]}")

        def pick_tip() -> str | None:
            return random.choice(tip_accounts) if tip_accounts else None

        async def wait_for_jupiter(requests: int) -> None:
            ms = budget.wait_for(requests)
            if ms > 0 and self.running:
                await self.sleep(ms)

        sol_price = await fetch_sol_price_usd(jup)
        sol_price_at = now_ms()
        discovered_at = 0
        last_day = start_of_utc_day(now_ms())
        last_month = start_of_utc_month(now_ms())
        warned_unfunded = False
        kill_switch_on = False
        price_watch_at = 0
        price_failures = 0
        watched_prices = 0
        last_opp: dict | None = None

        # Live progress for `status`.
        status_path = os.path.join(cfg.data_dir, "status.json")
        started_at = now_ms()
        cycles = 0
        scan_times: list[int] = []

        def scans_in_last_minute() -> int:
            while scan_times and scan_times[0] <= now_ms() - 60_000:
                scan_times.pop(0)
            return len(scan_times)

        status: dict = {
            "pid": os.getpid(),
            "mode": cfg.mode,
            "startedAt": started_at,
            "updatedAt": started_at,
            "cycles": 0,
            "state": "scanning",
            "onChainTesting": False,
            "sendVia": cfg.send_via,
            "solPrice": 0,
            "walletValueUsd": cfg.starting_balance_usd,
            "tradeSizeUsd": 0,
            "hot": [],
            "nextScanInMs": 0,
        }

        def publish(**patch) -> None:
            status.update(patch)
            status.update(updatedAt=now_ms(), cycles=cycles, solPrice=sol_price, hot=brain.hot_symbols())
            try:
                write_status(status_path, status)
            except OSError:
                pass  # status is only for display; never let it stop trading

        if is_real_money(cfg.mode):
            how = f"REAL transactions via {cfg.send_via.upper()}" + (
                f", capped at ${js_str(cfg.micro_max_trade_usd)} per trade" if cfg.mode == "micro" else ""
            )
        elif owner:
            how = "testing each trade on-chain with your wallet's public address (nothing is sent)"
        else:
            how = "quote-only (add WALLET_PUBLIC_KEY for realistic on-chain testing; quoted amounts are not profit)"
        await notify(
            f"Started in {cfg.mode.upper()} mode, {how}"
            + (f". Wallet {owner}" if owner else "")
            + f". Loss floor ${js_str(cfg.loss_floor_usd)}, no profit cap. SOL=${to_fixed(sol_price, 2)}"
        )
        log.info(
            f"Jupiter: {'using your API key' if cfg.jupiter_api_key else 'no API key'} ({cfg.jupiter_rpm} requests/min), "
            f"so up to ~{to_fixed(max_scans_per_min(cfg.jupiter_ms_per_request), 1)} full scans/min, "
            f"or ~{to_fixed(max_scans_per_min(cfg.jupiter_ms_per_request, 2), 0)} focus scans/min on a moving token "
            "(fewer in practice: each scan keeps room to act on a gap at once)"
        )

        while self.running:
            self.last_progress_at = time.time() * 1000
            # Emergency stop (stop-trading, or tripped by an unexpected outcome):
            # do nothing but wait until a person re-enables trading.
            kill = trading_disabled(cfg.data_dir)
            if kill:
                if not kill_switch_on:
                    kill_switch_on = True
                    await notify(f"TRADING DISABLED: {kill}. Waiting. Re-enable after checking: npm run enable-trading")
                publish(state="disabled", note=kill, nextScanInMs=KILL_SWITCH_POLL_MS)
                await self.sleep(KILL_SWITCH_POLL_MS)
                continue
            if kill_switch_on:
                kill_switch_on = False
                log.event("trading re-enabled by hand; resuming")
            now = now_ms()
            cycles += 1
            next_wait_ms = cfg.scan_interval_ms
            rate_limited = False
            try:
                if cfg.token_discovery and now - discovered_at > DISCOVERY_INTERVAL_MS:
                    discovered_at = now
                    try:
                        await wait_for_jupiter(1)
                        found, facts = await discover_tokens(
                            cfg.jupiter_tokens_api, cfg.min_token_liquidity_usd, cfg.max_tokens, http, cfg.jupiter_api_key,
                            on_request=budget.record,
                        )
                        for sym, mint in found.items():
                            if facts.get(mint):
                                safety.note_market(mint, sym, facts[mint])
                        # Skip tokens already known to be blocked; new ones are checked before their first quote.
                        candidates = {s: m for s, m in found.items() if safety.verdict(s, m, False, now).state != "BLOCKED"}
                        added = brain.learn_tokens(candidates, cfg.tokens, cfg.max_tokens)
                        if added:
                            log.event(f"brain found new tokens to watch: {', '.join(added)}")
                    except Exception as err:  # noqa: BLE001
                        log.warn(f"token discovery failed (keeps current list): {str(err)[:120]}")
                await refresh_tip_accounts()

                if now - sol_price_at > SOL_PRICE_REFRESH_MS:
                    await wait_for_jupiter(1)
                    sol_price = await fetch_sol_price_usd(jup)
                    sol_price_at = now

                records = ledger.all()
                # Only simulated (paper) or realized (micro/live) amounts count as money; quoted never does.
                money_records = [r for r in records if basis_of(r) == money]

                # Daily and monthly bookkeeping.
                if start_of_utc_day(now) != last_day:
                    pnl = ledger.pnl_between(last_day, start_of_utc_day(now), records, [money])
                    quoted = ledger.pnl_between(last_day, start_of_utc_day(now), records, ["quoted"])
                    await notify(
                        f"Daily {money} P&L: {'+' if pnl >= 0 else ''}${to_fixed(pnl, 4)}"
                        + (f" (quotes alone suggested ${to_fixed(quoted, 4)}; not real)" if quoted else "")
                        + "\n"
                        + "\n".join(f"- {t}" for t in brain.thoughts(cfg.min_profit_bps))
                    )
                    last_day = start_of_utc_day(now)
                if start_of_utc_month(now) != last_month:
                    await notify(format_verdict(month_verdict(money_records, last_month, cfg.monthly_costs_usd)))
                    last_month = start_of_utc_month(now)
                    first_ts = money_records[0]["ts"] if money_records else None
                    if should_retire(money_records, now, cfg.monthly_costs_usd, cfg.sustain_stop_after_months, first_ts):
                        await halt(f"did not cover its bills for {cfg.sustain_stop_after_months} months in a row")

                # Wallet value: real on-chain in micro/live; in paper, start + simulated P&L only.
                paper_value = cfg.starting_balance_usd + sum(r["netUsd"] for r in money_records)
                value_usd = usdc_usd = paper_value
                simulate_as = None
                if owner and balance_cache:
                    b = await balance_cache.get()
                    real_usdc = b.usdc_atoms / 1e6
                    if is_real_money(cfg.mode):
                        value_usd = wallet_value_usd(b, sol_price)
                        usdc_usd = real_usdc
                    elif real_usdc >= 1 and b.lamports / 1e9 >= MIN_SOL_TO_SIMULATE:
                        # On-chain simulation can only spend what the wallet really holds.
                        usdc_usd = min(paper_value, real_usdc)
                        simulate_as = owner
                    elif not warned_unfunded:
                        warned_unfunded = True
                        log.warn(f"wallet needs at least $1 USDC and {MIN_SOL_TO_SIMULATE} SOL to test on-chain; quote-only until funded")

                decision = risk.check(value_usd, ledger.pnl_between(start_of_utc_day(now), records=records, bases=[money]), now)
                publish(walletValueUsd=value_usd, onChainTesting=cfg.mode == "paper" and bool(simulate_as))
                if not decision.ok:
                    if decision.halt:
                        await halt(decision.reason)
                    publish(state="paused", note=decision.reason, nextScanInMs=cfg.scan_interval_ms * 4)
                    log.event(f"paused: {decision.reason}")
                    await self.sleep(cfg.scan_interval_ms * 4)
                    continue

                size_usd = trade_size_usd(cfg, usdc_usd)
                if cfg.mode == "micro":
                    size_usd = min(size_usd, cfg.micro_max_trade_usd)
                if size_usd < 1:
                    publish(state="waiting", note=f"only ${to_fixed(usdc_usd, 2)} USDC available", nextScanInMs=cfg.scan_interval_ms * 4)
                    log.info(f"only ${to_fixed(usdc_usd, 2)} USDC available; waiting")
                    await self.sleep(cfg.scan_interval_ms * 4)
                    continue

                # Check new tokens' mints (and every token's, daily) before quoting them.
                pool = brain.token_pool(cfg.tokens)
                if safety.due(list(pool.values()), now):
                    try:
                        await safety.refresh(rpc, pool, now)
                    except Exception as err:  # noqa: BLE001
                        log.warn(f"token safety check failed (unchecked tokens stay paper-only; retrying later): {str(err)[:120]}")

                def safety_of(sym: str, mint: str):
                    return safety.verdict(sym, mint, sym in cfg.tokens, now)

                for sym, mint in pool.items():
                    v = safety_of(sym, mint)
                    if last_safety.get(mint) != v.state:
                        last_safety[mint] = v.state
                        if v.state != "LIVE_ALLOWED" or v.reasons:
                            log.event(f"token safety: {sym} is {v.state} ({'; '.join(v.reasons)})")
                    # A blocked discovered token would never be quoted, so the brain would never drop it.
                    if v.state == "BLOCKED" and brain.forget_token(sym):
                        log.event(f"brain dropped {sym}: blocked by the safety check")
                scannable = {s: m for s, m in pool.items() if can_scan(safety_of(s, m).state, cfg.mode)}
                if not scannable:
                    why = "no token is LIVE_ALLOWED yet (safety check pending or failed)" if is_real_money(cfg.mode) else "every token is blocked"
                    publish(state="waiting", note=why, nextScanInMs=cfg.scan_interval_ms * 4)
                    log.warn(why)
                    await self.sleep(cfg.scan_interval_ms * 4)
                    continue
                # Price watch: one request checks every token's price; a token that jumped gets
                # focus scans (round-trip quotes) first. It only says where to look: a single
                # price can't show a gap between exchanges.
                if cfg.price_watch and now - price_watch_at >= cfg.price_watch_ms:
                    price_watch_at = now
                    try:
                        await wait_for_jupiter(requests_needed(len(scannable)))
                        prices = await fetch_prices(http, cfg.jupiter_price_api, list(scannable.values()),
                                                    cfg.jupiter_api_key, budget.record)
                        watched_prices = len(prices)
                        price_failures = 0
                        if trend:
                            def cost_of(sym: str) -> float:
                                # What a buy-then-sell of this token costs, as this bot's own scans measured it.
                                t = brain.state["tokens"].get(sym)
                                if t and t.get("scans", 0) >= 5:
                                    return max(5.0, -float(t.get("avgEdgeBps", 0)))
                                return 40.0

                            tradable = {s for s, m in scannable.items() if can_act(safety_of(s, m).state, "paper")}
                            for line in trend.on_prices({s: prices[m] for s, m in scannable.items() if m in prices},
                                                        now_ms(), cost_of, size_usd, tradable):
                                log.event(line)
                        t = now_ms()
                        moved = []
                        for sym, mint in scannable.items():
                            if mint not in prices:
                                continue
                            was_hot = brain.is_hot(sym, t)
                            move = brain.observe_market_price(sym, prices[mint], t)
                            if move is not None and not was_hot and brain.is_hot(sym, t):
                                moved.append(f"{sym} {to_fixed(move, 0)}bps")
                        if moved:
                            log.event(f"moving fast (price watch): {', '.join(moved)}; checking them first")
                    except Exception as err:  # noqa: BLE001 - scans go on without it
                        if " 429" in str(err):
                            rate_limited = True
                        price_failures += 1
                        if price_failures in (1, 10) or price_failures % 100 == 0:
                            log.warn(f"price watch failed {price_failures}x (scans go on as before): {str(err)[:120]}")
                # A pool just changed: quote those tokens now, while any gap is fresh
                # (with a full scan every few turns so nothing else is ignored).
                dirty = [(s, ts) for s, ts in (watcher.take_dirty() if watcher else []) if s in scannable]
                market_ts: dict[str, float] = {}
                tokens: dict[str, str] = {}
                triangles = []
                routine_scan = not (dirty and event_scans < MAX_EVENT_SCANS_IN_A_ROW)
                if not routine_scan:
                    event_scans += 1
                    tokens = {s: scannable[s] for s, _ in dirty[:EVENT_SCAN_TOKENS]}
                    for s, ts in dirty[EVENT_SCAN_TOKENS:]:
                        watcher.remark(s, ts)
                else:
                    event_scans = 0
                    full_scans += 1
                    # Every few full scans: triangles through the pivot, among configured tokens it may act on.
                    if cfg.triangles and full_scans % cfg.triangle_every == 0:
                        liquid = {s: m for s, m in scannable.items() if s in cfg.tokens and can_act(safety_of(s, m).state, cfg.mode)}
                        triangles = triangle_turns.take(triangle_specs(liquid, cfg.triangle_pivot), TRIANGLES_PER_SCAN)
                    if not triangles:
                        tokens = brain.pick_tokens(scannable)
                    for s, ts in dirty:
                        if s not in tokens:
                            watcher.remark(s, ts)
                for s, ts in dirty:
                    if s in tokens:
                        market_ts[s] = ts
                scan_times.append(now_ms())
                specs = triangles or [two_leg_spec(s, m) for s, m in tokens.items()]
                buckets: dict[str, float] = {}

                def size_for(spec) -> int:
                    usd, bucket = brain.pick_size(spec.symbol, size_usd)
                    buckets[spec.symbol] = bucket
                    return usd_to_usdc_atoms(usd)

                # Rank by expected value (net x learned chance of success), discounted for stale
                # quotes, slow execution, price impact and unproven tokens — not by the raw quote.
                with_wallet = bool(simulate_as) or is_real_money(cfg.mode)

                def gap_of(c, v) -> dict:
                    """A scanned gap, described the way the gap predictor learned them."""
                    return {"ts": now_ms(), "symbol": c.symbol, "kind": c.kind, "venues": venues_of(c.routes),
                            "sizeUsd": v.in_usd, "quotedBps": v.net_bps, "event": c.market_ts is not None}

                def predicted(c, v) -> dict:
                    p, fresh = gap_predictor.predict(gap_of(c, v))
                    return {"pHold": round(p, 4), "freshBps": round(fresh, 2)}

                def ev_for(c, v, p=None) -> float:
                    """Expected value, scaled by the gap predictor (venue trust until it has proven itself)."""
                    p = p or learn.probabilities(c.symbol, c.routes, cfg.mode, with_wallet)
                    ev = learn.expected_value(v.net_usd, v.costs.network_usd, p, cfg.mode, with_wallet)
                    return ev * gap_predictor.factor(gap_of(c, v)) if ev > 0 else ev

                def rank(x, at: float | None = None):
                    at = now_ms() if at is None else at
                    p = learn.probabilities(x.cycle.symbol, x.cycle.routes, cfg.mode, with_wallet)
                    ev = ev_for(x.cycle, x.val, p)
                    score = score_opportunity(
                        ev_usd=ev,
                        quote_age_ms=at - x.cycle.quoted_at,
                        expected_latency_ms=learn.medianish_latency_ms(),
                        price_impact_bps=x.cycle.price_impact_bps,
                        max_impact_bps=cfg.max_price_impact_bps,
                        discovered=any(t not in cfg.tokens for t in x.cycle.tokens),
                    )
                    return p, ev, score

                def safe_to_act(x) -> bool:
                    """Every token the cycle passes through must allow acting in this mode."""
                    return all(can_act(safety_of(sym, x.cycle.path[k + 1]).state, cfg.mode) for k, sym in enumerate(x.cycle.tokens))

                def worth_acting(x, ev: float) -> bool:
                    return (
                        safe_to_act(x)
                        and brain.should_attempt(x.cycle.symbol, x.val.net_bps)
                        and ev >= cfg.min_expected_profit_usd
                        and x.cycle.price_impact_bps <= cfg.max_price_impact_bps
                    )

                can_probe = cfg.mode == "paper" and cfg.probes
                probe_target = None

                def on_error(spec, err) -> None:
                    nonlocal rate_limited
                    if not self.running or isinstance(err, _Preempted):
                        return  # stopping, or a pool changed: skip the remaining quotes quietly
                    if " 429" in str(err):
                        rate_limited = True
                    log.warn(f"quote {spec.symbol} failed: {str(err)[:120]}")

                scan_started_at = now_ms()
                quoted_in_scan = 0

                def preempt(spec) -> None:
                    # A pool changed since this routine scan began: its token is quoted next,
                    # instead of after the rest of this scan (each token here waits for budget).
                    # The first token of a scan always goes ahead, so routine scans still progress.
                    others = {s: m for s, m in scannable.items() if s != spec.symbol}
                    if routine_scan and quoted_in_scan and watcher and watcher.pending(others, since=scan_started_at):
                        raise _Preempted()

                def market_ts_for(spec):
                    # Quoting a token whose pool just changed handles that change: record when it
                    # happened, and don't quote it again in a separate event scan.
                    if spec.symbol not in market_ts and watcher and spec.kind == "two-leg":
                        ts = watcher.take(spec.symbol)
                        if ts is not None:
                            market_ts[spec.symbol] = ts
                    return market_ts.get(spec.symbol)

                async def before_each(spec) -> None:
                    # Each leg costs 1 request. Wait until the cycle fits in every rate window AND
                    # enough room stays free to execute a gap at once (re-quote, and build when
                    # testing on-chain): a gap found but executed seconds later is gone.
                    nonlocal quoted_in_scan
                    preempt(spec)
                    legs = len(spec.path) - 1
                    await wait_for_jupiter(legs + (legs * 2 if with_wallet else legs))
                    if not self.running:
                        raise RuntimeError("stopping")
                    preempt(spec)
                    quoted_in_scan += 1

                def stop_after(x) -> bool:
                    # Gaps last moments: act on the first one worth it instead of quoting the rest first.
                    # In paper mode, also stop at a positive gap below the bar while probes are allowed,
                    # so its re-check happens right away, as a real trade's would.
                    nonlocal probe_target
                    if worth_acting(x, rank(x)[1]):
                        return True
                    if can_probe and probe_target is None and x.val.net_bps > cfg.probe_min_bps and probe_budget.has():
                        probe_target = x
                        return True
                    return False

                scored = await scan_cycles(
                    jup, specs, size_for, sol_price, costs,
                    on_error=on_error, before_each=before_each,
                    market_ts_for=market_ts_for, stop_after=stop_after,
                )
                for x in scored:
                    last_pools[x.cycle.symbol] = x.cycle.pools
                    # Measured time to quote every leg of a cycle, from this device.
                    ms = x.cycle.quoted_at - x.cycle.quote_started_at
                    quote_ms_avg = ms if quote_ms_avg is None else quote_ms_avg * 0.8 + ms * 0.2
                for x in scored:
                    cycle, val = x.cycle, x.val
                    bucket = buckets.get(cycle.symbol, 1)
                    brain.observe_scan(cycle.symbol, val.net_bps, val.net_usd, bucket)
                    if cycle.kind != "two-leg":
                        continue  # price moves are tracked per token, on its own round trip
                    was_hot = brain.is_hot(cycle.symbol)
                    leg1 = cycle.legs[0]
                    move = brain.observe_price(cycle.symbol, bucket, int(leg1["outAmount"]) / int(leg1["inAmount"]))
                    if move is not None and not was_hot and brain.is_hot(cycle.symbol):
                        log.event(f"{cycle.symbol} is moving fast ({to_fixed(move, 0)}bps); watching it closely")
                if scored:
                    brain.observe_cycle(scored[0].val.net_bps, scored[0].cycle.symbol)

                ranked_at = now_ms()
                ranked = sorted(((x, *rank(x, ranked_at)) for x in scored), key=lambda e: -e[3])
                best = ranked[0] if ranked else None
                if best:
                    bx, bp, bev, _ = best
                    exp = brain.expected_net_bps(bx.cycle.symbol, bx.val.net_bps)
                    log.info(
                        f"best {bx.cycle.symbol} ${to_fixed(bx.val.in_usd, 2)}: quoted net {to_fixed(bx.val.net_bps, 1)}bps "
                        + (f"(expect {to_fixed(exp, 1)}) " if abs(exp - bx.val.net_bps) >= 0.1 else "")
                        + f"(${to_fixed(bx.val.net_usd, 4)} after ${to_fixed(bx.val.costs.total_usd, 4)} costs) "
                        + f"need {js_str(brain.min_profit_bps)}bps, EV ${to_fixed(bev, 4)} (P={to_fixed(bp.success * 100, 0)}%) "
                        + f"[{bx.cycle.routes}]"
                    )

                if best and worth_acting(best[0], best[2]):
                    bx, bp, bev, _ = best
                    # Size ladder: try a few sizes (within every limit) and keep the best expected value.
                    # Only with requests free right now (keeping enough to execute): waiting seconds
                    # for room to compare sizes would let the gap close.
                    cycle, val = bx.cycle, bx.val
                    chosen_p, chosen_ev = bp, bev
                    ladder = None
                    ladder_says_no = False
                    legs_n = len(bx.cycle.legs)
                    exec_requests = legs_n * 2 if simulate_as or is_real_money(cfg.mode) else legs_n
                    spare_sizes = max(0, (budget.available() - exec_requests) // legs_n)
                    points_n = min(cfg.max_ladder_points, 1 + spare_sizes)
                    sizes = ladder_sizes(cfg.size_ladder_usd, size_usd, 1, points_n, bx.val.in_usd)
                    if len(sizes) > 1:
                        async def quote_at(usd: float):
                            await wait_for_jupiter(len(bx.cycle.legs))
                            c = await quote_cycle(jup, spec_of(bx.cycle), usd_to_usdc_atoms(usd), market_ts=bx.cycle.market_ts)
                            return c, value_cycle(c, sol_price, costs)

                        points = await evaluate_ladder(
                            sizes, quote_at, lambda c, v: ev_for(c, v), cfg.max_price_impact_bps, (bx.cycle, bx.val),
                            lambda usd, err: log.warn(f"size ${js_str(usd)} quote failed: {str(err)[:100]}"),
                        )
                        ladder = [
                            {"sizeUsd": p.size_usd, "netUsd": p.val.net_usd, "netBps": p.val.net_bps, "evUsd": p.ev_usd, "impactBps": p.impact_bps}
                            for p in points
                        ]
                        top = pick_best_size(points)
                        if top:
                            cycle, val, chosen_ev = top.cycle, top.val, top.ev_usd
                            chosen_p = learn.probabilities(cycle.symbol, cycle.routes, cfg.mode, with_wallet)
                        else:
                            ladder_says_no = True
                    # Detection -> decision includes the ladder's extra quotes: that time counts too.
                    decided_at = now_ms()
                    prediction = predicted(cycle, val)
                    deps = ExecDeps(
                        rpc=rpc, jup=jup, cfg=cfg, cost_settings=costs, sol_price_usd=sol_price,
                        floor_bps=min(brain.min_profit_bps, cfg.min_profit_bps), tip_account=pick_tip(), jito=jito,
                    )
                    legs = len(cycle.legs)
                    # The scan took seconds; honour a kill switch set meanwhile before sending anything.
                    if trading_disabled(cfg.data_dir):
                        continue
                    # A fresh quote of every leg, plus (to build a real transaction) one swap-instructions call per leg.
                    if not ladder_says_no:
                        await wait_for_jupiter(legs * 2 if simulate_as or is_real_money(cfg.mode) else legs)
                    if ladder_says_no:
                        result = ExecResult("skipped", reason="no trade size had positive expected value at fresh quotes")
                    elif is_real_money(cfg.mode) and wallet:
                        result = await live_execute(cycle, val, wallet, deps)
                    elif simulate_as:
                        result = await simulate_execute(cycle, val, simulate_as, deps)
                    else:
                        result = await quote_only_execute(cycle, val, deps)

                    basis = "realized" if is_real_money(cfg.mode) else "simulated" if result.verified else "quoted"
                    opp = build_opp_record(
                        id=funnel.next_id(decided_at), mode=cfg.mode, cycle=cycle, val=val, result=result,
                        decision_ts=decided_at, detected=bx.cycle,
                        expected={"pSuccess": chosen_p.success, "evUsd": chosen_ev, "assumed": chosen_p.assumed},
                        sol_price_usd=sol_price, ladder=ladder, predicted=prediction,
                    )
                    funnel.record(opp)
                    learn.observe(opp)
                    as_probe = probe_from_opp(opp)
                    if as_probe:
                        gap_predictor.learn(as_probe)
                    last_opp = opp
                    if start_of_utc_day(opp["ts"]) != funnel_day:
                        funnel_day = start_of_utc_day(opp["ts"])
                        funnel_today.clear()
                    count_stage(opp)
                    ledger.append({
                        "ts": now_ms(),
                        "mode": cfg.mode,
                        "symbol": cycle.symbol,
                        "status": result.status,
                        "inUsd": val.in_usd,
                        "netUsd": result.net_usd,
                        "feeUsd": result.fee_usd,
                        "signature": result.signature,
                        "reason": result.reason,
                        "verified": result.verified,
                        "basis": basis,
                        "opportunityId": opp["id"],
                    })
                    brain.observe_trade(cycle.symbol, result.status, result.net_usd, result.verified is True)
                    # A landed trade moved real money: read fresh balances next cycle.
                    if is_real_money(cfg.mode) and result.status in ("filled", "failed") and balance_cache:
                        balance_cache.invalidate()
                    if result.verified and result.status in ("filled", "rejected"):
                        real_bps = result.net_usd / val.in_usd * 10_000 if result.status == "filled" else 0
                        brain.observe_reality(cycle.symbol, val.net_bps, real_bps)
                    # Only checked outcomes count toward loss streaks; quote-only numbers are not results.
                    risk.record_result(result.status, now_ms(), result.net_usd if result.verified else 0)
                    # Something that should not happen with real money (a landing that can't be
                    # confirmed, a loss the on-chain floor should have prevented): stop and ask a person.
                    unexpected = risk.unexpected(result.status, result.net_usd) if is_real_money(cfg.mode) else None
                    if unexpected:
                        tx = f", tx {result.signature}" if result.signature else ""
                        disable_trading(cfg.data_dir, f"{unexpected} ({opp['id']}{tx})")
                        kill_switch_on = True
                        await notify(f"TRADING DISABLED: {unexpected} ({opp['id']}). Check it, then: npm run enable-trading")

                    if is_real_money(cfg.mode):
                        label = f"{result.status.upper()} (real)"
                    elif result.status == "stale":
                        label = "GONE AT RE-QUOTE"
                    elif result.verified:
                        label = f"SIMULATED {'OK' if result.status == 'filled' else result.status.upper()}"
                    else:
                        label = "QUOTE-ONLY (not real profit)"
                    exec_note = f" | fresh re-quote {to_fixed(result.executable.net_bps, 1)}bps" if result.executable else ""
                    line = (
                        f"{opp['id']} {label} {cycle.symbol} ${to_fixed(val.in_usd, 2)}: {basis} net ${to_fixed(result.net_usd, 4)}{exec_note}"
                        + (f" https://solscan.io/tx/{result.signature}" if result.signature else "")
                        + (f" ({result.reason})" if result.reason else "")
                    )
                    if result.status in ("filled", "failed"):
                        await notify(line)
                    else:
                        log.event(line)
                elif cfg.mode == "paper" and cfg.probes:
                    # Probe: re-quote the best positive gap below the bar, to learn whether such gaps
                    # are real. Two quotes, nothing built or sent, never counted as a trade or profit.
                    target = probe_target
                    if target is None:
                        positive = sorted((x for x in scored if x.val.net_bps > cfg.probe_min_bps), key=lambda x: -x.val.net_bps)
                        target = positive[0] if positive else None
                    legs_n = len(target.cycle.legs) if target else 0
                    # The scan kept room for an immediate re-check; without it, skip rather than wait.
                    if target and self.running and budget.available() >= legs_n and probe_budget.allow():
                        try:
                            prediction = predicted(target.cycle, target.val)
                            await wait_for_jupiter(legs_n)
                            fresh = await quote_cycle(jup, spec_of(target.cycle), target.cycle.in_atoms, market_ts=target.cycle.market_ts)
                            fv = value_cycle(fresh, sol_price, costs)
                            rec = {
                                "ts": now_ms(),
                                "symbol": target.cycle.symbol,
                                "kind": target.cycle.kind,
                                "venues": venues_of(target.cycle.routes),
                                "sizeUsd": target.val.in_usd,
                                "quotedBps": target.val.net_bps,
                                "freshBps": fv.net_bps,
                                "ageMs": fresh.quoted_at - target.cycle.quoted_at,
                                "event": target.cycle.market_ts is not None,
                                "predicted": prediction,
                            }
                            probe_log.append(rec)
                            gap_predictor.learn(rec)
                            log.info(
                                f"probe {rec['symbol']}: quoted {to_fixed(rec['quotedBps'], 1)}bps -> {to_fixed(rec['freshBps'], 1)}bps "
                                f"{rec['ageMs']} ms later ({'still there' if held(rec) else 'gone'}; learning only, nothing traded)"
                            )
                        except Exception as err:  # noqa: BLE001
                            if " 429" in str(err):
                                rate_limited = True
                            log.warn(f"probe failed: {str(err)[:120]}")

                # Follow the pools of the most promising tokens the bot may act on.
                if watcher:
                    actable = [s for s in scannable if can_act(safety_of(s, scannable[s]).state, cfg.mode)]
                    try:
                        await watcher.watch([(s, last_pools.get(s, [])) for s in brain.rank_tokens(actable)])
                    except Exception as err:  # noqa: BLE001
                        log.warn(f"pool watching failed: {str(err)[:120]}")

                brain.observe_pace(rate_limited)
                next_wait_ms = brain.next_interval_ms(best[0].val.net_bps if best else None, cfg.scan_interval_ms)
                focus = brain.hot_symbols() if brain.planned_requests() < TOKENS_PER_SCAN * 2 else []
                if rate_limited:
                    next_wait_ms = max(next_wait_ms, RATE_LIMIT_BACKOFF_MS)
                    log.warn(f"Jupiter says too many requests; slowing down (safe pace now {js_str(brain.pace_floor_ms / 1000)}s)")
                elif watcher and watcher.pending(scannable):
                    # A pool changed while this scan ran: don't sleep on it (the request budget
                    # still decides when the quotes can go out).
                    next_wait_ms = cfg.min_scan_interval_ms
                ws_stats = watcher.stats() if watcher else None
                publish(
                    state="scanning",
                    note="Jupiter rate limit: backing off" if rate_limited else None,
                    tradeSizeUsd=size_usd,
                    paceFloorMs=brain.pace_floor_ms,
                    focus=focus,
                    jupiterUsed=budget.used(),
                    jupiterLimit=cfg.jupiter_rpm,
                    scansLastMin=scans_in_last_minute(),
                    funnelToday=dict(funnel_today),
                    lastOpp={
                        "id": last_opp["id"],
                        "symbol": last_opp["symbol"],
                        "stage": last_opp["stage"],
                        "result": last_opp["result"],
                        "totalMs": last_opp["lat"]["totalMs"],
                        "quotedBps": last_opp["quoted"]["netBps"],
                        **({"execBps": last_opp["executable"]["netBps"]} if last_opp.get("executable") else {}),
                    } if last_opp else None,
                    nextScanInMs=next_wait_ms,
                    events={
                        "watching": ws_stats.watching, "eventsToday": ws_stats.events_today, "capped": ws_stats.capped,
                        "tooBusy": ws_stats.too_busy, "cap": cfg.event_daily_cap,
                    } if ws_stats else None,
                    quoteMs=js_round(quote_ms_avg) if quote_ms_avg is not None else None,
                    priceWatch={"tokens": watched_prices, "everyMs": cfg.price_watch_ms} if cfg.price_watch else None,
                    gapPredict={"n": gap_predictor.score.n, "skillPct": gap_predictor.score.skill() * 100, "used": gap_predictor.skilled()},
                    trend=trend.status() if trend else None,
                    lastBest={
                        "symbol": best[0].cycle.symbol,
                        "netBps": best[0].val.net_bps,
                        "expectedBps": brain.expected_net_bps(best[0].cycle.symbol, best[0].val.net_bps),
                        "needBps": brain.min_profit_bps,
                    } if best else None,
                )
                brain.save()
            except _Halt:
                raise
            except Exception as err:  # noqa: BLE001 - one bad cycle must never stop the bot
                log.error("cycle error:", err)
                publish(note=f"last cycle error: {str(err)[:100]}", nextScanInMs=next_wait_ms)
            await self.sleep(next_wait_ms, idle=True)

        brain.save()
        if watcher:
            watcher.unwatch_all()
        if server:
            await server.close()
        publish(state="stopped", note=None, nextScanInMs=0)
        await notify("Stopped.")
        return 0


def main() -> int:
    try:
        cfg = load_config()
    except ValueError as err:
        log.error(f"Refusing to start: {err}")
        return EXIT_REFUSED
    try:
        return asyncio.run(Engine(cfg).run())
    except KeyboardInterrupt:
        return 0
    except Exception as err:  # noqa: BLE001
        log.error(err)
        return 1


if __name__ == "__main__":
    sys.exit(main())
