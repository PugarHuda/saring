// Vercel function: devnet faucet so visitors can run one dispute without hunting for
// SOL. Sends GRANT to a burner only while it holds less than one run's worth.
// Dependency-free on purpose: web3.js's websocket deps break in the function runtime,
// so the transfer is built by hand and signed with node:crypto's Ed25519.
import { createPrivateKey, sign } from "node:crypto";

const GRANT = 150_000_000n; // 0.15 SOL; one run costs ~0.10 SOL (~0.105 with a bet)
const ENOUGH = 120_000_000; // 0.12 SOL
const SYSTEM_PROGRAM = new Uint8Array(32);

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn));
  for (const c of s) if (c === "1") bytes.unshift(0); else break;
  return Uint8Array.from(bytes);
}
function b58encode(b) {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = "";
  for (; n > 0n; n /= 58n) s = ALPHABET[Number(n % 58n)] + s;
  for (const x of b) if (x === 0) s = "1" + s; else break;
  return s;
}
const le = (v, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(v) >> BigInt(8 * i)) & 0xffn));
const concat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));

async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

/** Legacy transfer: 1 signer, accounts [from, to, system], one SystemProgram::Transfer. */
function transferTx(secret, to, lamports, blockhash) {
  const from = secret.subarray(32, 64);
  const message = concat(
    [1, 0, 1], // header: 1 signature, 0 readonly signed, 1 readonly unsigned
    [3], from, to, SYSTEM_PROGRAM,
    b58decode(blockhash),
    [1, 2, 2, 0, 1, 12], le(2, 4), le(lamports, 8) // 1 ix: program 2, accounts [0,1], data = Transfer(lamports)
  );
  const pkcs8 = concat([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20], secret.subarray(0, 32));
  const sig = sign(null, message, createPrivateKey({ key: Buffer.from(pkcs8), format: "der", type: "pkcs8" }));
  return { tx: concat([1], sig, message), signature: b58encode(sig), from };
}

// ponytail: per-instance memory; a shared KV store would make limits global across instances.
const COOLDOWN_MS = 10 * 60_000;
const lastGrant = new Map(); // ip or address -> timestamp
const inFlight = new Set(); // addresses being funded right now

export default async function handler(req, res) {
  const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "unknown";
  let address;
  let mine = false;
  try {
    address = (typeof req.body === "string" ? JSON.parse(req.body) : req.body)?.address;
    if (typeof address !== "string" || address.length > 64) return res.status(400).json({ error: "invalid address" });
    const now = Date.now();
    for (const k of [ip, address]) {
      if (now - (lastGrant.get(k) ?? 0) < COOLDOWN_MS) return res.status(429).json({ error: "please wait 10 minutes before asking again" });
    }
    if (inFlight.has(address)) return res.status(429).json({ error: "already funding this wallet" });
    // Claim the slots before the first await, so concurrent requests can't slip past.
    inFlight.add(address);
    mine = true;
    lastGrant.set(ip, now);
    lastGrant.set(address, now);
    const out = await grant(req, address);
    if (out.status !== 200) {
      lastGrant.delete(ip);
      lastGrant.delete(address);
    }
    return res.status(out.status).json(out.body);
  } catch {
    lastGrant.delete(ip);
    if (typeof address === "string") lastGrant.delete(address);
    return res.status(502).json({ error: "faucet temporarily unavailable" });
  } finally {
    if (mine) inFlight.delete(address);
  }
}

async function grant(req, address) {
  const reply = (status, body) => ({ status, body });
  if (req.method !== "POST") return reply(405, { error: "POST only" });
  const { HELIUS_KEY, FAUCET_SECRET } = process.env;
  if (!HELIUS_KEY || !FAUCET_SECRET) return reply(500, { error: "faucet not configured" });
  const url = `https://devnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

  let to;
  try {
    to = b58decode(String(address));
    if (to.length !== 32) throw new Error();
  } catch {
    return reply(400, { error: "invalid address" });
  }

  if ((await rpc(url, "getBalance", [address])).value >= ENOUGH) {
    return reply(429, { error: "this wallet already has enough devnet SOL" });
  }
  const secret = Uint8Array.from(JSON.parse(FAUCET_SECRET));
  const { value: { blockhash } } = await rpc(url, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  const { tx, signature, from } = transferTx(secret, to, GRANT, blockhash);
  if ((await rpc(url, "getBalance", [b58encode(from)])).value < Number(GRANT) + 5000) {
    return reply(503, { error: "faucet is empty" });
  }
  await rpc(url, "sendTransaction", [Buffer.from(tx).toString("base64"), { encoding: "base64" }]);
  for (let i = 0; i < 20; i++) {
    const s = (await rpc(url, "getSignatureStatuses", [[signature]])).value[0];
    if (s?.err) return reply(500, { error: "transfer failed", signature });
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
      return reply(200, { signature, sol: Number(GRANT) / 1e9 });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return reply(504, { error: "transfer not confirmed yet", signature });
}
