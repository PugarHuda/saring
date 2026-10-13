/**
 * Saring verdicts as Wormhole VAAs: fetch one from Wormholescan, parse it, and check it against the
 * live court account. `verifySaringVaa` also checks the guardian signatures (quorum, ascending
 * indices) against the guardian set the Wormhole core bridge stores on Solana: the same check EVM
 * core bridges run in `parseAndVerifyVM`, so a VAA it accepts is one those contracts accept.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { readCourtVerdict, type Verdict } from "./venue";

/** Wormhole core bridge on Solana devnet (holds the testnet guardian sets). */
export const WORMHOLE_CORE_DEVNET = new PublicKey("3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5");

/** `saring_wormhole` emitter PDA ["emitter"] on Solana devnet, as a Wormhole 32-byte address. */
export const SARING_EMITTER = "54c231cefc5bd0966f82594e4333d6211f9a1ab4740be61271fdcb2d5ceb6238";
export const WORMHOLESCAN_TESTNET = "https://api.testnet.wormholescan.io/api/v1/vaas";

export interface SaringVaa {
  guardianSetIndex: number;
  signatures: number;
  emitterChain: number;
  emitterAddress: string;
  sequence: bigint;
  court: PublicKey;
  yes: number;
  no: number;
  excluded: number;
  incomplete: boolean;
  slot: bigint;
}

/** Parses a VAA (v1) whose payload is the 45-byte Saring verdict: 0x01 | court[32] | yes | no | excluded | incomplete | slot u64 BE. */
export function parseSaringVaa(vaa: Uint8Array): SaringVaa {
  const b = Buffer.from(vaa);
  if (b[0] !== 1) throw new Error(`Unsupported VAA version ${b[0]}`);
  const n = b[5], body = 6 + 66 * n, p = b.subarray(body + 51);
  if (p.length !== 45 || p[0] !== 1) throw new Error("Not a Saring verdict payload"); // exactly what SaringWormhole.sol accepts
  return {
    guardianSetIndex: b.readUInt32BE(1),
    signatures: n,
    emitterChain: b.readUInt16BE(body + 8),
    emitterAddress: b.subarray(body + 10, body + 42).toString("hex"),
    sequence: b.readBigUInt64BE(body + 42),
    court: new PublicKey(p.subarray(1, 33)),
    yes: p[33], no: p[34], excluded: p[35], incomplete: p[36] !== 0, // as SaringWormhole.sol reads it
    slot: p.readBigUInt64BE(37),
  };
}

/** Fetches every Saring VAA from Wormholescan testnet (newest first). */
export async function fetchSaringVaas(api = WORMHOLESCAN_TESTNET): Promise<{ sequence: number; vaa: Uint8Array; txHash: string }[]> {
  const r = await fetch(`${api}/1/${SARING_EMITTER}?pageSize=100`);
  if (!r.ok) throw new Error(`Wormholescan HTTP ${r.status}`);
  const j = (await r.json()) as { data: { sequence: number; vaa: string; txHash: string }[] };
  return j.data.map((d) => ({ sequence: d.sequence, vaa: Buffer.from(d.vaa, "base64"), txHash: d.txHash }));
}

/** Guardian addresses (20-byte hex) of set `index`, from the core bridge's GuardianSet account. */
export async function guardianSet(connection: Connection, index: number, core = WORMHOLE_CORE_DEVNET): Promise<{ keys: string[]; expiry: number }> {
  const idx = Buffer.alloc(4);
  idx.writeUInt32BE(index);
  const [addr] = PublicKey.findProgramAddressSync([Buffer.from("GuardianSet"), idx], core);
  const info = await connection.getAccountInfo(addr, "confirmed");
  if (!info || !info.owner.equals(core)) throw new Error(`Guardian set ${index} not found on ${core.toBase58()}`);
  // borsh GuardianSetData: index u32 | keys Vec<[u8; 20]> | creation_time u32 | expiration_time u32
  const d = info.data, n = d.readUInt32LE(4);
  const keys = Array.from({ length: n }, (_, i) => d.subarray(8 + 20 * i, 28 + 20 * i).toString("hex"));
  return { keys, expiry: d.readUInt32LE(8 + 20 * n + 4) };
}

/** Throws unless a quorum of `keys` signed the VAA body in ascending guardian order, as the core bridges require. */
export function checkGuardianSignatures(vaa: Uint8Array, keys: string[]): void {
  const b = Buffer.from(vaa), n = b[5];
  const digest = keccak_256(keccak_256(b.subarray(6 + 66 * n)));
  const quorum = Math.floor((keys.length * 2) / 3) + 1;
  if (n < quorum) throw new Error(`${n} guardian signature(s), quorum is ${quorum}`);
  let last = -1;
  for (let i = 0; i < n; i++) {
    const s = b.subarray(6 + 66 * i, 6 + 66 * (i + 1)), gi = s[0];
    if (gi <= last || gi >= keys.length) throw new Error(`bad guardian index ${gi}`);
    last = gi;
    const pub = secp256k1.Signature.fromCompact(s.subarray(1, 65)).addRecoveryBit(s[65]).recoverPublicKey(digest).toRawBytes(false);
    const signer = Buffer.from(keccak_256(pub.subarray(1))).subarray(12).toString("hex");
    if (signer !== keys[gi].toLowerCase()) throw new Error(`signature ${i} is not from guardian ${gi}`);
  }
}

/**
 * Checks a VAA is guardian-signed (against the core bridge's guardian set on Solana), came from the
 * Saring emitter, and carries the live court account's tally. Throws on any mismatch.
 */
export async function verifySaringVaa(connection: Connection, vaa: Uint8Array, core = WORMHOLE_CORE_DEVNET): Promise<SaringVaa & { verdict: Verdict }> {
  const v = parseSaringVaa(vaa);
  const gs = await guardianSet(connection, v.guardianSetIndex, core);
  if (gs.expiry !== 0 && gs.expiry * 1000 < Date.now()) throw new Error(`guardian set ${v.guardianSetIndex} expired`);
  checkGuardianSignatures(vaa, gs.keys);
  if (v.emitterChain !== 1 || v.emitterAddress !== SARING_EMITTER) throw new Error(`Wrong emitter ${v.emitterChain}/${v.emitterAddress}`);
  const verdict = await readCourtVerdict(connection, v.court);
  if (!verdict.resolved || verdict.yes !== v.yes || verdict.no !== v.no || verdict.excluded !== v.excluded || verdict.incomplete !== v.incomplete)
    throw new Error(`VAA tally ${v.yes}/${v.no}/${v.excluded} does not match court ${v.court.toBase58()}`);
  return { ...v, verdict };
}
