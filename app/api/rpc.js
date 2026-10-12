// Vercel function: same-origin JSON-RPC proxy so the RPC provider key never reaches
// the browser. Mainnet is read-only (Panta positions); devnet also sends the court's
// transactions. Only the methods the app uses are forwarded.
const UPSTREAM = {
  devnet: "https://devnet.helius-rpc.com/?api-key=",
  mainnet: "https://mainnet.helius-rpc.com/?api-key=",
};
const READ = new Set([
  "getAccountInfo", "getMultipleAccounts", "getProgramAccounts", "getLatestBlockhash", "getBlockHeight",
  "getSignatureStatuses", "getBalance", "getSlot", "getTransaction", "getSignaturesForAddress",
  "getMinimumBalanceForRentExemption", "getVersion", "getHealth", "getEpochInfo", "getFeeForMessage",
]);
const DEVNET_WRITE = new Set(["sendTransaction", "simulateTransaction"]);
const PANTA_PROGRAM = "6gM5afTQBq5VZCfgpGqcsqzfWd5maLSCKWtGjbEobZMp";

function allowed(net, call) {
  if (!call || typeof call.method !== "string") return false;
  // ponytail: getProgramAccounts is the expensive one; mainnet only for Panta's program.
  if (call.method === "getProgramAccounts") return net === "devnet" || call.params?.[0] === PANTA_PROGRAM;
  return READ.has(call.method) || (net === "devnet" && DEVNET_WRITE.has(call.method));
}

export default async function handler(req, res) {
  const net = req.query.net === "mainnet" ? "mainnet" : "devnet";
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const key = process.env.HELIUS_KEY;
  if (!key) return res.status(500).json({ error: "HELIUS_KEY not configured" });

  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const calls = Array.isArray(body) ? body : [body];
  const bad = calls.find((c) => !allowed(net, c));
  if (bad) return res.status(403).json({ jsonrpc: "2.0", id: bad?.id ?? null, error: { code: -32601, message: `method not allowed: ${bad?.method}` } });

  const upstream = await fetch(UPSTREAM[net] + key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  res.status(upstream.status).setHeader("Content-Type", "application/json").send(await upstream.text());
}
