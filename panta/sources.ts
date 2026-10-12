/**
 * Pluggable mainnet event sources for panta/watch.ts and panta/solami-stats.ts. Each yields:
 *   { type: "tx", signature, slot, logs }        a successful transaction touching Panta
 *   { type: "account", pubkey, slot, data }      a 202-byte Panta account (UserPosition) changed
 *
 * pickSource(): SOLAMI_API_KEY unset -> polling; else SOLAMI_TRANSPORT selects
 *   grpc (default) Solami Yellowstone gRPC https://grpc.solami.dev, header x-token: KEY,
 *                 /geyser.Geyser/Subscribe over raw HTTP/2 (hand-encoded protobuf, no deps)
 *   ws            Solami RPC WebSocket wss://ws.solami.dev/ws/sol?api_key=KEY
 *                 logsSubscribe({mentions:[Panta]}) + programSubscribe(Panta, dataSize 202)
 *   mirage        Solami Mirage wss://ws.solami.dev/mirage/stream/{id}?api_key=KEY, binary
 *                 Yellowstone SubscribeUpdate frames; subscription from POST api.solami.dev/mirage/create
 * Docs: https://solami.dev/docs (mirage, grpc, api-keys, endpoints pages).
 */
import { Connection } from "@solana/web3.js";
import bs58 from "bs58";
import * as fs from "fs";
import * as path from "path";
import WebSocket from "ws";
import { withRetry } from "./disputes";
import { PANTA_PROGRAM } from "./panta";

export type RawUpdate =
  | { type: "tx"; signature: string; slot: number; logs: string[] }
  | { type: "account"; pubkey: string; slot: number; data: Buffer };
export type Source = { name: string; updates: AsyncGenerator<RawUpdate> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- polling (MAINNET_RPC_URL) ----------

export function pollingSource(mainnet: Connection, intervalSec: number, state: { lastSig?: string | null }, save: () => void): Source {
  async function* updates(): AsyncGenerator<RawUpdate> {
    if (!state.lastSig) {
      state.lastSig = (await mainnet.getSignaturesForAddress(PANTA_PROGRAM, { limit: 1 }))[0]?.signature;
      save();
    }
    for (;;) {
      try {
        // ponytail: >1000 new txs in one interval would skip the oldest; shorten --interval if Panta gets that busy.
        const sigs = await withRetry(() => mainnet.getSignaturesForAddress(PANTA_PROGRAM, { until: state.lastSig!, limit: 1000 }));
        const ok = sigs.filter((s) => !s.err).reverse();
        for (let i = 0; i < ok.length; i += 10) {
          const txs = await withRetry(() =>
            mainnet.getParsedTransactions(ok.slice(i, i + 10).map((s) => s.signature), { maxSupportedTransactionVersion: 0 })
          );
          for (const tx of txs)
            if (tx?.meta?.logMessages) yield { type: "tx", signature: tx.transaction.signatures[0], slot: tx.slot, logs: tx.meta.logMessages };
        }
        if (sigs.length) {
          state.lastSig = sigs[0].signature;
          save();
        }
      } catch (e) {
        console.error("poll error:", e);
      }
      await sleep(intervalSec * 1000);
    }
  }
  return { name: `polling MAINNET_RPC_URL every ${intervalSec}s`, updates: updates() };
}

// ---------- Solami Mirage (Yellowstone over WebSocket) ----------

const MIRAGE_API = "https://api.solami.dev";
const MIRAGE_WS = "wss://ws.solami.dev/mirage/stream";
const MIRAGE_STATE = path.join(__dirname, "out", "solami-mirage.json");

/**
 * Saved Mirage subscription for Panta transactions: SOLAMI_MIRAGE_ID if set, else the one we
 * created earlier, else POST /mirage/create (needs MirageManage; docs authenticate it with
 * "Authorization: Bearer <token>", so SOLAMI_SESSION_TOKEN is used when set, else the API key).
 */
async function mirageSubscription(key: string): Promise<string> {
  if (process.env.SOLAMI_MIRAGE_ID) return process.env.SOLAMI_MIRAGE_ID;
  if (fs.existsSync(MIRAGE_STATE)) return JSON.parse(fs.readFileSync(MIRAGE_STATE, "utf8")).id;
  const res = await fetch(`${MIRAGE_API}/mirage/create`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SOLAMI_SESSION_TOKEN ?? key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      label: "saring: panta balr_market",
      // Transaction filters must name accounts; account-state filters take addresses, not owners,
      // so position changes are read from the decoded Panta events in each transaction instead.
      filter: { account_include: [PANTA_PROGRAM.toBase58()], vote: false, failed: false, commitment: "confirmed" },
    }),
  });
  if (!res.ok) throw new Error(`POST /mirage/create -> ${res.status} ${await res.text()} (create one in the Solami dashboard and set SOLAMI_MIRAGE_ID)`);
  const sub = await res.json();
  fs.mkdirSync(path.dirname(MIRAGE_STATE), { recursive: true });
  fs.writeFileSync(MIRAGE_STATE, JSON.stringify(sub, null, 2));
  return sub.id;
}

