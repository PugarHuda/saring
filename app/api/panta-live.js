// Vercel function: live Panta activity on Solana mainnet as Server-Sent Events, with Solami
// (https://solami.dev) as the whole data path. On connect it backfills the last BACKFILL
// Panta transactions through Solami RPC (getSignaturesForAddress + batched getTransaction),
// decodes Panta's Anchor events and sends metrics; then it streams Solami Yellowstone gRPC
// (transactions + UserPosition accounts of the Panta program) for LIVE_MS and closes, so the
// browser's EventSource reconnects. The Solami key never leaves the server.
// Ported from panta/sources.ts (gRPC client, protobuf) and panta/disputes.ts (event decoding).
import http2 from "node:http2";
import { createHash } from "node:crypto";

export const config = { maxDuration: 300 };

const PANTA = "6gM5afTQBq5VZCfgpGqcsqzfWd5maLSCKWtGjbEobZMp";
const BACKFILL = 200; // signatures (2 pages of 100: Solami refuses larger pages)
const LIVE_MS = 240_000;
const HEARTBEAT_MS = 15_000;
const BACKFILL_TTL_MS = 60_000;
const MAX_PER_IP = 3;
const MAX_CLIENTS = 60;
const ALLOWED_ORIGIN = /^https:\/\/(saring-silk|saring-[a-z0-9-]+-hudas-projects-[a-z0-9]+)\.vercel\.app$|^http:\/\/localhost(:\d+)?$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- base58 + Panta event decoding (IDL: panta/balr_market.json) ----------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b) break; s = "1" + s; }
  return s;
}

// field types: k pubkey, b bool, 8 u64, 16 u128, i i64, s OrderSide enum (0 Yes, 1 No)
const EVENTS = {
  "127,139,238,41,118,47,122,39": ["SharesMinted", [["event", "k"], ["user", "k"], ["yes_amount", 16], ["no_amount", 16]]],
  "13,7,65,94,180,82,27,60": ["PrimaryOrderPlaced", [["event", "k"], ["user", "k"], ["side", "s"], ["lamports", 8]]],
  "129,227,105,220,56,214,93,179": ["SecondaryOrderPlaced", [["event", "k"], ["user", "k"], ["side", "s"], ["price", 8], ["amount", 8], ["filled", 8], ["order_id", 8]]],
  "211,0,178,174,61,245,45,250": ["OrderMatched", [["event", "k"], ["buyer", "k"], ["seller", "k"], ["side", "s"], ["price", 8], ["amount", 8]]],
  "211,4,132,75,182,173,36,0": ["MarketDisputed", [["event", "k"], ["disputer", "k"], ["oracle_proposed_yes_wins", "b"], ["disputer_proposed_yes_wins", "b"], ["bond_lamports", 8]]],
  "184,161,20,177,189,60,205,154": ["ResolutionDisputeSettled", [["event", "k"], ["disputer", "k"], ["settled_by", "k"], ["disputer_correct", "b"], ["final_yes_wins", "b"], ["bond_lamports", 8], ["reward_lamports", 8]]],
  "10,219,196,209,32,58,80,212": ["EventResolved", [["event", "k"], ["yes_wins", "b"], ["timestamp", "i"]]],
  "41,76,159,107,100,6,168,135": ["OracleResultSubmitted", [["event", "k"], ["oracle", "k"], ["proposed_yes_wins", "b"]]],
};

function uint(d, o, n) {
  let v = 0n;
  for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]);
  return v;
}

export function decodeEvent(b64) {
  const d = Buffer.from(b64, "base64");
  const spec = EVENTS[[...d.subarray(0, 8)].join(",")];
  if (!spec) return null;
  const data = {};
  let o = 8;
  try {
    for (const [name, t] of spec[1]) {
      if (t === "k") { data[name] = b58(d.subarray(o, o + 32)); o += 32; }
      else if (t === "b") data[name] = d[o++] === 1;
      else if (t === "s") data[name] = d[o++] === 0 ? "YES" : "NO";
      else if (t === "i") { data[name] = Number(d.readBigInt64LE(o)); o += 8; }
      else { data[name] = uint(d, o, t).toString(); o += t; }
    }
  } catch { return null; } // truncated frame
  return { name: spec[0], data };
}

/** Panta events in one transaction's logs (only frames of the Panta program, as panta/disputes.ts). */
export function decodeLogs(logs) {
  const events = [], stack = [];
  for (const l of logs) {
    let m;
    if ((m = l.match(/^Program (\w+) invoke/))) stack.push(m[1]);
    else if (/^Program \w+ (success|failed)/.test(l)) stack.pop();
    if (stack[stack.length - 1] !== PANTA) continue;
    if ((m = l.match(/^Program data: (.+)$/))) { const e = decodeEvent(m[1]); if (e) events.push(e); }
  }
  return events;
}

