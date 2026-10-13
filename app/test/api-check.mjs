// Local check of app/api/faucet.js and rpc.js with a stubbed upstream (no network, no real keys).
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
const repo = process.argv[2] ?? new URL("../..", import.meta.url).pathname.slice(0, -1); // run: node app/test/api-check.mjs
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(16);
const pub = publicKey.export({ format: "der", type: "spki" }).subarray(12);
process.env.HELIUS_KEY = "test"; process.env.FAUCET_SECRET = JSON.stringify([...seed, ...pub]);

let mode = "noconfirm", sends = 0, upstreamCalls = 0;
globalThis.fetch = async (url, init) => {
  upstreamCalls++;
  const b = JSON.parse(init.body);
  const one = (m) => {
    if (m.method === "getBalance") return { value: m.params[0].startsWith("1111111111") ? 0 : 10e9 };
    if (m.method === "getLatestBlockhash") return { value: { blockhash: "11111111111111111111111111111111" } };
    if (m.method === "sendTransaction") { sends++; return "sig"; }
    if (m.method === "getSignatureStatuses") { if (mode === "throw") throw new Error("rpc down"); return { value: [null] }; }
    return null;
  };
  const text = JSON.stringify(Array.isArray(b) ? b.map((m) => ({ jsonrpc: "2.0", id: m.id, result: one(m) })) : { jsonrpc: "2.0", id: b.id, result: one(b) });
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
};
const realTimeout = setTimeout;
globalThis.setTimeout = (f) => realTimeout(f, 0); // skip the 20 s confirmation wait
const call = async (h, { origin, body, ip = "1.1.1.1", net } = {}) => {
  let status, out;
  const res = { status(s) { status = s; return res; }, json(j) { out = j; return res; }, setHeader() { return res; }, send(t) { out = t; return res; } };
  await h({ method: "POST", headers: { origin, "x-forwarded-for": ip }, body, query: { net } }, res);
  return { status, out };
};

const faucet = (await import(`${repo}/app/api/faucet.js`)).default;
const A = "11111111111111111111111111111112";
assert.equal((await call(faucet, { origin: "https://evil.example", body: { address: A } })).status, 403);
let r = await call(faucet, { origin: "https://saring-silk.vercel.app", body: { address: A } });
assert.equal(r.status, 504); assert.equal(sends, 1);
r = await call(faucet, { origin: "https://saring-silk.vercel.app", body: { address: A }, ip: "2.2.2.2" });
assert.equal(r.status, 429, "retry after 504 must keep the cooldown"); assert.equal(sends, 1);
mode = "throw";
const B = "11111111111111111111111111111113";
r = await call(faucet, { body: { address: B }, ip: "3.3.3.3" });
assert.equal(r.status, 502); assert.equal(sends, 2);
r = await call(faucet, { body: { address: B }, ip: "4.4.4.4" });
assert.equal(r.status, 429, "retry after a post-send error must keep the cooldown"); assert.equal(sends, 2);
console.log("faucet ok: foreign origin 403, 504 and post-send error keep the cooldown (no double pay)");

const rpc = (await import(`${repo}/app/api/rpc.js`)).default;
const gpa = { jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: ["6gM5afTQBq5VZCfgpGqcsqzfWd5maLSCKWtGjbEobZMp", { filters: [{ dataSize: 202 }, { memcmp: { offset: 8, bytes: "x" } }] }] };
assert.equal((await call(rpc, { net: "mainnet", body: [gpa, { jsonrpc: "2.0", id: 2, method: "getSlot" }] })).status, 429, "GPA hidden in a batch");
for (let i = 0; i < 20; i++) {
  const g = { ...gpa, params: [gpa.params[0], { filters: [{ dataSize: 202 }, { memcmp: { offset: 8, bytes: "k" + i } }] }] };
  assert.equal((await call(rpc, { net: "mainnet", body: g, ip: "9.9.9.9" })).status, 200, `scan ${i}`);
}
const before = upstreamCalls;
assert.equal((await call(rpc, { net: "mainnet", body: { ...gpa, params: [gpa.params[0], { filters: [{ dataSize: 202 }, { memcmp: { offset: 8, bytes: "new" } }] }] }, ip: "9.9.9.9" })).status, 429, "21st uncached scan");
assert.equal(upstreamCalls, before, "rate-limited scan must not reach upstream");
const sim = (tx, cfg) => ({ jsonrpc: "2.0", id: 3, method: "simulateTransaction", params: [tx, cfg] });
assert.equal((await call(rpc, { net: "mainnet", body: sim("A".repeat(1701)) })).status, 403);
assert.equal((await call(rpc, { net: "mainnet", body: sim("AAAA", { accounts: { addresses: ["x"] } }) })).status, 403);
assert.equal((await call(rpc, { net: "mainnet", body: sim("AAAA", { encoding: "base64" }) })).status, 200);
assert.equal((await call(rpc, { net: "mainnet", body: { jsonrpc: "2.0", id: 4, method: "getSlot" }, origin: "https://evil.example" })).status, 403);
console.log("rpc ok: GPA alone + 20/min/IP (21st never reaches upstream), simulate capped, foreign origin 403");
