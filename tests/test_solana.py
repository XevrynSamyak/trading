import base64
import json
import os
from pathlib import Path

import pytest

from arbbot.solana import ed25519
from arbbot.solana.base58 import b58decode, b58encode
from arbbot.solana.keys import Keypair, associated_token_address, is_valid_address
from arbbot.solana.tx import (
    AccountMeta,
    Instruction,
    LookupTable,
    MessageV0,
    VersionedTransaction,
    encode_length,
    parse_lookup_table,
)

FIX = json.loads((Path(__file__).parent / "fixtures" / "web3js.json").read_text())


def test_base58_round_trip_and_leading_zeros():
    for data in [b"", b"\0", b"\0\0abc", os.urandom(32), os.urandom(64)]:
        assert b58decode(b58encode(data)) == data
    assert b58encode(bytes(32)) == "11111111111111111111111111111111"
    with pytest.raises(ValueError, match="Non-base58"):
        b58decode("NEWMINT0OIl")
    assert not is_valid_address("NEWMINT111")
    assert is_valid_address("So11111111111111111111111111111111111111112")


def test_ed25519_matches_web3js_keys_and_verifies():
    for kp in FIX["keypairs"]:
        k = Keypair.from_base58(kp["secret"])
        assert k.public_key == kp["pub"]
        msg = b"hello solana"
        sig = k.sign(msg)
        assert ed25519.verify(b58decode(kp["pub"]), msg, sig)
        assert not ed25519.verify(b58decode(kp["pub"]), msg + b"!", sig)
    with pytest.raises(ValueError, match="invalid"):
        bad = bytearray(b58decode(FIX["keypairs"][0]["secret"]))
        bad[40] ^= 1
        Keypair(bytes(bad))


def test_ed25519_matches_an_independent_implementation():
    crypto = pytest.importorskip("cryptography.hazmat.primitives.asymmetric.ed25519")
    from cryptography.hazmat.primitives import serialization

    for _ in range(5):
        seed = os.urandom(32)
        ref = crypto.Ed25519PrivateKey.from_private_bytes(seed)
        pub = ref.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        assert ed25519.public_key(seed) == pub
        assert ed25519.sign(seed, b"msg") == ref.sign(b"msg")


def test_associated_token_addresses_match_web3js():
    for c in FIX["ata"]:
        assert associated_token_address(c["owner"], c["mint"]) == c["ata"]


def test_compact_u16():
    assert encode_length(0) == b"\0"
    assert encode_length(127) == b"\x7f"
    assert encode_length(128) == b"\x80\x01"
    assert encode_length(16384) == b"\x80\x80\x01"


@pytest.mark.parametrize("i", range(len(FIX["cases"])))
def test_v0_transactions_are_byte_identical_to_web3js(i):
    c = FIX["cases"][i]
    ixs = [
        Instruction(ix["programId"], [AccountMeta(k["pubkey"], k["isSigner"], k["isWritable"]) for k in ix["keys"]], base64.b64decode(ix["data"]))
        for ix in c["instructions"]
    ]
    tables = [LookupTable(t["key"], t["addresses"]) for t in c["tables"]]
    msg = MessageV0.compile(c["payer"], ixs, c["blockhash"], tables)
    assert base64.b64encode(msg.serialize()).decode() == c["message"]
    tx = VersionedTransaction(msg)
    tx.sign([Keypair.from_base58(FIX["payerSecret"])])
    assert base64.b64encode(tx.serialize()).decode() == c["tx"]


def test_lookup_table_account_parsing():
    addrs = [Keypair.generate().public_key for _ in range(3)]
    data = bytes(56) + b"".join(b58decode(a) for a in addrs)
    assert parse_lookup_table("T", data).addresses == addrs


def test_oversized_transaction_is_refused():
    kp = Keypair.generate()
    ixs = [Instruction(Keypair.generate().public_key, [AccountMeta(Keypair.generate().public_key, False, True) for _ in range(10)], bytes(10)) for _ in range(6)]
    tx = VersionedTransaction(MessageV0.compile(kp.public_key, ixs, kp.public_key, []))
    with pytest.raises(ValueError, match="overruns"):
        tx.serialize()
