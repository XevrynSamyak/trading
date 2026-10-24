"""
From a candidate to a result.

Statuses:
  filled   - the trade happened (micro/live), would have succeeded on-chain
             (simulated), or the fresh re-quote still showed the gap (quote-only)
  stale    - the gap was already gone when every leg was re-quoted moments
             later; nothing was built or sent
  rejected - it would have reverted (simulation) or was dropped without
             landing; cost nothing
  skipped  - the bot chose not to try (route too large, Jito unavailable, ...)
  failed   - it landed on-chain and failed, paying the network fee
  timeout  - the outcome can't be confirmed; trading is disabled until checked
"""

import asyncio
import base64
import json
import time
from dataclasses import dataclass, field, replace
from typing import Any, Callable

import httpx

from .costs import Costs, CostSettings, Valuation, revalue
from .cycle import Cycle, quote_cycle, spec_of
from .jito import JitoError
from .profit import BASE_FEE_LAMPORTS, lamports_to_usd, required_out_atoms, slippage_for_floor, usdc_atoms_to_usd
from .solana.keys import Keypair
from .solana.rpc import RpcError
from .solana.tx import AccountMeta, Instruction, MessageV0, VersionedTransaction, set_compute_unit_limit, set_compute_unit_price, transfer
from .wallet import get_balances, token_amount_from_data, usdc_ata


@dataclass
class ExecResult:
    status: str
    #: Net USD on this mode's basis: quoted (quote-only), simulated (paper) or realized (micro/live).
    net_usd: float = 0.0
    fee_usd: float = 0.0
    signature: str | None = None
    reason: str | None = None
    #: True if checked against the real chain (on-chain simulation or a real transaction).
    verified: bool | None = None
    #: The fresh re-quote of every leg right before building (the "executable" stage).
    executable: Valuation | None = None
    #: What the on-chain simulation said the trade would make.
    simulated_net_usd: float | None = None
    #: Which leg made it fail: 1..N, or 0 for a non-swap instruction.
    failed_leg: int | None = None
    tip_lamports: int | None = None
    #: Timings: requoteStart, requoteEnd, built, submitted, landed, confirmed (ms).
    t: dict = field(default_factory=dict)


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class ExecDeps:
    rpc: Any
    jup: Any
    cfg: Any
    cost_settings: CostSettings
    sol_price_usd: float
    #: Minimum net edge (bps) the on-chain floor must guarantee on top of network costs.
    floor_bps: float
    #: Jito tip account; required for real trades sent via Jito.
    tip_account: str | None = None
    jito: Any = None
    now: Callable[[], int] = _now_ms
    sleep: Callable[[float], Any] = asyncio.sleep


@dataclass
class FloorPlan:
    #: Minimum USDC (atoms) the last leg must return on-chain: input + network costs + min profit.
    required: int
    #: Slippage on the last leg's quote that puts its on-chain minimum at (or above) `required`.
    slippage_bps: int


def plan_floor(candidate: Cycle, costs: Costs, floor_bps: float, max_slippage_bps: int) -> FloorPlan | None:
    required = required_out_atoms(candidate.in_atoms, costs.network_usd, floor_bps)
    slip = slippage_for_floor(candidate.out_atoms, required)
    if slip is None:
        return None
    return FloorPlan(required, min(slip, max_slippage_bps))


async def fresh_quote(candidate: Cycle, costs: Costs, plan: FloorPlan, deps: ExecDeps, t: dict):
    """
    Executable stage: re-quotes EVERY leg back-to-back right before building.
    The last leg carries the profit floor; if its fresh on-chain minimum is below
    what's required, the gap is gone and nothing is built.
    """
    t["requoteStart"] = deps.now()
    cycle = await quote_cycle(deps.jup, spec_of(candidate), candidate.in_atoms, last_leg_slippage_bps=plan.slippage_bps,
                              market_ts=candidate.market_ts, now=deps.now)
    t["requoteEnd"] = deps.now()
    val = revalue(cycle, costs)
    if int(cycle.legs[-1]["otherAmountThreshold"]) < plan.required:
        return ExecResult("stale", t=t, executable=val, reason=f"gap gone at fresh re-quote (executable {val.net_bps:.1f}bps)")
    return cycle, val


