import asyncio
import base64

import httpx
import pytest

from arbbot.config import USDC_MINT, load_config
from arbbot.costs import CostSettings, value_cycle
from arbbot.cycle import Cycle, triangle_spec, two_leg_spec
from arbbot.executor import (
    ExecDeps,
    failed_leg_of,
    live_execute,
    quote_only_execute,
    send_may_have_reached,
    simulate_execute,
)
from arbbot.jito import JitoError
from arbbot.solana import ed25519
from arbbot.solana.base58 import b58decode
from arbbot.solana.keys import SYSTEM_PROGRAM_ID, Keypair
from arbbot.solana.rpc import RpcError
from arbbot.wallet import usdc_ata

SOL_PRICE = 120
TOKEN = Keypair.generate().public_key
TOKEN_B = Keypair.generate().public_key
DEX = Keypair.generate().public_key
# Fixed 10 000-lamport tip, no buffer: easy fee math.
COSTS = CostSettings(1_000, "jito", 0, 10_000, 10_000, 0, 0)
NETWORK_USD = ((5_000 + 1_000 + 10_000) / 1e9) * SOL_PRICE
CFG = load_config({})
TIP = Keypair.generate().public_key


def run(c):
    return asyncio.run(c)


def quote(inp, out, in_amt, out_amt, threshold=None):
    return {
        "inputMint": inp, "outputMint": out, "inAmount": str(in_amt), "outAmount": str(out_amt),
        "otherAmountThreshold": str(out_amt if threshold is None else threshold), "slippageBps": 0, "priceImpactPct": "0",
        "routePlan": [{"swapInfo": {"label": "Fake", "ammKey": f"pool-{inp[:4]}-{out[:4]}"}}],
    }


def candidate(spec=None):
    """$10 -> ... -> $10.10 (a 1% gap), as the scanner would produce it."""
    spec = spec or two_leg_spec("TKN", TOKEN)
    n = len(spec.path) - 1
    legs = [quote(spec.path[i], spec.path[i + 1], 10_000_000 if i == 0 else 10_100_000, 10_100_000) for i in range(n)]
    c = Cycle(spec.kind, spec.symbol, spec.tokens, spec.path, in_atoms=10_000_000, legs=legs, out_atoms=10_100_000,
              routes="Fake | Fake")
    return c, value_cycle(c, SOL_PRICE, COSTS)


class FakeJup:
    """Every quote returns 10.1 units; records each quote request."""

    def __init__(self, last_leg_threshold=None):
        self.quotes = []
        self.threshold = last_leg_threshold

    async def quote(self, inp, out, amount, slippage_bps, max_accounts=None):
        self.quotes.append((inp, out, slippage_bps))
        o = 10_100_000
        floor = self.threshold if out == USDC_MINT and self.threshold is not None else o * (10_000 - slippage_bps) // 10_000
        return quote(inp, out, amount, o, floor)

    async def swap_instructions(self, q, user):
        ix = {"programId": DEX, "accounts": [{"pubkey": user, "isSigner": True, "isWritable": True},
                                             {"pubkey": Keypair.generate().public_key, "isSigner": False, "isWritable": True}],
              "data": base64.b64encode(bytes([1, 2, 3])).decode()}
        return {"setupInstructions": [], "swapInstruction": ix, "cleanupInstruction": None, "addressLookupTableAddresses": []}


def token_account_data(amount: int) -> str:
    return base64.b64encode(bytes(64) + amount.to_bytes(8, "little") + bytes(93)).decode()