const short = (s) => `${s.slice(0, 4)}…${s.slice(-4)}`;
// ---------- PDA derivation without web3.js (its websocket deps break in this runtime) ----------
const B58_MAP = Object.fromEntries([...B58].map((c, i) => [c, BigInt(i)]));
function b58decode(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + B58_MAP[c];
  const out = [];
  for (; n > 0n; n >>= 8n) out.unshift(Number(n & 0xffn));
  for (const c of s) if (c === "1") out.unshift(0); else break;
  return Buffer.from(out);
}
const P = 2n ** 255n - 19n;
const D = (-121665n * modInv(121666n)) % P;
function modPow(b, e) { let r = 1n; b %= P; for (; e > 0n; e >>= 1n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; } return r; }
function modInv(a) { return modPow(((a % P) + P) % P, P - 2n); }
/** True if 32 bytes decode to a point on ed25519 (a PDA must not). */
function onCurve(bytes) {
  const b = Buffer.from(bytes);
  b[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const x2 = (u * modInv(v)) % P;
  if (x2 === 0n) return true;
  return modPow(x2, (P - 1n) / 2n) === 1n; // Euler's criterion: x^2 is a square mod p
}
function findPda(seeds, programId) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Buffer.from([bump])).update(programId).update("ProgramDerivedAddress");
    const addr = h.digest();
    if (!onCurve(addr)) return addr;
  }
  throw new Error("no PDA");
}
const PANTA_BYTES = b58decode(PANTA);
export const positionPda = (market, wallet) =>
  b58(findPda([Buffer.from("position"), b58decode(market), b58decode(wallet)], PANTA_BYTES));
const TRADE = { SharesMinted: ["user"], PrimaryOrderPlaced: ["user"], SecondaryOrderPlaced: ["user"], OrderMatched: ["buyer", "seller"] };

/**
 * One transaction -> feed items. `keys`/`pre`/`post` (account keys and lamport balances) make
 * "new position" exact: the UserPosition PDA went from 0 lamports to rent in this tx.
 */
export function txItems({ signature, slot, time, logs, keys, pre, post }, src) {
  const items = [];
  const seen = new Set(); // one item per (market, wallet) per tx: a buy emits SharesMinted + PrimaryOrderPlaced
  for (const { name, data } of decodeLogs(logs)) {
    const base = { sig: signature, slot, t: time, src, market: data.event, event: name };
    for (const f of TRADE[name] ?? []) {
      const wallet = data[f];
      if (seen.has(data.event + wallet)) continue;
      seen.add(data.event + wallet);
      let created = false;
      if (keys) { const i = keys.indexOf(positionPda(data.event, wallet)); created = i >= 0 && pre[i] === 0 && post[i] > 0; }
      const side = data.side ?? (BigInt(data.yes_amount) > 0n ? "YES" : BigInt(data.no_amount) > 0n ? "NO" : null);
      items.push({ ...base, id: `${signature}:${data.event}:${wallet}`, kind: created ? "new-position" : "trade", wallet, walletShort: short(wallet), side });
    }
    const id = `${signature}:${name}:${data.event}`;
    if (name === "MarketDisputed")
      items.push({ ...base, id, kind: "dispute", wallet: data.disputer, walletShort: short(data.disputer), side: data.disputer_proposed_yes_wins ? "YES" : "NO", bondLamports: data.bond_lamports });
    if (name === "EventResolved") items.push({ ...base, id, kind: "resolution", side: data.yes_wins ? "YES" : "NO" });
    if (name === "OracleResultSubmitted") items.push({ ...base, id, kind: "oracle-result", side: data.proposed_yes_wins ? "YES" : "NO" });
    if (name === "ResolutionDisputeSettled") items.push({ ...base, id, kind: "dispute-settled", side: data.final_yes_wins ? "YES" : "NO", disputerCorrect: data.disputer_correct });
  }
  return items;
}

/** UserPosition account (202 bytes: market @9, owner @41, yes @74 (+locked @170), no @90 (+locked @186)). */
export function positionItem(pubkey, slot, d) {
  if (d.length !== 202) return null;
  const market = b58(d.subarray(9, 41)), wallet = b58(d.subarray(41, 73));
  const yes = uint(d, 74, 16) + uint(d, 170, 16), no = uint(d, 90, 16) + uint(d, 186, 16);
  return { id: `acct:${pubkey}:${slot}`, kind: "position-account", src: "grpc", slot, t: Date.now(), market, wallet, walletShort: short(wallet),
    account: pubkey, yes: yes.toString(), no: no.toString(), side: yes > no ? "YES" : no > yes ? "NO" : null };
}

