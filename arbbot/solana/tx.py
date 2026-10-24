"""
Version-0 transactions with address lookup tables, compiled exactly the way
@solana/web3.js does it (tests compare the bytes), so the Python bot builds
the same transactions the TypeScript version did.
"""

from dataclasses import dataclass, field

from .base58 import b58decode, b58encode
from .keys import COMPUTE_BUDGET_PROGRAM_ID, SYSTEM_PROGRAM_ID, pubkey_bytes

#: Largest serialized transaction the network accepts.
PACKET_DATA_SIZE = 1232
#: Lookup table accounts store addresses after a 56-byte header.
LOOKUP_TABLE_META_SIZE = 56


@dataclass
class AccountMeta:
    pubkey: str
    is_signer: bool
    is_writable: bool


@dataclass
class Instruction:
    program_id: str
    keys: list[AccountMeta]
    data: bytes


@dataclass
class LookupTable:
    key: str
    addresses: list[str]


def parse_lookup_table(key: str, data: bytes) -> LookupTable:
    body = data[LOOKUP_TABLE_META_SIZE:]
    return LookupTable(key, [b58encode(body[i : i + 32]) for i in range(0, len(body) - len(body) % 32, 32)])


def encode_length(n: int) -> bytes:
    """Solana's compact-u16 length prefix."""
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n == 0:
            out.append(b)
            return bytes(out)
        out.append(b | 0x80)


def set_compute_unit_limit(units: int) -> Instruction:
    return Instruction(COMPUTE_BUDGET_PROGRAM_ID, [], bytes([2]) + units.to_bytes(4, "little"))


def set_compute_unit_price(micro_lamports: int) -> Instruction:
    return Instruction(COMPUTE_BUDGET_PROGRAM_ID, [], bytes([3]) + micro_lamports.to_bytes(8, "little"))


def transfer(from_pubkey: str, to_pubkey: str, lamports: int) -> Instruction:
    return Instruction(
        SYSTEM_PROGRAM_ID,
        [AccountMeta(from_pubkey, True, True), AccountMeta(to_pubkey, False, True)],
        (2).to_bytes(4, "little") + lamports.to_bytes(8, "little"),
    )


@dataclass
class _KeyMeta:
    is_signer: bool = False
    is_writable: bool = False
    is_invoked: bool = False


@dataclass
class CompiledInstruction:
    program_id_index: int
    account_key_indexes: list[int]
    data: bytes


@dataclass
class TableLookup:
    account_key: str
    writable_indexes: list[int]
    readonly_indexes: list[int]


@dataclass
class MessageV0:
    num_required_signatures: int
    num_readonly_signed: int
    num_readonly_unsigned: int
    static_account_keys: list[str]
    recent_blockhash: str
    instructions: list[CompiledInstruction]
    lookups: list[TableLookup] = field(default_factory=list)

    @staticmethod
    def compile(payer: str, instructions: list[Instruction], recent_blockhash: str, tables: list[LookupTable]) -> "MessageV0":
        metas: dict[str, _KeyMeta] = {}

        def meta(key: str) -> _KeyMeta:
            if key not in metas:
                metas[key] = _KeyMeta()
            return metas[key]

        m = meta(payer)
        m.is_signer = m.is_writable = True
        for ix in instructions:
            meta(ix.program_id).is_invoked = True
            for a in ix.keys:
                k = meta(a.pubkey)
                k.is_signer = k.is_signer or a.is_signer
                k.is_writable = k.is_writable or a.is_writable

        lookups: list[TableLookup] = []
        from_lookup_writable: list[str] = []
        from_lookup_readonly: list[str] = []

        def drain(table: LookupTable, writable: bool) -> tuple[list[int], list[str]]:
            indexes, keys = [], []
            for key, km in list(metas.items()):
                if km.is_signer or km.is_invoked or km.is_writable != writable:
                    continue
                if key in table.addresses:
                    idx = table.addresses.index(key)
                    if idx >= 256:
                        raise ValueError("Max lookup table index exceeded")
                    indexes.append(idx)
                    keys.append(key)
                    del metas[key]
            return indexes, keys

        for table in tables:
            w_idx, w_keys = drain(table, True)
            r_idx, r_keys = drain(table, False)
            if w_idx or r_idx:
                lookups.append(TableLookup(table.key, w_idx, r_idx))
                from_lookup_writable += w_keys
                from_lookup_readonly += r_keys

        entries = list(metas.items())
        ws = [k for k, v in entries if v.is_signer and v.is_writable]
        rs = [k for k, v in entries if v.is_signer and not v.is_writable]
        wn = [k for k, v in entries if not v.is_signer and v.is_writable]
        rn = [k for k, v in entries if not v.is_signer and not v.is_writable]
        if not ws or ws[0] != payer:
            raise ValueError("Expected first writable signer key to be the fee payer")
        static = ws + rs + wn + rn
        all_keys = static + from_lookup_writable + from_lookup_readonly
        if len(all_keys) > 256:
            raise ValueError("Account index overflow encountered during compilation")
        index = {k: i for i, k in enumerate(all_keys)}

        def find(key: str) -> int:
            if key not in index:
                raise ValueError("Encountered an unknown instruction account key during compilation")
            return index[key]

        compiled = [CompiledInstruction(find(ix.program_id), [find(a.pubkey) for a in ix.keys], ix.data) for ix in instructions]
        return MessageV0(len(ws) + len(rs), len(rs), len(rn), static, recent_blockhash, compiled, lookups)

    def serialize(self) -> bytes:
        out = bytearray([0x80, self.num_required_signatures, self.num_readonly_signed, self.num_readonly_unsigned])
        out += encode_length(len(self.static_account_keys))
        for k in self.static_account_keys:
            out += pubkey_bytes(k)
        out += b58decode(self.recent_blockhash).rjust(32, b"\0")
        out += encode_length(len(self.instructions))
        for ix in self.instructions:
            out.append(ix.program_id_index)
            out += encode_length(len(ix.account_key_indexes)) + bytes(ix.account_key_indexes)
            out += encode_length(len(ix.data)) + ix.data
        out += encode_length(len(self.lookups))
        for lk in self.lookups:
            out += pubkey_bytes(lk.account_key)
            out += encode_length(len(lk.writable_indexes)) + bytes(lk.writable_indexes)
            out += encode_length(len(lk.readonly_indexes)) + bytes(lk.readonly_indexes)
        return bytes(out)


class VersionedTransaction:
    def __init__(self, message: MessageV0):
        self.message = message
        self.signatures = [bytes(64)] * message.num_required_signatures

    def sign(self, keypairs) -> None:
        data = self.message.serialize()
        signers = self.message.static_account_keys[: self.message.num_required_signatures]
        for kp in keypairs:
            if kp.public_key not in signers:
                raise ValueError(f"Cannot sign with non signer key {kp.public_key}")
            self.signatures[signers.index(kp.public_key)] = kp.sign(data)

    @property
    def signature(self) -> str:
        """The transaction id: its first signature in base58."""
        return b58encode(self.signatures[0])

    def serialize(self) -> bytes:
        out = encode_length(len(self.signatures)) + b"".join(self.signatures) + self.message.serialize()
        if len(out) > PACKET_DATA_SIZE:
            raise ValueError("encoding overruns Uint8Array")
        return out