// Minimal protobuf reader for the SubscribeUpdate fields we use
// (field numbers from yellowstone-grpc-proto geyser.proto / solana-storage.proto).
type Fields = Map<number, (bigint | Buffer)[]>;
export function pbFields(buf: Buffer): Fields {
  const out: Fields = new Map();
  let i = 0;
  const varint = () => {
    let v = 0n, s = 0n;
    for (;;) {
      const b = buf[i++];
      v |= BigInt(b & 0x7f) << s;
      if (b < 0x80) return v;
      s += 7n;
    }
  };
  while (i < buf.length) {
    const tag = Number(varint());
    const f = tag >>> 3, wt = tag & 7;
    let v: bigint | Buffer;
    if (wt === 0) v = varint();
    else if (wt === 2) { const n = Number(varint()); v = buf.subarray(i, i + n); i += n; }
    else if (wt === 1) { v = buf.readBigUInt64LE(i); i += 8; }
    else if (wt === 5) { v = BigInt(buf.readUInt32LE(i)); i += 4; }
    else throw new Error(`unsupported wire type ${wt}`);
    if (!out.has(f)) out.set(f, []);
    out.get(f)!.push(v);
  }
  return out;
}
const one = (m: Fields, f: number) => m.get(f)?.[0];
const sub = (m: Fields, f: number) => { const b = one(m, f); return Buffer.isBuffer(b) ? pbFields(b) : undefined; };

/** SubscribeUpdate frame -> RawUpdate (null for ping/slot/etc. and failed txs). */
export function decodeSubscribeUpdate(frame: Buffer): RawUpdate | null {
  const u = pbFields(frame);
  const acc = sub(u, 2); // SubscribeUpdateAccount
  if (acc) {
    const info = sub(acc, 1)!; // SubscribeUpdateAccountInfo
    return { type: "account", pubkey: bs58.encode(one(info, 1) as Buffer), slot: Number(one(acc, 2) ?? 0n), data: Buffer.from((one(info, 6) as Buffer) ?? []) };
  }
  const txu = sub(u, 4); // SubscribeUpdateTransaction
  if (!txu) return null;
  const info = sub(txu, 1)!; // SubscribeUpdateTransactionInfo
  const meta = sub(info, 4); // TransactionStatusMeta
  if (!meta || meta.has(1)) return null; // err set -> failed tx
  const logs = (meta.get(6) ?? []).map((b) => (b as Buffer).toString("utf8"));
  return { type: "tx", signature: bs58.encode(one(info, 1) as Buffer), slot: Number(one(txu, 2) ?? 0n), logs };
}

