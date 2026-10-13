/**
 * Saring verdicts as Wormhole VAAs: fetch one from Wormholescan, parse it, and check it against the
 * live court account. Guardian signatures are verified on-chain by each EVM chain's core bridge
 * (`parseAndVerifyVM`); this helper checks what a reader can check off-chain: emitter, payload, court.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { readCourtVerdict, type Verdict } from "./venue";

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
  if (p.length < 45 || p[0] !== 1) throw new Error("Not a Saring verdict payload");
  return {
    guardianSetIndex: b.readUInt32BE(1),
    signatures: n,
    emitterChain: b.readUInt16BE(body + 8),
    emitterAddress: b.subarray(body + 10, body + 42).toString("hex"),
    sequence: b.readBigUInt64BE(body + 42),
    court: new PublicKey(p.subarray(1, 33)),
    yes: p[33], no: p[34], excluded: p[35], incomplete: p[36] === 1,
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

/** Checks a VAA came from the Saring emitter and that its tally equals the live court account. Throws on any mismatch. */
export async function verifySaringVaa(connection: Connection, vaa: Uint8Array): Promise<SaringVaa & { verdict: Verdict }> {
  const v = parseSaringVaa(vaa);
  if (v.emitterChain !== 1 || v.emitterAddress !== SARING_EMITTER) throw new Error(`Wrong emitter ${v.emitterChain}/${v.emitterAddress}`);
  const verdict = await readCourtVerdict(connection, v.court);
  if (!verdict.resolved || verdict.yes !== v.yes || verdict.no !== v.no || verdict.excluded !== v.excluded || verdict.incomplete !== v.incomplete)
    throw new Error(`VAA tally ${v.yes}/${v.no}/${v.excluded} does not match court ${v.court.toBase58()}`);
  return { ...v, verdict };
}