def _to_instruction(ix: dict) -> Instruction:
    return Instruction(
        ix["programId"],
        [AccountMeta(a["pubkey"], a["isSigner"], a["isWritable"]) for a in ix["accounts"]],
        base64.b64decode(ix["data"]),
    )


@dataclass
class BuiltTx:
    tx: VersionedTransaction
    blockhash: str
    last_valid_block_height: int
    #: Instruction index range [first, last] of each leg, for blaming the failing leg.
    leg_ranges: list[tuple[int, int]]


async def build_cycle_tx(cycle: Cycle, owner: str, costs: Costs, deps: ExecDeps):
    """ONE transaction: compute budget, every leg's setup + swap (+ the last leg's cleanup), then the Jito tip."""
    sets = await asyncio.gather(*(deps.jup.swap_instructions(q, owner) for q in cycle.legs))
    micro_per_cu = (deps.cost_settings.priority_fee_lamports * 1_000_000) // deps.cfg.compute_unit_limit
    ixs = [set_compute_unit_limit(deps.cfg.compute_unit_limit), set_compute_unit_price(micro_per_cu)]
    ranges: list[tuple[int, int]] = []
    for i, s in enumerate(sets):
        start = len(ixs)
        ixs += [_to_instruction(x) for x in s.get("setupInstructions") or []]
        ixs.append(_to_instruction(s["swapInstruction"]))
        if i == len(sets) - 1 and s.get("cleanupInstruction"):
            ixs.append(_to_instruction(s["cleanupInstruction"]))
        ranges.append((start, len(ixs) - 1))
    if deps.tip_account and deps.cost_settings.send_via == "jito" and costs.tip_lamports > 0:
        ixs.append(transfer(owner, deps.tip_account, costs.tip_lamports))

    keys = list(dict.fromkeys(a for s in sets for a in s.get("addressLookupTableAddresses") or []))
    tables = [t for t in await asyncio.gather(*(deps.rpc.get_address_lookup_table(k) for k in keys)) if t is not None]
    blockhash, last_valid = await deps.rpc.get_latest_blockhash()
    try:
        tx = VersionedTransaction(MessageV0.compile(owner, ixs, blockhash, tables))
        tx.serialize()
    except ValueError:
        return ExecResult("skipped", reason="route too large for one transaction")
    return BuiltTx(tx, blockhash, last_valid, ranges)


def failed_leg_of(err, ranges: list[tuple[int, int]]) -> int | None:
    """Which leg an on-chain error came from: 1..N, 0 for a non-swap instruction, None if unknown."""
    ie = err.get("InstructionError") if isinstance(err, dict) else None
    if not isinstance(ie, list) or not ie:
        return None
    idx = ie[0]
    for i, (a, b) in enumerate(ranges):
        if a <= idx <= b:
            return i + 1
    return 0


def _short_err(e) -> str:
    return (e if isinstance(e, str) else json.dumps(e, separators=(",", ":")))[:160]


def _leg_note(leg: int | None, n: int) -> str:
    if leg is None:
        return ""
    if leg == 0:
        return " [non-swap instruction]"
    return f" [leg {leg}/{n}{': price moved before we landed' if leg == 1 else ''}]"


async def _prepare(candidate: Cycle, val: Valuation, deps: ExecDeps, t: dict):
    """Shared start of every execution path: costs, floor, fresh re-quote of all legs."""
    plan = plan_floor(candidate, val.costs, deps.floor_bps, deps.cfg.max_slippage_bps)
    if plan is None:
        return ExecResult("skipped", t=t, reason="below profit floor")
    fresh = await fresh_quote(candidate, val.costs, plan, deps, t)
    if isinstance(fresh, ExecResult):
        return fresh
    return plan, fresh[0], fresh[1]