export function mirageSource(key: string): Source {
  async function* updates(): AsyncGenerator<RawUpdate> {
    const id = await mirageSubscription(key);
    for (let attempt = 0; ; attempt++) {
      const queue: RawUpdate[] = [];
      let wake: () => void = () => {};
      let closed: { code: number; reason: string } | null = null;
      const ws = new WebSocket(`${MIRAGE_WS}/${id}?api_key=${encodeURIComponent(key)}`);
      ws.binaryType = "nodebuffer";
      ws.on("open", () => { attempt = 0; console.log(`Mirage stream ${id} connected`); });
      ws.on("message", (d: Buffer) => { const u = decodeSubscribeUpdate(d); if (u) { queue.push(u); wake(); } });
      ws.on("error", (e) => console.error("Mirage error:", e.message));
      ws.on("close", (code, reason) => { closed = { code, reason: reason.toString() }; wake(); });
      while (!closed || queue.length) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        while (queue.length) yield queue.shift()!;
      }
      const c = closed as { code: number; reason: string };
      // 4029 = connection/stream limit, 4002 = bandwidth and balance empty: retrying won't help.
      if (c.code === 4029 || c.code === 4002) throw new Error(`Mirage closed ${c.code} ${c.reason}`);
      const wait = Math.min(30_000, 1000 * 2 ** attempt);
      console.error(`Mirage closed ${c.code} ${c.reason}; reconnecting in ${wait}ms`);
      await sleep(wait);
    }
  }
  return { name: "Solami Mirage (wss://ws.solami.dev/mirage/stream)", updates: updates() };
}

// ---------- Solami Yellowstone gRPC (raw HTTP/2, no grpc dependency) ----------

// protobuf writers for the SubscribeRequest fields we send (geyser.proto)
const pbVarint = (n: number) => { const o: number[] = []; while (n > 0x7f) { o.push((n & 0x7f) | 0x80); n >>>= 7; } o.push(n); return Buffer.from(o); };
const pbLen = (f: number, b: Buffer) => Buffer.concat([pbVarint((f << 3) | 2), pbVarint(b.length), b]);
const pbStr = (f: number, s: string) => pbLen(f, Buffer.from(s));
const pbInt = (f: number, n: number) => Buffer.concat([pbVarint(f << 3), pbVarint(n)]);
const mapEntry = (f: number, key: string, value: Buffer) => pbLen(f, Buffer.concat([pbStr(1, key), pbLen(2, value)]));
const grpcFrame = (msg: Buffer) => { const h = Buffer.alloc(5); h.writeUInt32BE(msg.length, 1); return Buffer.concat([h, msg]); };

/** SubscribeRequest: Panta transactions (vote/failed off) + every 202-byte Panta account, CONFIRMED. */
export function pantaSubscribeRequest(program = PANTA_PROGRAM.toBase58(), dataSize = 202, fromSlot = 0): Buffer {
  const P = program;
  return Buffer.concat([
    mapEntry(3, "panta", Buffer.concat([pbInt(1, 0), pbInt(2, 0), pbStr(3, P)])), // transactions
    mapEntry(1, "positions", Buffer.concat([pbStr(3, P), dataSize ? pbLen(4, pbInt(2, dataSize)) : Buffer.alloc(0)])), // accounts: owner + datasize
    pbInt(6, 1), // commitment CONFIRMED
    fromSlot ? pbInt(11, fromSlot) : Buffer.alloc(0), // from_slot: replay up to 3,500 slots back
  ]);
}

