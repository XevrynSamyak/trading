"""`check`: confirms RPC, Jupiter and wallet work before starting the bot."""

import asyncio
import os
import re

from .atomic import read_json_with_backup
from .config import is_real_money, max_scans_per_min
from .gate import GateThresholds, go_live_verdict, load_gate_input
from .killswitch import halted, trading_disabled
from .secret_checks import check_secrets
from .server import ServerOptions, check_server_options
from .tokensafety import SafetyThresholds, TokenSafety
from .util import js_round, js_str, to_fixed

MIN_SOL_FOR_FEES = 0.01


def mask_url(url: str) -> str:
    def hide(m: re.Match) -> str:
        k, v = m.group(1), m.group(2)
        return f"{k}{v[:4]}…{v[-4:]}" if len(v) > 8 else f"{k}****"

    return re.sub(r"(api[-_]?key=)([^&]+)", hide, url, count=1, flags=re.IGNORECASE)


def limits_line(cfg) -> str:
    """The loss-side limits in one line (there is no profit cap)."""
    caps = [f"{js_round(cfg.trade_size_pct * 100)}% of the {getattr(cfg, 'base_token', 'USDC')} on hand"]
    if cfg.max_trade_usd > 0:
        caps.append(f"${js_str(cfg.max_trade_usd)} (MAX_TRADE_USD)")
    if cfg.mode == "micro":
        caps.append(f"${js_str(cfg.micro_max_trade_usd)} (MICRO cap)")
    return (
        f"per trade at most {', '.join(caps)}; stops for good at ${js_str(cfg.loss_floor_usd)}, "
        f"pauses for the day after -${js_str(cfg.daily_loss_limit_usd)}; no profit cap"
    )


async def _step(name: str, fn) -> bool:
    try:
        print(f"OK    {name}: {await fn()}")
        return True
    except Exception as err:  # noqa: BLE001 - every failure becomes one clear line
        print(f"FAIL  {name}: {str(err)[:200]}")
        return False