class FakeRpc:
    def __init__(self, usdc_before, usdc_after, lamports_before=0, lamports_after=0, lands=True, sim_err=None,
                 hangs=False, land_err=None, status_errors=0, after_read_fails=False):
        self.__dict__.update(locals())
        self.landed = False
        self.status_calls = 0
        self.simulated = []

    async def get_address_lookup_table(self, key):
        return None

    async def get_latest_blockhash(self):
        return Keypair.generate().public_key, 100

    async def get_token_account_balance(self, address, commitment="processed"):
        return self.usdc_before

    async def simulate_transaction(self, tx, **kw):
        self.simulated.append(kw)
        return {"err": self.sim_err, "accounts": [{"data": [token_account_data(self.usdc_after), "base64"]}]}

    async def get_balance(self, owner):
        return self.lamports_after if self.landed else self.lamports_before

    async def get_parsed_token_accounts_by_owner(self, owner, program_id):
        if self.landed and self.after_read_fails:
            raise RuntimeError("fetch failed")
        amount = str(self.usdc_after if self.landed else self.usdc_before)
        usdc = {"account": {"lamports": 2_039_280, "data": {"parsed": {"info": {"mint": USDC_MINT, "tokenAmount": {"amount": amount}}}}}}
        # After landing, a new token account holds a refundable deposit.
        other = {"account": {"lamports": 2_039_280, "data": {"parsed": {"info": {"mint": TOKEN, "tokenAmount": {"amount": "0"}}}}}}
        return [usdc, other] if self.landed else [usdc]

    async def get_transaction(self, sig):
        return {"meta": {"fee": 6_000}}

    async def get_signature_statuses(self, sigs):
        self.status_calls += 1
        if self.status_errors and self.status_calls <= self.status_errors:
            raise RuntimeError("fetch failed")
        if self.hangs or not self.lands:
            return [None]
        self.landed = True
        return [{"confirmationStatus": "confirmed", "err": self.land_err}]

    async def get_block_height(self):
        return 50 if self.hangs else 101

    async def send_transaction(self, raw, **kw):
        return "rpcsig"


class FakeJito:
    def __init__(self, error=None):
        self.sent = []
        self.error = error

    async def get_tip_accounts(self):
        return [TIP]

    async def send_transaction(self, b64):
        self.sent.append(base64.b64decode(b64))
        if self.error:
            raise self.error
        return "sig123"


async def _no_sleep(_s):
    return None


def deps(rpc, jup, **kw):
    base = dict(rpc=rpc, jup=jup, cfg=CFG, cost_settings=COSTS, sol_price_usd=SOL_PRICE, floor_bps=20, tip_account=TIP,
                sleep=_no_sleep)
    base.update(kw)
    return ExecDeps(**base)


OWNER = Keypair.generate().public_key


# --- paper: on-chain simulation and quote-only ---------------------------------

def test_simulation_reports_what_the_trade_would_make():
    r = run(simulate_execute(*candidate(), OWNER, deps(FakeRpc(20_000_000, 20_100_000), FakeJup())))
    assert r.status == "filled" and r.verified is True
    assert r.net_usd == pytest.approx(0.1 - NETWORK_USD, abs=1e-9)
    assert r.simulated_net_usd == pytest.approx(0.1 - NETWORK_USD, abs=1e-9)
    assert r.executable.net_usd == pytest.approx(0.1 - NETWORK_USD, abs=1e-9)


def test_every_leg_is_requoted_and_only_the_last_carries_the_floor():
    jup = FakeJup()
    run(simulate_execute(*candidate(), OWNER, deps(FakeRpc(20_000_000, 20_100_000), jup)))
    assert [(a, b) for a, b, _ in jup.quotes] == [(USDC_MINT, TOKEN), (TOKEN, USDC_MINT)]
    assert jup.quotes[0][2] == 0 and jup.quotes[1][2] > 0


def test_a_gap_that_would_revert_costs_nothing_and_names_the_leg():
    c, v = candidate()
    r = run(simulate_execute(c, v, OWNER, deps(FakeRpc(1, 1, sim_err={"InstructionError": [2, {"Custom": 6001}]}), FakeJup())))
    assert (r.status, r.net_usd, r.fee_usd, r.verified, r.failed_leg) == ("rejected", 0, 0, True, 1)
    assert "leg 1/2: price moved" in r.reason
    r2 = run(simulate_execute(c, v, OWNER, deps(FakeRpc(1, 1, sim_err={"InstructionError": [3, {"Custom": 6001}]}), FakeJup())))
    assert r2.failed_leg == 2


