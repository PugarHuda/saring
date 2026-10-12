// Vercel function: live Zcash testnet reads for the Multichain section. ZecBlock's API sends no
// CORS headers (and Cross-Origin-Resource-Policy: same-origin), so the browser can't read it
// directly. Every other chain in that section is read browser-side over CORS-enabled RPC.
// Only the fixed Saring txs below are fetched; nothing from the request reaches the upstream.
const ZEC_API = "https://api.testnet.zecblock.com/api/tx/";
const TXS = {
  payout: "752e543cd8ef2d4e35511c09afe89d89d164df4c3adb4f1dc909d64b5e03aa85",
  bond1: "5edea8cec97f12eb584a366e4705b951bce6c07eb48067d9fdd643c339f8902e",
  bond2: "971faa3c8a8c18afd738549333f51c29c2474d27f9630d3dc804d70d19b78c57",
  bond3: "e6c5ef6943b2735a782eae77cb72e9fa17f44c737f6a7afc748d2426c68b207b",
};
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

async function load() {
  const entries = await Promise.all(Object.entries(TXS).map(async ([k, id]) => [k, await tx(id)]));
  return { source: "api.testnet.zecblock.com", at: Date.now(), zcash: Object.fromEntries(entries) };
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