async def quote_only_execute(candidate: Cycle, val: Valuation, deps: ExecDeps) -> ExecResult:
    """Paper mode without a wallet: re-quotes every leg fresh; nothing is built or sent. Amounts are QUOTED."""
    t: dict = {}
    prep = await _prepare(candidate, val, deps, t)
    if isinstance(prep, ExecResult):
        return prep
    _, _, fv = prep
    return ExecResult("filled", fv.net_usd, fv.costs.network_usd, executable=fv, tip_lamports=fv.costs.tip_lamports,
                      verified=False, reason="quote-only: not checked on-chain", t=t)


async def simulate_execute(candidate: Cycle, val: Valuation, owner: str, deps: ExecDeps) -> ExecResult:
    """
    Paper mode with a public address: builds the exact transaction real mode would
    send and simulates it against the real chain. Nothing is signed or sent.
    Amounts are SIMULATED.
    """
    t: dict = {}
    prep = await _prepare(candidate, val, deps, t)
    if isinstance(prep, ExecResult):
        return prep
    _, cycle, fv = prep
    built = await build_cycle_tx(cycle, owner, fv.costs, deps)
    if isinstance(built, ExecResult):
        return replace(built, t=t, executable=fv)
    t["built"] = deps.now()
    ata = usdc_ata(owner)
    try:
        pre = await deps.rpc.get_token_account_balance(ata, "processed")
    except Exception:
        return ExecResult("skipped", t=t, executable=fv, reason="wallet has no USDC account to simulate with")
    sim = await deps.rpc.simulate_transaction(built.tx.serialize(), replace_recent_blockhash=True, commitment="processed",
                                              account_addresses=[ata])
    if sim.get("err"):
        leg = failed_leg_of(sim["err"], built.leg_ranges)
        return ExecResult("rejected", t=t, executable=fv, failed_leg=leg, verified=True,
                          reason=f"would revert: {_short_err(sim['err'])}{_leg_note(leg, len(cycle.legs))}")
    accounts = sim.get("accounts") or []
    if not accounts or not accounts[0]:
        return ExecResult("skipped", t=t, executable=fv, reason="simulation returned no balance")
    post = token_amount_from_data(base64.b64decode(accounts[0]["data"][0]))
    net = usdc_atoms_to_usd(post - pre) - fv.costs.network_usd
    return ExecResult("filled", net, fv.costs.network_usd, executable=fv, simulated_net_usd=net,
                      tip_lamports=fv.costs.tip_lamports, verified=True, reason="simulated on-chain", t=t)


async def _wait_for_landing(deps: ExecDeps, signature: str, last_valid: int) -> dict:
    """Until the transaction lands, its blockhash expires (it can then never land), or the timeout."""
    start = deps.now()
    while True:
        try:
            st = (await deps.rpc.get_signature_statuses([signature]))[0]
            if st and st.get("confirmationStatus") in ("confirmed", "finalized"):
                return {"landed": True, "err": st.get("err")}
            if await deps.rpc.get_block_height() > last_valid:
                return {"landed": False}
        except Exception:
            pass  # an RPC hiccup must not lose track of a sent transaction: keep asking until the timeout
        if deps.now() - start > deps.cfg.landing_timeout_ms:
            return {"landed": False, "timed_out": True}
        await deps.sleep(1.0)


def send_may_have_reached(err: BaseException) -> bool:
    """
    After a send error, could the transaction still have reached the network?
    A service that answered with an error refused it; no answer at all (timeout,
    connection reset) means it may have arrived and can still land.
    """
    if isinstance(err, (RpcError, JitoError)):
        return False
    if isinstance(err, httpx.HTTPStatusError):
        return False
    return True


async def _read_with_retry(fn, deps: ExecDeps, attempts: int = 3):
    """Retries a read a few times (RPC hiccups), so a landed trade's result isn't lost."""
    for i in range(1, attempts + 1):
        try:
            return await fn()
        except Exception:
            if i >= attempts:
                raise
            await deps.sleep(1.0)