def test_stale_when_the_gap_is_gone_at_the_fresh_requote():
    r = run(simulate_execute(*candidate(), OWNER, deps(FakeRpc(1, 1), FakeJup(9_000_000))))
    assert r.status == "stale" and "gap gone at fresh re-quote" in r.reason and r.executable is not None


def test_usdc_account_is_a_program_address():
    a = usdc_ata(OWNER)
    assert a == usdc_ata(OWNER) and not ed25519.is_on_curve(b58decode(a))


def test_quote_only_is_labelled_unverified():
    r = run(quote_only_execute(*candidate(), deps(FakeRpc(1, 1), FakeJup())))
    assert r.status == "filled" and r.verified is False
    assert r.executable.net_usd == pytest.approx(0.1 - NETWORK_USD, abs=1e-9)
    assert run(quote_only_execute(*candidate(), deps(FakeRpc(1, 1), FakeJup(9_000_000)))).status == "stale"


# --- micro/live ------------------------------------------------------------------

WALLET = Keypair.generate()


def _programs(raw: bytes):
    from arbbot.solana.tx import encode_length  # noqa: F401

    # Parse just enough of a v0 transaction: signatures, then the message's static keys and instructions.
    i = 0
    nsig = raw[i]; i += 1 + 64 * nsig
    msg = raw[i:]
    sig = raw[1:65]
    j = 4
    nkeys = msg[j]; j += 1
    keys = [msg[j + 32 * k: j + 32 * (k + 1)] for k in range(nkeys)]
    j += 32 * nkeys + 32
    nix = msg[j]; j += 1
    progs = []
    for _ in range(nix):
        progs.append(keys[msg[j]]); j += 1
        na = msg[j]; j += 1 + na
        nd = msg[j]; j += 1 + nd
    from arbbot.solana.base58 import b58encode

    return [b58encode(p) for p in progs], [b58encode(k) for k in keys], sig, msg


def test_sends_one_signed_transaction_and_measures_realized_profit():
    jito = FakeJito()
    # SOL drops by fee + tip + a 0.00204 SOL deposit for the new token account.
    rpc = FakeRpc(20_000_000, 20_100_000, 50_000_000, 50_000_000 - 16_000 - 2_039_280)
    r = run(live_execute(*candidate(), WALLET, deps(rpc, FakeJup(), jito=jito)))
    assert r.status == "filled" and r.signature == "sig123"
    # Only fee (6000) + tip (10000) count; the refundable deposit does not.
    assert r.net_usd == pytest.approx(0.1 - (16_000 / 1e9) * SOL_PRICE, abs=1e-9)
    assert "submitted" in r.t and "landed" in r.t
    progs, keys, sig, msg = _programs(jito.sent[0])
    assert progs.count(DEX) == 2  # both legs, one transaction
    assert progs[-1] == SYSTEM_PROGRAM_ID  # tip is last
    assert TIP in keys
    assert ed25519.verify(b58decode(WALLET.public_key), msg, sig)  # really signed


def test_a_triangle_goes_in_one_transaction():
    jito, jup = FakeJito(), FakeJup()
    rpc = FakeRpc(20_000_000, 20_100_000, 50_000_000, 49_984_000)
    r = run(live_execute(*candidate(triangle_spec(("AAA", TOKEN), ("BBB", TOKEN_B))), WALLET, deps(rpc, jup, jito=jito)))
    assert r.status == "filled" and len(jup.quotes) == 3
    assert _programs(jito.sent[0])[0].count(DEX) == 3


def test_never_sends_when_the_free_simulation_says_revert():
    jito = FakeJito()
    r = run(live_execute(*candidate(), WALLET, deps(FakeRpc(1, 1, sim_err="boom", lands=False), FakeJup(), jito=jito)))
    assert r.status == "rejected" and jito.sent == []


def test_costs_nothing_when_jito_drops_it():
    r = run(live_execute(*candidate(), WALLET, deps(FakeRpc(1, 1, lands=False), FakeJup(), jito=FakeJito())))
    assert (r.status, r.net_usd, r.fee_usd, r.reason) == ("rejected", 0, 0, "did not land (no fee paid)")