/** fromSlot (or SOLAMI_FROM_SLOT) replays history first; reconnects resume from the last slot seen. */
export function grpcSource(key: string, fromSlot = Number(process.env.SOLAMI_FROM_SLOT ?? 0)): Source {
  async function* updates(): AsyncGenerator<RawUpdate> {
    const http2 = await import("http2");
    for (let attempt = 0; ; attempt++) {
      const queue: RawUpdate[] = [];
      let wake: () => void = () => {};
      let ended: string | null = null;
      const session = http2.connect(process.env.SOLAMI_GRPC_URL ?? "https://grpc.solami.dev");
      session.on("error", (e) => { ended = `session error: ${e.message}`; wake(); });
      const req = session.request({
        ":method": "POST", ":path": "/geyser.Geyser/Subscribe",
        "content-type": "application/grpc", te: "trailers", "x-token": key,
      });
      let buf = Buffer.alloc(0);
      let frames = 0;
      req.on("response", (h) => { console.log(`Solami gRPC response :status ${h[":status"]}`); if (h["grpc-status"] && h["grpc-status"] !== "0") { ended = `grpc-status ${h["grpc-status"]} ${h["grpc-message"] ?? ""}`; wake(); } });
      req.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 5 && buf.length >= 5 + buf.readUInt32BE(1)) {
          const n = buf.readUInt32BE(1);
          const u = decodeSubscribeUpdate(buf.subarray(5, 5 + n));
          buf = buf.subarray(5 + n);
          if (++frames === 1) console.log("Solami gRPC stream live (first SubscribeUpdate frame received)");
          if (u) { queue.push(u); panta++; attempt = 0; fromSlot = Math.max(fromSlot, u.slot); }
        }
        wake();
      });
      req.on("trailers", (t) => { ended = `grpc-status ${t["grpc-status"]} ${decodeURIComponent(String(t["grpc-message"] ?? ""))}`; wake(); });
      req.on("close", () => { ended = ended ?? "stream closed"; wake(); });
      req.write(grpcFrame(pantaSubscribeRequest(undefined, undefined, fromSlot)));
      // keepalive: a ping-only SubscribeRequest every 10s does not touch the filters
      let pingId = 0;
      let panta = 0;
      const pinger = setInterval(() => {
        req.write(grpcFrame(pbLen(9, pbInt(1, ++pingId))));
        if (pingId % 6 === 0) console.log(`[${new Date().toISOString()}] Solami gRPC alive: ${frames} frames, ${panta} Panta updates on this connection`);
      }, 10_000);
      console.log(`Solami gRPC Subscribe sent (transactions + accounts of Panta${fromSlot ? `, from_slot ${fromSlot}` : ""})`);
      while (!ended || queue.length) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        while (queue.length) yield queue.shift()!;
      }
      clearInterval(pinger);
      session.close();
      const why = ended as string;
      // grpc-status 7 PERMISSION_DENIED / 16 UNAUTHENTICATED: plan or key problem, retrying won't help
      if (/grpc-status (7|16)\b/.test(why)) throw new Error(`Solami gRPC refused: ${why}`);
      // 11 OUT_OF_RANGE "from N is not available, last available: M": replay from M instead
      const oldest = why.match(/grpc-status 11 .*last available: (\d+)/);
      if (oldest) { fromSlot = Number(oldest[1]) + 10; attempt = 0; continue; }
      const wait = Math.min(30_000, 1000 * 2 ** attempt);
      console.error(`Solami gRPC ${why}; reconnecting in ${wait}ms`);
      await sleep(wait);
    }
  }
  return { name: "Solami Yellowstone gRPC (grpc.solami.dev)", updates: updates() };
}

// ---------- Solami RPC WebSocket (logsSubscribe + programSubscribe) ----------