async def live_execute(candidate: Cycle, val: Valuation, wallet: Keypair, deps: ExecDeps) -> ExecResult:
    t: dict = {}
    cfg = deps.cfg
    if cfg.send_via == "jito" and (not deps.jito or not deps.tip_account):
        return ExecResult("skipped", t=t, reason="Jito not available")
    prep = await _prepare(candidate, val, deps, t)
    if isinstance(prep, ExecResult):
        return prep
    _, cycle, fv = prep
    built = await build_cycle_tx(cycle, wallet.public_key, fv.costs, deps)
    if isinstance(built, ExecResult):
        return replace(built, t=t, executable=fv)
    built.tx.sign([wallet])
    t["built"] = deps.now()
    n = len(cycle.legs)
    raw = built.tx.serialize()

    sim = await deps.rpc.simulate_transaction(raw, commitment="processed")
    if sim.get("err"):
        leg = failed_leg_of(sim["err"], built.leg_ranges)
        return ExecResult("rejected", t=t, executable=fv, failed_leg=leg, verified=True,
                          reason=f"would revert: {_short_err(sim['err'])}{_leg_note(leg, n)}")

    before = await get_balances(deps.rpc, wallet.public_key)
    # The signature is known before sending, so landing can be checked even if the send call fails.
    signature = built.tx.signature
    send_error = None
    try:
        if cfg.send_via == "jito":
            signature = await deps.jito.send_transaction(base64.b64encode(raw).decode())
        else:
            signature = await deps.rpc.send_transaction(raw, skip_preflight=True, max_retries=2)
    except Exception as err:  # noqa: BLE001
        send_error = str(err)[:160]
        if not send_may_have_reached(err):
            return ExecResult("rejected", t=t, executable=fv, reason=f"send refused: {send_error}")
        # No answer: it may still land. Watch for it like any sent transaction.
    t["submitted"] = deps.now()

    landing = await _wait_for_landing(deps, signature, built.last_valid_block_height)
    if landing.get("timed_out"):
        return ExecResult("timeout", t=t, signature=signature, executable=fv,
                          reason=f"could not confirm within {round(cfg.landing_timeout_ms / 1000)}s; check https://solscan.io/tx/{signature}")
    if not landing["landed"]:
        why = f"send got no answer ({send_error}) and it never landed (no fee paid)" if send_error else "did not land (no fee paid)"
        return ExecResult("rejected", t=t, signature=signature, executable=fv, verified=True, reason=why)
    t["landed"] = deps.now()

    try:
        after = await _read_with_retry(lambda: get_balances(deps.rpc, wallet.public_key), deps)
        # Fee from the transaction itself (+ tip). A balance diff would wrongly count the
        # refundable deposit for a newly opened token account as a loss.
        info = await _read_with_retry(lambda: deps.rpc.get_transaction(signature), deps)
    except Exception as err:  # noqa: BLE001
        # It landed but its result can't be read: unknown, so trading stops until a person checks.
        return ExecResult("timeout", t=t, signature=signature, executable=fv,
                          reason=f"landed, but its result could not be read ({str(err)[:80]}); check https://solscan.io/tx/{signature}")
    t["confirmed"] = deps.now()
    fee = ((info or {}).get("meta") or {}).get("fee")
    network = (fee if fee is not None else BASE_FEE_LAMPORTS + deps.cost_settings.priority_fee_lamports) + (
        fv.costs.tip_lamports if cfg.send_via == "jito" else 0
    )
    fee_usd = lamports_to_usd(network, deps.sol_price_usd)
    net = usdc_atoms_to_usd(after.usdc_atoms - before.usdc_atoms) - fee_usd
    if landing.get("err"):
        leg = failed_leg_of(landing["err"], built.leg_ranges)
        return ExecResult("failed", net, fee_usd, signature=signature, executable=fv, failed_leg=leg, verified=True,
                          tip_lamports=fv.costs.tip_lamports, reason=f"{_short_err(landing['err'])}{_leg_note(leg, n)}", t=t)
    return ExecResult("filled", net, fee_usd, signature=signature, executable=fv, tip_lamports=fv.costs.tip_lamports,
                      verified=True, t=t)
