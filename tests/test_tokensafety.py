import asyncio
from datetime import datetime, timezone

import pytest

from arbbot.solana.keys import Keypair
from arbbot.tokensafety import SafetyThresholds, SafetyVerdict, TokenSafety, can_act, can_scan, classify_token, parse_mint_account

NOW = int(datetime(2026, 10, 5, 12, tzinfo=timezone.utc).timestamp() * 1000)
DAY = 86_400_000
T = SafetyThresholds(1_000_000, 1_000, 7, 60)
CLEAN = {"program": "spl-token", "mintAuthority": None, "freezeAuthority": None, "extensions": []}


def mint_account(program, **info):
    return {"executable": False, "lamports": 1_461_600, "owner": "x",
            "data": {"program": program, "parsed": {"type": "mint", "info": {"decimals": 6, "supply": "1000", "isInitialized": True, **info}}, "space": 82}}


def ext(extension, **state):
    return {"extension": extension, "state": state}


def verdict(**o):
    args = dict(configured=False, allowlisted=False, chain=CLEAN, now=NOW, t=T)
    args.update(o)
    return classify_token(**args)


def test_reads_authorities_and_extensions():
    assert parse_mint_account(None)["program"] == "missing"
    assert parse_mint_account({"data": ["AAAA", "base64"]})["program"] == "other"
    assert parse_mint_account(mint_account("spl-token", mintAuthority="MintAuth", freezeAuthority=None)) == {
        "program": "spl-token", "mintAuthority": "MintAuth", "freezeAuthority": None, "decimals": 6, "extensions": [],
    }
    t22 = parse_mint_account(mint_account("spl-token-2022", mintAuthority=None, freezeAuthority="Freezer", extensions=[
        ext("transferFeeConfig", olderTransferFee={"transferFeeBasisPoints": 0}, newerTransferFee={"transferFeeBasisPoints": 50}),
        ext("transferHook", authority="A", programId="HookProgram"),
        ext("permanentDelegate", delegate="Delegate"),
        ext("defaultAccountState", accountState="frozen"),
        ext("pausableConfig", authority="P", paused=False),
        ext("metadataPointer", metadataAddress="M"),
    ]))
    assert t22["freezeAuthority"] == "Freezer" and t22["transferFeeBps"] == 50 and t22["transferHookProgram"] == "HookProgram"
    assert t22["permanentDelegate"] == "Delegate" and t22["defaultFrozen"] is True and t22["paused"] is False
    assert t22["extensions"] == ["transferFeeConfig", "transferHook", "permanentDelegate", "defaultAccountState", "pausableConfig", "metadataPointer"]
    unset = parse_mint_account(mint_account("spl-token-2022", extensions=[ext("transferHook", programId=None), ext("permanentDelegate", delegate=None)]))
    assert verdict(chain=unset).state == "PAPER_ONLY"


@pytest.mark.parametrize("facts,why", [
    ({"program": "missing"}, "not found"),
    ({"program": "other"}, "not an SPL token"),
    ({"program": "spl-token-2022", "transferFeeBps": 25, "extensions": ["transferFeeConfig"]}, "25bps fee on every transfer"),
    ({"program": "spl-token-2022", "transferHookProgram": "X", "extensions": ["transferHook"]}, "transfer hook"),
    ({"program": "spl-token-2022", "permanentDelegate": "X", "extensions": ["permanentDelegate"]}, "permanent delegate"),
    ({"program": "spl-token-2022", "defaultFrozen": True, "extensions": ["defaultAccountState"]}, "start frozen"),
    ({"program": "spl-token-2022", "paused": True, "extensions": ["pausableConfig"]}, "paused"),
    ({"program": "spl-token-2022", "extensions": ["nonTransferable"]}, "non-transferable"),
    ({"program": "spl-token-2022", "extensions": ["unparseableExtension"]}, "could not read"),
])
def test_blocks_misbehaving_tokens_even_configured(facts, why):
    for configured in (True, False):
        v = verdict(configured=configured, chain={**CLEAN, **facts})
        assert v.state == "BLOCKED"
        assert why in ",".join(v.reasons)


def test_trusts_configured_tokens_once_checked():
    assert verdict(configured=True) == SafetyVerdict("LIVE_ALLOWED", [])
    assert verdict(configured=True, chain={**CLEAN, "freezeAuthority": "F"}) == SafetyVerdict("LIVE_ALLOWED", ["note: issuer can freeze token accounts"])
    assert verdict(configured=True, chain=None) == SafetyVerdict("PAPER_ONLY", ["not checked on-chain yet"])


@pytest.mark.parametrize("market,facts,why", [
    (None, {"mintAuthority": "M"}, "can mint more"),
    (None, {"freezeAuthority": "F"}, "can freeze"),
    (None, {"program": "spl-token-2022", "extensions": ["pausableConfig"], "paused": False}, "can pause"),
    (None, {"program": "spl-token-2022", "extensions": ["someNewExtension"]}, "unfamiliar token extension(s): someNewExtension"),
    ({"liquidityUsd": 250_000}, {}, "liquidity $250,000 < $1,000,000"),
    ({"holders": 300}, {}, "only 300 holders (want 1000+)"),
    ({"poolCreatedAt": NOW - 2 * DAY}, {}, "first pool only 2.0 days old (want 7+)"),
    ({"topHoldersPct": 85}, {}, "top holders own 85% (want ≤ 60%)"),
])
def test_watches_weak_discovered_tokens(market, facts, why):
    v = verdict(allowlisted=True, market=market, chain={**CLEAN, **facts})
    assert v.state == "WATCH"
    assert why in ",".join(v.reasons)


