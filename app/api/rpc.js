// Vercel function: same-origin JSON-RPC proxy so the RPC provider key never reaches
// the browser. Mainnet is read-only (Panta positions); devnet also sends the court's
// transactions. Only the methods (and, for getProgramAccounts, the programs and
// filters) the app uses are forwarded.
const UPSTREAM = {
  devnet: "https://devnet.helius-rpc.com/?api-key=",
  mainnet: "https://mainnet.helius-rpc.com/?api-key=",
};
const READ = new Set([
  "getAccountInfo", "getMultipleAccounts", "getLatestBlockhash", "getBlockHeight",
  "getSignatureStatuses", "getBalance", "getSlot", "getTransaction", "getSignaturesForAddress",
  "getMinimumBalanceForRentExemption", "getVersion", "getHealth", "getEpochInfo", "getFeeForMessage",
]);
const DEVNET_WRITE = new Set(["sendTransaction", "simulateTransaction"]);
const PANTA_PROGRAM = "6gM5afTQBq5VZCfgpGqcsqzfWd5maLSCKWtGjbEobZMp";
const MAX_BATCH = 5;
const TIMEOUT_MS = 25_000;

const isObj = (c) => c !== null && typeof c === "object" && !Array.isArray(c);

function allowed(net, call) {
  if (!isObj(call) || typeof call.method !== "string") return false;
  if (call.method === "getProgramAccounts") {
    // Only Panta's position scan on mainnet, and only with the filters the app sends.
    const [program, cfg] = Array.isArray(call.params) ? call.params : [];
    const filters = cfg?.filters;
    return net === "mainnet" && program === PANTA_PROGRAM && Array.isArray(filters)
      && filters.some((f) => f?.dataSize === 202) && filters.some((f) => f?.memcmp);
  }
  return READ.has(call.method) || (net === "devnet" && DEVNET_WRITE.has(call.method));
}

export default async function handler(req, res) {
  try {
    const net = req.query.net === "mainnet" ? "mainnet" : "devnet";
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    const key = process.env.HELIUS_KEY;
    if (!key) return res.status(500).json({ error: "RPC not configured" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const calls = Array.isArray(body) ? body : [body];
    if (calls.length < 1 || calls.length > MAX_BATCH) return res.status(400).json({ error: `batch must have 1-${MAX_BATCH} calls` });
    const badIndex = calls.findIndex((c) => !allowed(net, c));
    if (badIndex !== -1) {
      const bad = calls[badIndex];
      return res.status(403).json({ jsonrpc: "2.0", id: isObj(bad) ? bad.id ?? null : null, error: { code: -32601, message: `method not allowed: ${isObj(bad) ? bad.method : typeof bad}` } });
    }

    const upstream = await fetch(UPSTREAM[net] + key, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    res.status(upstream.status).setHeader("Content-Type", "application/json").send(await upstream.text());
  } catch (e) {
    res.status(502).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: `proxy error: ${e.name === "TimeoutError" ? "upstream timeout" : "bad request"}` } });
  }
}