def test_a_landed_failure_reports_its_fee_and_leg():
    rpc = FakeRpc(20_000_000, 20_000_000, 50_000_000, 49_984_000, land_err={"InstructionError": [3, {"Custom": 6001}]})
    r = run(live_execute(*candidate(), WALLET, deps(rpc, FakeJup(), jito=FakeJito())))
    assert (r.status, r.failed_leg, r.verified) == ("failed", 2, True)
    assert r.net_usd == pytest.approx(-(16_000 / 1e9) * SOL_PRICE, abs=1e-9)


def test_times_out_instead_of_hanging():
    clock = [0]

    def now():
        clock[0] += 10_000
        return clock[0]

    cfg = load_config({"LANDING_TIMEOUT_MS": "5000"})
    r = run(live_execute(*candidate(), WALLET, deps(FakeRpc(1, 1, lands=False, hangs=True), FakeJup(), jito=FakeJito(), cfg=cfg, now=now)))
    assert r.status == "timeout" and "could not confirm" in r.reason


def test_watches_a_send_that_got_no_answer_and_records_it_if_it_lands():
    jito = FakeJito(error=httpx.ReadTimeout("timed out"))
    rpc = FakeRpc(20_000_000, 20_100_000, 50_000_000, 49_984_000)
    r = run(live_execute(*candidate(), WALLET, deps(rpc, FakeJup(), jito=jito)))
    assert r.status == "filled"
    from arbbot.solana.base58 import b58encode

    assert r.signature == b58encode(jito.sent[0][1:65])  # known before sending


def test_gives_up_at_once_when_the_send_was_clearly_refused():
    rpc = FakeRpc(1, 1)
    r = run(live_execute(*candidate(), WALLET, deps(rpc, FakeJup(), jito=FakeJito(JitoError("Jito sendTransaction 429: rate limited")))))
    assert r.status == "rejected" and r.reason == "send refused: Jito sendTransaction 429: rate limited"
    assert rpc.status_calls == 0


def test_rides_out_an_rpc_hiccup_while_waiting_for_landing():
    rpc = FakeRpc(20_000_000, 20_100_000, 50_000_000, 49_984_000, status_errors=1)
    assert run(live_execute(*candidate(), WALLET, deps(rpc, FakeJup(), jito=FakeJito()))).status == "filled"


def test_a_landed_trade_with_an_unreadable_result_is_unknown():
    rpc = FakeRpc(20_000_000, 20_100_000, 50_000_000, 49_984_000, after_read_fails=True)
    r = run(live_execute(*candidate(), WALLET, deps(rpc, FakeJup(), jito=FakeJito())))
    assert r.status == "timeout" and "landed, but its result could not be read" in r.reason


def test_refused_vs_maybe_reached_sends():
    assert not send_may_have_reached(JitoError("Jito sendTransaction 429: x"))
    assert not send_may_have_reached(RpcError("sendTransaction", -32002, "bad"))
    assert send_may_have_reached(httpx.ReadTimeout("t"))
    assert send_may_have_reached(httpx.ConnectError("reset"))


def test_refuses_jito_without_a_tip_account_and_can_send_via_rpc():
    r = run(live_execute(*candidate(), WALLET, deps(FakeRpc(1, 1), FakeJup(), jito=FakeJito(), tip_account=None)))
    assert (r.status, r.reason) == ("skipped", "Jito not available")
    cfg = load_config({"SEND_VIA": "rpc"})
    rpc = FakeRpc(20_000_000, 20_100_000, 50_000_000, 49_984_000)
    r2 = run(live_execute(*candidate(), WALLET, deps(rpc, FakeJup(), cfg=cfg, cost_settings=CostSettings(10_000, "rpc", 0, 0, 0, 0, 0))))
    assert r2.status == "filled" and r2.signature == "rpcsig"


def test_failing_leg_attribution():
    ranges = [(2, 4), (5, 6)]
    assert failed_leg_of({"InstructionError": [3, {}]}, ranges) == 1
    assert failed_leg_of({"InstructionError": [6, {}]}, ranges) == 2
    assert failed_leg_of({"InstructionError": [0, {}]}, ranges) == 0
    assert failed_leg_of("BlockhashNotFound", ranges) is None
