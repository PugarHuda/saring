// Vercel function: live reads for the Multichain section that the browser can't make itself.
// ZecBlock's API (Zcash testnet) and Wormholescan (the Saring verdict VAA) send no CORS headers.
// Every other chain in that section is read browser-side over CORS-enabled RPC.
// Only the fixed Saring txs / VAA below are fetched; nothing from the request reaches the upstream.
const ZEC_API = "https://api.testnet.zecblock.com/api/tx/";
const TXS = {
  payout: "752e543cd8ef2d4e35511c09afe89d89d164df4c3adb4f1dc909d64b5e03aa85",
  bond1: "5edea8cec97f12eb584a366e4705b951bce6c07eb48067d9fdd643c339f8902e",
  bond2: "971faa3c8a8c18afd738549333f51c29c2474d27f9630d3dc804d70d19b78c57",
  bond3: "e6c5ef6943b2735a782eae77cb72e9fa17f44c737f6a7afc748d2426c68b207b",
};
// The guardian-signed VAA the saring_wormhole program's emitter posted for court 24gQ… (seq 0).
const VAA_API = "https://api.testnet.wormholescan.io/api/v1/vaas/1/54c231cefc5bd0966f82594e4333d6211f9a1ab4740be61271fdcb2d5ceb6238/0";
const TTL_MS = 30_000;
const ALLOWED_ORIGIN = /^https:\/\/(saring-silk|saring-[a-z0-9-]+-hudas-projects-[a-z0-9]+)\.vercel\.app$|^http:\/\/localhost(:\d+)?$/;

let cache = null; // { t, body } per instance
let inflight = null;

async function tx(id) {
  const r = await fetch(ZEC_API + id, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`ZecBlock ${r.status}`);
  const j = await r.json();
  return {
    txid: j.txid, block: Number(j.blockHeight), time: Number(j.blockTime), confirmations: j.confirmations, status: j.status,
    version: j.version, ironwoodActions: j.ironwoodActions, orchardActions: j.orchardActions, saplingOutputs: j.saplingOutputCount,
    transparentInputs: j.inputCount, transparentOutputs: j.outputCount, valueBalance: j.valueBalance, fee: j.fee,
  };
}

async function zcash() {
  return Object.fromEntries(await Promise.all(Object.entries(TXS).map(async ([k, id]) => [k, await tx(id)])));
}

/** Fetches the VAA and decodes it (header, body, 45-byte Saring payload) from the raw bytes, not the indexer's fields. */
async function wormhole() {
  const r = await fetch(VAA_API, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Wormholescan ${r.status}`);
  const d = (await r.json()).data;
  const b = Buffer.from(d.vaa, "base64");
  const sigs = b[5];
  const body = 6 + 66 * sigs; // timestamp4 nonce4 chain2 emitter32 seq8 consistency1 payload
  const p = b.subarray(body + 51);
  if (p.length !== 45 || p[0] !== 1) throw new Error("unexpected VAA payload");
  return {
    id: d.id, solanaTx: d.txHash, emitter: d.emitterNativeAddr, timestamp: d.timestamp,
    guardianSet: b.readUInt32BE(1), signatures: sigs,
    emitterChain: b.readUInt16BE(body + 8), emitterAddress: b.subarray(body + 10, body + 42).toString("hex"),
    sequence: Number(b.readBigUInt64BE(body + 42)),
    verdict: { court: p.subarray(1, 33).toString("hex"), yes: p[33], no: p[34], excluded: p[35], incomplete: p[36] !== 0, slot: Number(p.readBigUInt64BE(37)) },
    vaaHex: b.toString("hex"),
  };
}

const settled = (r) => (r.status === "fulfilled" ? r.value : null);
const why = (r) => (r.status === "rejected" ? (r.reason?.name === "TimeoutError" ? "timeout" : r.reason?.message ?? "error") : undefined);

async function load() {
  const [z, w] = await Promise.allSettled([zcash(), wormhole()]);
  if (z.status === "rejected" && w.status === "rejected") throw z.reason;
  return {
    source: "api.testnet.zecblock.com, api.testnet.wormholescan.io", at: Date.now(),
    zcash: settled(z), zcashError: why(z), wormhole: settled(w), wormholeError: why(w),
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGIN.test(origin)) return res.status(403).json({ error: "origin not allowed" });
  try {
    if (!cache || Date.now() - cache.t > TTL_MS) {
      inflight ??= load().finally(() => (inflight = null));
      cache = { t: Date.now(), body: await inflight };
    }
    res.setHeader("Cache-Control", "public, max-age=15");
    res.status(200).json(cache.body);
  } catch (e) {
    res.status(502).json({ error: `upstream: ${e?.name === "TimeoutError" ? "timeout" : e?.message ?? "error"}` });
  }
}
