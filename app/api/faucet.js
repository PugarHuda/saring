// Vercel function: devnet faucet so visitors can run one dispute without hunting for
// SOL. Sends GRANT to a burner only while it holds less than one run's worth.
// Dependency-free on purpose: web3.js's websocket deps break in the function runtime,
// so the transfer is built by hand and signed with node:crypto's Ed25519.
import { createPrivateKey, sign } from "node:crypto";

const GRANT = 120_000_000n; // 0.12 SOL; one run costs ~0.08 SOL
const ENOUGH = 100_000_000; // 0.1 SOL
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

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { HELIUS_KEY, FAUCET_SECRET } = process.env;
  if (!HELIUS_KEY || !FAUCET_SECRET) return res.status(500).json({ error: "faucet not configured" });
  const url = `https://devnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

  let to, address;
  try {
    address = (typeof req.body === "string" ? JSON.parse(req.body) : req.body).address;
    to = b58decode(address);
    if (to.length !== 32) throw new Error();
  } catch {
    return res.status(400).json({ error: "invalid address" });
  }

  // ponytail: per-address balance cap only; add a per-IP limit (KV) if the faucet gets drained.
  if ((await rpc(url, "getBalance", [address])).value >= ENOUGH) {
    return res.status(429).json({ error: "this wallet already has enough devnet SOL" });
  }
  const secret = Uint8Array.from(JSON.parse(FAUCET_SECRET));
  const { value: { blockhash } } = await rpc(url, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  const { tx, signature, from } = transferTx(secret, to, GRANT, blockhash);
  if ((await rpc(url, "getBalance", [b58encode(from)])).value < Number(GRANT) + 5000) {
    return res.status(503).json({ error: "faucet is empty" });
  }
  await rpc(url, "sendTransaction", [Buffer.from(tx).toString("base64"), { encoding: "base64" }]);
  for (let i = 0; i < 30; i++) {
    const s = (await rpc(url, "getSignatureStatuses", [[signature]])).value[0];
    if (s?.err) return res.status(500).json({ error: "transfer failed", signature });
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
      return res.status(200).json({ signature, sol: Number(GRANT) / 1e9 });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  res.status(504).json({ error: "transfer not confirmed yet", signature });
}