async def _main(cfg) -> bool:
    from .http import make_client
    from .jito import JitoClient
    from .jupiter import JupiterClient
    from .scanner import fetch_sol_price_usd
    from .solana.rpc import Rpc
    from .solana.ws import RpcWebSocket, ws_url_from
    from .wallet import get_balances, load_keypair, wallet_value_usd

    print(f"Mode: {cfg.mode}{'  (REAL MONEY)' if is_real_money(cfg.mode) else '  (nothing is ever sent)'}, trading in {cfg.base_token}")
    print(f"RPC:  {mask_url(cfg.rpc_url)}\n")

    secrets = check_secrets(dict(os.environ), cfg.mode, ".env")
    for e in secrets.errors:
        print(f"FAIL  Settings: {e}")
    for w in secrets.warnings:
        print(f"WARN  Settings: {w}")
    if not secrets.errors:
        print("OK    Settings: no secrets in the wrong place")

    async with make_client() as http:
        rpc = Rpc(cfg.rpc_url, http)
        jup = JupiterClient(cfg.jupiter_api, http, cfg.jupiter_api_key)
        sol_price = 0.0

        async def rpc_step():
            slot, version = await asyncio.gather(rpc.get_slot(), rpc.get_version())
            return f"slot {slot}, solana-core {version.get('solana-core')}"

        async def jupiter_step():
            nonlocal sol_price
            try:
                sol_price = await fetch_sol_price_usd(jup, cfg.base_mint)
            except Exception as err:
                if cfg.jupiter_api_key and re.search(r"Jupiter quote (401|403)", str(err)):
                    raise RuntimeError(
                        "Jupiter rejected your API key: check JUPITER_API_KEY in .env (copy it again from the portal)"
                    ) from None
                raise
            key_note = "with your API key" if cfg.jupiter_api_key else "no API key"
            return (
                f"SOL = ${to_fixed(sol_price, 2)} ({key_note}: {cfg.jupiter_rpm} requests/min, "
                f"up to ~{to_fixed(max_scans_per_min(cfg.jupiter_ms_per_request), 1)} full scans/min)"
            )

        results = [await _step("RPC", rpc_step), await _step("Jupiter", jupiter_step)]

        owner = cfg.wallet_public_key or (load_keypair(cfg.signing_key).public_key if cfg.signing_key else None)
        if owner:
            async def wallet_step():
                b = await get_balances(rpc, owner, cfg.base_mint)
                sol, base = b.lamports / 1e9, b.base_atoms / 1e6
                other = "USDT" if cfg.base_token == "USDC" else "USDC"
                if sol < MIN_SOL_FOR_FEES:
                    warn = " (WARNING: add some SOL, it pays the network fees)"
                elif base < 1:
                    warn = f" (WARNING: add {cfg.base_token}, the bot trades with it"
                    warn += f"; or set BASE_TOKEN={other} to trade the {other} you hold)" if b.other_stable_atoms >= 1e6 else ")"
                elif cfg.mode == "paper":
                    warn = " -> paper trades will be tested on-chain"
                else:
                    warn = ""
                held = f", {other} {to_fixed(b.other_stable_atoms / 1e6, 2)} (not traded)" if b.other_stable_atoms else ""
                total = f", total ~${to_fixed(wallet_value_usd(b, sol_price), 2)}" if sol_price else ""
                return f"{owner}  SOL {to_fixed(sol, 4)}, {cfg.base_token} {to_fixed(base, 2)}{held}{total}{warn}"

            results.append(await _step("Wallet", wallet_step))
        else:
            print("SKIP  Wallet: none set (add WALLET_PUBLIC_KEY for realistic on-chain paper testing)")

        if is_real_money(cfg.mode) and cfg.send_via == "jito":
            async def jito_step():
                return f"{len(await JitoClient(cfg.jito_url, http).get_tip_accounts())} tip accounts"

            results.append(await _step("Jito", jito_step))

        print(f"INFO  Limits: {limits_line(cfg)}")

        async def data_step():
            os.makedirs(cfg.data_dir, exist_ok=True)
            probe = os.path.join(cfg.data_dir, ".write-test")
            with open(probe, "w") as f:
                f.write("ok")
            os.remove(probe)
            return f"{cfg.data_dir} is writable"

        results.append(await _step("Data folder", data_step))

        stop = halted(cfg.data_dir)
        if stop:
            print(f"FAIL  Halted: {stop} (read it, then delete {os.path.join(cfg.data_dir, 'HALTED')} to allow a start)")
            results.append(False)
        kill = trading_disabled(cfg.data_dir)
        if kill:
            print(f"WARN  Trading is disabled: {kill} (the bot will wait; re-enable after checking: npm run enable-trading)")

        # The go-live gate, as the bot itself will apply it at startup.
        verdict = go_live_verdict(load_gate_input(cfg.data_dir), GateThresholds.from_config(cfg))
        if cfg.mode == "live":
            if verdict.live.ok:
                print("OK    Go-live gate: LIVE allowed by the MICRO results")
            else:
                print(f"FAIL  Go-live gate: LIVE will be refused: {'; '.join(verdict.live.reasons)}")
                results.append(False)
        else:
            print(
                f"INFO  Go-live gate: MICRO {'YES' if verdict.micro.ok else 'NO'}, LIVE {'YES' if verdict.live.ok else 'NO'}"
                + ("" if verdict.micro.ok else f" ({verdict.micro.reasons[0]})")
            )

        # Token safety, checked on-chain now (the bot re-checks daily).
        brain = read_json_with_backup(os.path.join(cfg.data_dir, f"brain-{cfg.mode}.json"))
        discovered = (brain[0].get("discovered") or {}) if brain and isinstance(brain[0], dict) else {}
        pool = {**discovered, **cfg.tokens}
        safety = TokenSafety(os.path.join(cfg.data_dir, "token-safety.json"), cfg.live_tokens,
                             SafetyThresholds.from_config(cfg), recheck_ms=0)

        async def safety_step():
            await safety.refresh(rpc, pool)
            lines = []
            for sym, mint in pool.items():
                v = safety.verdict(sym, mint, sym in cfg.tokens)
                lines.append(f"\n        {sym.ljust(10)} {v.state.ljust(13)} {'; '.join(v.reasons)}".rstrip())
            return f"{len(pool)} tokens checked on-chain{''.join(lines)}"

        results.append(await _step("Token safety", safety_step))

        if cfg.event_triggers:
            async def ws_step():
                ws = RpcWebSocket(cfg.rpc_ws_url or ws_url_from(cfg.rpc_url), backoff_max_s=5)
                seen = {"n": 0}
                try:
                    ws.slot_subscribe(lambda _slot: seen.__setitem__("n", seen["n"] + 1))
                    await asyncio.sleep(3)
                finally:
                    await ws.close()
                if not seen["n"]:
                    raise RuntimeError("no new-block notices in 3s: event triggers won't work (set RPC_WS_URL, or EVENT_TRIGGERS=off)")
                return f"{seen['n']} new-block notices in 3s (event triggers can work)"

            results.append(await _step("WebSocket", ws_step))

    if cfg.status_http_port is not None:
        problem = check_server_options(ServerOptions(cfg.status_http_host, cfg.status_http_port, cfg.status_http_token))
        if problem:
            print(f"FAIL  Status page: {problem}")
            results.append(False)
        else:
            print(f"OK    Status page: http://{cfg.status_http_host}:{cfg.status_http_port}/{' (needs ?token=)' if cfg.status_http_token else ''}")

    ok = all(results) and not secrets.errors
    print("\nAll good. Start the bot." if ok else "\nFix the FAIL lines above before starting the bot.")
    return ok


def main(load_cfg) -> int:
    return 0 if asyncio.run(_main(load_cfg())) else 1