def test_discovered_token_states():
    assert verdict(chain=None).state == "WATCH"
    assert verdict() == SafetyVerdict("PAPER_ONLY", ["discovered: real trades need it in LIVE_TOKENS"])
    assert verdict(allowlisted=True).state == "LIVE_ALLOWED"
    healthy = {"liquidityUsd": 5e6, "holders": 20_000, "poolCreatedAt": NOW - 400 * DAY, "topHoldersPct": 20}
    assert verdict(market=healthy).state == "PAPER_ONLY"


def test_modes():
    assert not can_scan("BLOCKED", "paper")
    assert can_scan("WATCH", "paper")
    assert not can_act("WATCH", "paper")
    assert can_act("PAPER_ONLY", "paper")
    for mode in ("micro", "live"):
        assert not can_scan("PAPER_ONLY", mode) and not can_act("PAPER_ONLY", mode)
        assert can_scan("LIVE_ALLOWED", mode) and can_act("LIVE_ALLOWED", mode)


A = Keypair.generate().public_key
B = Keypair.generate().public_key


class FakeRpc:
    def __init__(self, by_mint):
        self.by_mint = by_mint
        self.calls = []
        self.fail = False

    async def get_multiple_parsed_accounts(self, keys):
        if self.fail:
            self.fail = False
            raise RuntimeError("429 Too Many Requests")
        self.calls.append(list(keys))
        return [self.by_mint.get(k) for k in keys]


def test_cache_checks_rechecks_survives_restart(tmp_path):
    path = str(tmp_path / "token-safety.json")
    rpc = FakeRpc({A: mint_account("spl-token", mintAuthority=None, freezeAuthority=None),
                   B: mint_account("spl-token-2022", extensions=[ext("transferFeeConfig", newerTransferFee={"transferFeeBasisPoints": 100})])})
    s = TokenSafety(path, [], T)
    s.note_market(B, "FEE", {"holders": 50_000})
    assert asyncio.run(s.refresh(rpc, {"GOOD": A, "FEE": B}, NOW)) == 2
    assert rpc.calls == [[A, B]]
    assert s.verdict("GOOD", A, True, NOW).state == "LIVE_ALLOWED"
    assert s.verdict("FEE", B, False, NOW).state == "BLOCKED"
    assert asyncio.run(s.refresh(rpc, {"GOOD": A, "FEE": B}, NOW + 1000)) == 0
    assert s.entries[B]["market"] == {"holders": 50_000}

    again = TokenSafety(path, [], T)
    assert again.due([A, B], NOW + 1000) == []
    assert again.due([A, B], NOW + DAY) == [A, B]
    assert asyncio.run(again.refresh(rpc, {"GOOD": A, "FEE": B}, NOW + DAY)) == 2
    assert again.cycle_state([("GOOD", A, True), ("FEE", B, False)], NOW + DAY) == "BLOCKED"


def test_malformed_mint_blocked_without_failing_others(tmp_path):
    rpc = FakeRpc({A: mint_account("spl-token")})
    s = TokenSafety(str(tmp_path / "s.json"), [], T)
    assert asyncio.run(s.refresh(rpc, {"GOOD": A, "BAD": "not-a-mint!"}, NOW)) == 2
    assert rpc.calls == [[A]]
    assert s.verdict("GOOD", A, True, NOW).state == "LIVE_ALLOWED"
    assert s.verdict("BAD", "not-a-mint!", False, NOW) == SafetyVerdict("BLOCKED", ["not a valid mint address"])


def test_failed_check_keeps_recent_facts(tmp_path):
    rpc = FakeRpc({A: mint_account("spl-token")})
    s = TokenSafety(str(tmp_path / "s.json"), [], T, retry_ms=600_000)
    asyncio.run(s.refresh(rpc, {"GOOD": A}, NOW))
    rpc.fail = True
    with pytest.raises(RuntimeError, match="429"):
        asyncio.run(s.refresh(rpc, {"GOOD": A, "NEW": B}, NOW + 1000))
    assert s.verdict("GOOD", A, True, NOW + 1000).state == "LIVE_ALLOWED"
    unchecked = s.verdict("NEW", B, True, NOW + 1000)
    assert unchecked.state == "PAPER_ONLY"
    assert "last on-chain check failed: RuntimeError: 429" in ",".join(unchecked.reasons)
    assert s.due([A, B], NOW + 2000) == []
    assert s.due([A, B], NOW + 1000 + 600_000) == [B]


def test_reads_typescript_cache_file(tmp_path):
    import json
    path = tmp_path / "token-safety.json"
    path.write_text(json.dumps({A: {"symbol": "GOOD", "checkedAt": NOW, "chain": {**CLEAN, "decimals": 6}},
                                B: {"symbol": "X", "checkedAt": NOW, "error": "Error: 429"}}, indent=2))
    s = TokenSafety(str(path), [], T)
    assert s.verdict("GOOD", A, True, NOW).state == "LIVE_ALLOWED"
    assert s.due([A, B], NOW + 1) == []