/** Standard Solana PubSub on wss://ws.solami.dev/ws/sol: Panta logs and every 202-byte Panta account. */
export function solamiWsSource(key: string): Source {
  async function* updates(): AsyncGenerator<RawUpdate> {
    for (let attempt = 0; ; attempt++) {
      const queue: RawUpdate[] = [];
      let wake: () => void = () => {};
      let closed: string | null = null;
      const ws = new WebSocket(`wss://ws.solami.dev/ws/sol?api_key=${encodeURIComponent(key)}`);
      const subs = new Map<number, "logs" | "program">();
      ws.on("open", () => {
        const P = PANTA_PROGRAM.toBase58();
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [P] }, { commitment: "confirmed" }] }));
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "programSubscribe", params: [P, { encoding: "base64", commitment: "confirmed", filters: [{ dataSize: 202 }] }] }));
      });
      const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.ping(), 20_000);
      ws.on("message", (raw: Buffer) => {
        const m = JSON.parse(raw.toString());
        if (m.id === 1 || m.id === 2) {
          if (m.error) { closed = `subscribe error ${JSON.stringify(m.error)}`; ws.close(); }
          else { subs.set(m.result, m.id === 1 ? "logs" : "program"); attempt = 0; console.log(`Solami WebSocket ${m.id === 1 ? "logsSubscribe" : "programSubscribe"} ok`); }
        } else if (m.method === "logsNotification") {
          const v = m.params.result.value;
          if (!v.err) queue.push({ type: "tx", signature: v.signature, slot: m.params.result.context.slot, logs: v.logs });
        } else if (m.method === "programNotification") {
          const r = m.params.result;
          queue.push({ type: "account", pubkey: r.value.pubkey, slot: r.context.slot, data: Buffer.from(r.value.account.data[0], "base64") });
        }
        wake();
      });
      ws.on("error", (e) => console.error("Solami WebSocket error:", e.message));
      ws.on("close", (code) => { closed = closed ?? `closed ${code}`; wake(); });
      while (!closed || queue.length) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        while (queue.length) yield queue.shift()!;
      }
      clearInterval(ping);
      const wait = Math.min(30_000, 1000 * 2 ** attempt);
      console.error(`Solami WebSocket ${closed}; reconnecting in ${wait}ms`);
      await sleep(wait);
    }
  }
  return { name: "Solami WebSocket (wss://ws.solami.dev/ws/sol)", updates: updates() };
}

/** SOLAMI_API_KEY unset -> polling; else SOLAMI_TRANSPORT = grpc (default) | ws | mirage. */
export function pickSource(mainnet: Connection, intervalSec: number, state: { lastSig?: string | null }, save: () => void): Source {
  const key = process.env.SOLAMI_API_KEY;
  if (!key) return pollingSource(mainnet, intervalSec, state, save);
  const t = process.env.SOLAMI_TRANSPORT ?? "grpc";
  if (t === "ws") return solamiWsSource(key);
  if (t === "mirage") return mirageSource(key);
  return grpcSource(key);
}

// ---------- backfill (any RPC; Solami's caps getSignaturesForAddress at < 1000 per page) ----------

/** Successful Panta transactions since `sinceSec` (unix), oldest first, with full account keys. */
export async function* recentTxs(conn: Connection, sinceSec: number): AsyncGenerator<RawUpdate & { type: "tx"; keys: string[]; blockTime: number; preBalances: number[]; postBalances: number[] }> {
  const sigs: string[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await withRetry(() => conn.getSignaturesForAddress(PANTA_PROGRAM, { before, limit: 100 }));
    const inWin = page.filter((s) => (s.blockTime ?? 0) >= sinceSec);
    sigs.push(...inWin.filter((s) => !s.err).map((s) => s.signature));
    if (page.length < 100 || inWin.length < page.length) break;
    before = page[page.length - 1].signature;
  }
  sigs.reverse();
  for (let i = 0; i < sigs.length; i += 10) {
    // json encoding: Solami's jsonParsed inner instructions don't match web3.js's response schema
    const txs = await withRetry(() => conn.getTransactions(sigs.slice(i, i + 10), { maxSupportedTransactionVersion: 0 }));
    for (const tx of txs) {
      if (!tx?.meta?.logMessages) continue;
      const keys = tx.transaction.message
        .getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined })
        .keySegments().flat().map((k) => k.toBase58());
      yield { type: "tx", signature: tx.transaction.signatures[0], slot: tx.slot, logs: tx.meta.logMessages, keys,
        blockTime: tx.blockTime ?? 0, preBalances: tx.meta.preBalances, postBalances: tx.meta.postBalances };
    }
    await sleep(1000); // free tier: 10 RPS
  }
}