// ---------- metrics ----------

function metrics(items, scanned, oldest) {
  const now = Date.now(), day = 86_400_000;
  const trades = items.filter((i) => i.kind === "new-position" || i.kind === "trade");
  const wk = trades.filter((i) => now - i.t < 7 * day);
  return {
    txsScanned: scanned,
    windowFrom: oldest,
    newPositions24h: trades.filter((i) => i.kind === "new-position" && now - i.t < day).length,
    newPositions7d: wk.filter((i) => i.kind === "new-position").length,
    trades7d: wk.length,
    uniqueWallets7d: new Set(wk.map((i) => i.wallet)).size,
    marketsTouched7d: new Set(wk.map((i) => i.market)).size,
    disputes: items.filter((i) => i.kind === "dispute").length,
    resolutions: items.filter((i) => i.kind === "resolution").length,
  };
}

// ---------- Solami RPC backfill ----------

async function rpc(key, body) {
  for (let i = 0; ; i++) {
    const r = await fetch(`https://rpc.solami.dev/sol?api_key=${encodeURIComponent(key)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (r?.ok) return r.json();
    if (i >= 4) throw new Error(`Solami RPC ${r ? r.status : "unreachable"}`);
    await sleep(500 * 2 ** i);
  }
}

let cache = null; // { t, items, metrics } shared by every connection of this instance
let inflight = null;

async function backfill(key, onItems) {
  const sigs = [];
  let before;
  while (sigs.length < BACKFILL) {
    const j = await rpc(key, { jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [PANTA, { limit: 100, before }] });
    const page = j.result ?? [];
    sigs.push(...page);
    if (page.length < 100) break;
    before = page[page.length - 1].signature;
  }
  const ok = sigs.filter((s) => !s.err);
  const items = [];
  for (let i = 0; i < ok.length; i += 10) {
    const batch = ok.slice(i, i + 10);
    const res = await rpc(key, batch.map((s, k) => ({ jsonrpc: "2.0", id: k, method: "getTransaction",
      params: [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }] })));
    const got = [];
    for (const r of Array.isArray(res) ? res : []) {
      const tx = r.result;
      if (!tx?.meta?.logMessages) continue;
      const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
      got.push(...txItems({ signature: tx.transaction.signatures[0], slot: tx.slot, time: (tx.blockTime ?? 0) * 1000, logs: tx.meta.logMessages,
        keys, pre: tx.meta.preBalances, post: tx.meta.postBalances }, "rpc"));
    }
    items.push(...got);
    onItems(got, `${Math.min(i + 10, ok.length)}/${ok.length} transactions`);
    await sleep(300); // free tier: 10 RPS
  }
  const oldest = sigs.length ? (sigs[sigs.length - 1].blockTime ?? 0) * 1000 : null;
  return { t: Date.now(), items, metrics: metrics(items, ok.length, oldest) };
}

// ---------- Solami Yellowstone gRPC (raw HTTP/2, no grpc dependency) ----------

function pbFields(buf) {
  const out = new Map();
  let i = 0;
  const varint = () => {
    let v = 0n, s = 0n;
    for (;;) { const b = buf[i++]; v |= BigInt(b & 0x7f) << s; if (b < 0x80) return v; s += 7n; }
  };
  while (i < buf.length) {
    const tag = Number(varint()), f = tag >>> 3, wt = tag & 7;
    let v;
    if (wt === 0) v = varint();
    else if (wt === 2) { const n = Number(varint()); v = buf.subarray(i, i + n); i += n; }
    else if (wt === 1) { v = buf.readBigUInt64LE(i); i += 8; }
    else if (wt === 5) { v = BigInt(buf.readUInt32LE(i)); i += 4; }
    else throw new Error(`unsupported wire type ${wt}`);
    if (!out.has(f)) out.set(f, []);
    out.get(f).push(v);
  }
  return out;
}
const one = (m, f) => m.get(f)?.[0];
const sub = (m, f) => { const b = one(m, f); return Buffer.isBuffer(b) ? pbFields(b) : undefined; };
/** repeated uint64, packed (bytes) or not (varints) */
const u64s = (m, f) => (m.get(f) ?? []).flatMap((v) => {
  if (!Buffer.isBuffer(v)) return [Number(v)];
  const out = [];
  let x = 0n, s = 0n;
  for (const b of v) { x |= BigInt(b & 0x7f) << s; s += 7n; if (b < 0x80) { out.push(Number(x)); x = 0n; s = 0n; } }
  return out;
});

/** SubscribeUpdate frame -> feed items (geyser.proto / solana-storage.proto field numbers). */
export function frameItems(frame) {
  const u = pbFields(frame);
  const acc = sub(u, 2); // SubscribeUpdateAccount
  if (acc) {
    const info = sub(acc, 1); // pubkey 1, data 6
    const it = positionItem(b58(one(info, 1)), Number(one(acc, 2) ?? 0n), Buffer.from(one(info, 6) ?? []));
    return it ? [it] : [];
  }
  const txu = sub(u, 4); // SubscribeUpdateTransaction
  if (!txu) return [];
  const info = sub(txu, 1); // signature 1, transaction 3, meta 4
  const meta = sub(info, 4);
  if (!meta || meta.has(1)) return []; // failed tx
  const msg = sub(sub(info, 3) ?? new Map(), 2); // Transaction.message
  const keys = [...(msg?.get(2) ?? []), ...(meta.get(12) ?? []), ...(meta.get(13) ?? [])].map((k) => b58(k));
  return txItems({ signature: b58(one(info, 1)), slot: Number(one(txu, 2) ?? 0n), time: Date.now(),
    logs: (meta.get(6) ?? []).map((b) => b.toString("utf8")), keys, pre: u64s(meta, 3), post: u64s(meta, 4) }, "grpc");
}

const pbVarint = (n) => { const o = []; while (n > 0x7f) { o.push((n & 0x7f) | 0x80); n >>>= 7; } o.push(n); return Buffer.from(o); };
const pbLen = (f, b) => Buffer.concat([pbVarint((f << 3) | 2), pbVarint(b.length), b]);
const pbStr = (f, s) => pbLen(f, Buffer.from(s));
const pbInt = (f, n) => Buffer.concat([pbVarint(f << 3), pbVarint(n)]);
const mapEntry = (f, k, v) => pbLen(f, Buffer.concat([pbStr(1, k), pbLen(2, v)]));
const grpcFrame = (msg) => { const h = Buffer.alloc(5); h.writeUInt32BE(msg.length, 1); return Buffer.concat([h, msg]); };
const SUBSCRIBE = Buffer.concat([
  mapEntry(3, "panta", Buffer.concat([pbInt(1, 0), pbInt(2, 0), pbStr(3, PANTA)])), // transactions: vote=false, failed=false, account_include
  mapEntry(1, "positions", Buffer.concat([pbStr(3, PANTA), pbLen(4, pbInt(2, 202))])), // accounts: owner Panta, datasize 202
  pbInt(6, 1), // commitment CONFIRMED
]);

// One Solami gRPC stream per instance, fanned out to every connected browser.
const listeners = new Set();
let grpc = null; // { session, req, pinger, frames }

function grpcStart(key) {
  const session = http2.connect("https://grpc.solami.dev");
  const req = session.request({ ":method": "POST", ":path": "/geyser.Geyser/Subscribe", "content-type": "application/grpc", te: "trailers", "x-token": key });
  const g = { session, req, frames: 0, live: false };
  const fail = (why) => { if (grpc !== g) return; grpcStop(); for (const l of listeners) l({ down: why }); };
  session.on("error", (e) => fail(`session error: ${e.code ?? e.message}`));
  let buf = Buffer.alloc(0);
  req.on("response", (h) => { if (h["grpc-status"] && h["grpc-status"] !== "0") fail(`grpc-status ${h["grpc-status"]}`); });
  req.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 5 && buf.length >= 5 + buf.readUInt32BE(1)) {
      const n = buf.readUInt32BE(1);
      let items = [];
      try { items = frameItems(buf.subarray(5, 5 + n)); } catch { /* skip undecodable frame */ }
      buf = buf.subarray(5 + n);
      g.frames++;
      if (!g.live) { g.live = true; for (const l of listeners) l({ live: true }); }
      if (items.length) for (const l of listeners) l({ items });
    }
  });
  req.on("trailers", (t) => fail(`grpc-status ${t["grpc-status"]}`));
  req.on("close", () => fail("stream closed"));
  req.on("error", (e) => fail(`stream error: ${e.code ?? e.message}`));
  req.write(grpcFrame(SUBSCRIBE));
  let ping = 0;
  g.pinger = setInterval(() => req.write(grpcFrame(pbLen(9, pbInt(1, ++ping)))), 10_000); // keepalive
  grpc = g;
}

function grpcStop() {
  if (!grpc) return;
  clearInterval(grpc.pinger);
  try { grpc.req.close(); grpc.session.close(); } catch { /* already gone */ }
  grpc = null;
}

// ---------- handler ----------

const conns = new Set(); // { ip, finish } per open stream, oldest first
const LIVE = { via: "Solami Yellowstone gRPC grpc.solami.dev" };
const RPC = { via: "Solami RPC rpc.solami.dev" };

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGIN.test(origin)) return res.status(403).json({ error: "origin not allowed" });
  const key = process.env.SOLAMI_API_KEY;
  if (!key) return res.status(500).json({ error: "Solami not configured" });
  const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "unknown";
  // Client disconnects don't reliably reach the function (the browser drops the stream every
  // time the section scrolls out of view), so a dead stream can hold its slot until LIVE_MS.
  // Rejecting the IP's next connection then 429s a real visitor; instead its oldest stream
  // is closed. An IP still holds at most MAX_PER_IP streams, the instance MAX_CLIENTS.
  // ponytail: per-instance limits; a shared KV store if this gets abused across instances.
  const mine = [...conns].filter((c) => c.ip === ip);
  if (mine.length >= MAX_PER_IP) mine[0].finish();
  if (conns.size >= MAX_CLIENTS) return res.status(429).json({ error: "too many live connections" });

  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  let open = true, listener, resolveDone;
  const send = (event, data) => open && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const hb = setInterval(() => open && res.write(`: heartbeat ${new Date().toISOString()}\n\n`), HEARTBEAT_MS);
  const done = new Promise((r) => (resolveDone = r));
  const finish = () => {
    if (!open) return;
    open = false;
    clearInterval(hb);
    clearTimeout(cap);
    if (listener) listeners.delete(listener);
    if (!listeners.size) grpcStop();
    conns.delete(conn);
    res.end(); // free the invocation now, even if this stream is still waiting on the backfill
    resolveDone();
  };
  req.on("close", finish);
  res.on("close", finish);
  res.on("error", finish);
  // backfill + LIVE_MS stays under maxDuration; "bye" then close makes EventSource reconnect
  const cap = setTimeout(() => { send("bye", { reconnect: true }); finish(); }, LIVE_MS + 30_000);
  const conn = { ip, finish };
  conns.add(conn);
  res.write("retry: 3000\n\n");

  try {
    // (a) backfill through Solami RPC, shared by this instance's connections for BACKFILL_TTL_MS
    send("status", { phase: "backfill", ...RPC, detail: `last ${BACKFILL} Panta transactions` });
    let streamed = false;
    if (!cache || Date.now() - cache.t > BACKFILL_TTL_MS) {
      if (!inflight) {
        streamed = true;
        inflight = backfill(key, (items, progress) => { send("items", { items }); send("status", { phase: "backfill", ...RPC, detail: progress }); })
          .then((r) => (cache = r)).finally(() => (inflight = null));
      }
      await inflight;
    }
    if (!streamed) send("items", { items: cache.items });
    const m = { ...cache.metrics, liveUpdates: 0, liveNewPositions: 0 };
    send("metrics", m);
    if (!open) return res.end();

    // (b) live through Solami gRPC
    send("status", { phase: "connecting", ...LIVE });
    const wk = cache.items.filter((i) => (i.kind === "new-position" || i.kind === "trade") && Date.now() - i.t < 7 * 86_400_000);
    const wallets = new Set(wk.map((i) => i.wallet)), markets = new Set(wk.map((i) => i.market));
    listener = (e) => {
      if (e.live) send("status", { phase: "live", ...LIVE });
      if (e.down) { send("status", { phase: "reconnecting", detail: e.down }); finish(); }
      if (!e.items) return;
      send("items", { items: e.items });
      for (const it of e.items) {
        m.liveUpdates++;
        if (it.kind === "new-position") { m.liveNewPositions++; m.newPositions24h++; m.newPositions7d++; }
        if (it.kind === "new-position" || it.kind === "trade") { m.trades7d++; wallets.add(it.wallet); markets.add(it.market); }
        if (it.kind === "dispute") m.disputes++;
        if (it.kind === "resolution") m.resolutions++;
      }
      m.uniqueWallets7d = wallets.size;
      m.marketsTouched7d = markets.size;
      send("metrics", m);
    };
    listeners.add(listener);
    if (!grpc) grpcStart(key);
    else if (grpc.live) send("status", { phase: "live", ...LIVE });
    clearTimeout(cap);
    setTimeout(() => { send("bye", { reconnect: true }); finish(); }, LIVE_MS).unref?.();
    await done;
  } catch (e) {
    send("status", { phase: "reconnecting", detail: String(e?.message ?? e).split(key).join("<key>") });
    finish();
  }
  res.end();
}
