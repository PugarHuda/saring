/**
 * Panta dispute watcher -> Saring court.
 *
 * Polls Panta's balr_market program on Solana mainnet. When a resolution is disputed
 * (`dispute_resolved_event` instruction / `MarketDisputed` event), it opens a Saring
 * court on devnet for that market and mirrors every holder of the market into the
 * court's encrypted state (record_positions_v3, 6 per MPC call), so jurors who hold a
 * position are excluded inside Arcium MPC.
 *
 *   npx ts-node --transpile-only -P tsconfig.json panta/watch.ts [--interval 20]
 *   ... panta/watch.ts --once <pantaMarket>      open a court for a market now
 *   ... panta/watch.ts --replay <signature>      process a past dispute transaction
 *
 * Env: MAINNET_RPC_URL (Panta reads), RPC_URL (devnet), wallet ~/.config/solana/id.json.
 */
import * as anchor from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  awaitComputationFinalization,
  deserializeLE,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getExecutingPoolAccAddress,
  getMempoolAccAddress,
  getMXEAccAddress,
  getMXEPublicKey,
  RescueCipher,
  x25519,
} from "@arcium-hq/client";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { decodeLogs, DISPUTE_IXS, withRetry } from "./disputes";
import { PANTA_PROGRAM, identityId, marketHolders, marketQuestion } from "./panta";
import { pickSource, RawUpdate, recentTxs } from "./sources";

const CLUSTER_OFFSET = 456;
const BATCH = 6;
const MAX_HOLDERS = 42;
const STATE = path.join(__dirname, "out", "watch-state.json");
const ex = (kind: "tx" | "address", id: string, cluster = "devnet") =>
  `https://explorer.solana.com/${kind}/${id}${cluster === "devnet" ? "?cluster=devnet" : ""}`;

const mainnet = new Connection(process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const devnet = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const owner = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8"))));
const provider = new anchor.AnchorProvider(devnet, new anchor.Wallet(owner), { commitment: "confirmed" });
const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "blindcourt.json"), "utf8"));
const program = new anchor.Program(idl, provider) as any;

const queueAccounts = (circuit: string, offset: anchor.BN) => ({
  computationAccount: getComputationAccAddress(CLUSTER_OFFSET, offset),
  clusterAccount: getClusterAccAddress(CLUSTER_OFFSET),
  mxeAccount: getMXEAccAddress(program.programId),
  mempoolAccount: getMempoolAccAddress(CLUSTER_OFFSET),
  executingPool: getExecutingPoolAccAddress(CLUSTER_OFFSET),
  compDefAccount: getCompDefAccAddress(program.programId, Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE()),
});

// Same as tests/blindcourt.ts: confirm by polling over HTTP, not .rpc() (websocket can hang).
async function send(builder: any): Promise<string> {
  const tx: Transaction = await builder.transaction();
  const { blockhash, lastValidBlockHeight } = await devnet.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = owner.publicKey;
  tx.sign(owner);
  const raw = tx.serialize();
  const sig = await devnet.sendRawTransaction(raw, { skipPreflight: true });
  while ((await devnet.getBlockHeight("confirmed")) <= lastValidBlockHeight) {
    const st = (await devnet.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    await devnet.sendRawTransaction(raw, { skipPreflight: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`tx ${sig} expired`);
}

/** Queues one MPC computation and waits for its callback. Returns the queue tx signature. */
async function run(circuit: string, build: (offset: anchor.BN) => any): Promise<string> {
  const offset = new anchor.BN(randomBytes(8), "hex");
  const sig = await send(build(offset).accountsPartial(queueAccounts(circuit, offset)));
  await awaitComputationFinalization(provider, offset, program.programId, "confirmed", 300_000);
  return sig;
}

async function mxeKey(): Promise<Uint8Array> {
  for (let i = 0; i < 20; i++) {
    const k = await getMXEPublicKey(provider, program.programId).catch(() => null);
    if (k) return k;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("MXE public key unavailable");
}

/** Opens a Saring court for a Panta market on devnet and mirrors its holders into it. */
export async function openCourt(market: string, reason: string) {
  console.log(`\n[${new Date().toISOString()}] ${reason}`);
  console.log(`Panta market: ${market}  ${ex("address", market, "mainnet")}`);
  const question = await marketQuestion(mainnet, market);
  const all = await marketHolders(mainnet, market);
  // ponytail: cap at 42 holders (court state size); larger markets need a bigger court account.
  const holders = all.slice(0, MAX_HOLDERS);
  console.log(`question: "${question}"`);
  console.log(`${all.length} holder wallets on mainnet${all.length > MAX_HOLDERS ? ` (mirroring first ${MAX_HOLDERS})` : ""}`);

  for (const c of ["init_court_v3", "record_positions_v3"]) {
    const addr = getCompDefAccAddress(program.programId, Buffer.from(getCompDefAccOffset(c)).readUInt32LE());
    if (!(await devnet.getAccountInfo(addr))) throw new Error(`comp def ${c} not initialized on devnet; run the test suite once`);
  }
  const before = await devnet.getBalance(owner.publicKey);
  const id = Math.floor(Math.random() * 2 ** 31);
  const idBuf = Buffer.alloc(4);
  idBuf.writeUInt32LE(id);
  const [court] = PublicKey.findProgramAddressSync([Buffer.from("court"), owner.publicKey.toBuffer(), idBuf], program.programId);

  const label = `panta:${market}`; // court.market (<=64 chars) links the verdict back to the Panta event
  const createSig = await run("init_court_v3", (o) => program.methods.createCourt(o, id, label));
  console.log(`court opened: ${court.toBase58()} (id ${id})`);
  console.log(`  court  ${ex("address", court.toBase58())}`);
  console.log(`  tx     ${ex("tx", createSig)}`);

  const priv = new Uint8Array(randomBytes(32));
  const pub = x25519.getPublicKey(priv);
  const shared = new RescueCipher(x25519.getSharedSecret(priv, await mxeKey()));
  const ids = await Promise.all(holders.map((h) => identityId(h.owner)));
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    while (batch.length < BATCH) batch.push(0);
    const nonce = randomBytes(16);
    const ct = shared.encrypt(batch.map(BigInt), nonce);
    const sig = await run("record_positions_v3", (o) =>
      program.methods
        .recordPositions(o, id, ct.map((c) => Array.from(c)), Array.from(pub), new anchor.BN(deserializeLE(nonce).toString()))
        .accountsPartial({ authority: owner.publicKey, courtAcc: court })
    );
    console.log(`  mirrored holders ${i + 1}-${Math.min(i + BATCH, ids.length)} (encrypted)  ${ex("tx", sig)}`);
  }
  const spent = (before - (await devnet.getBalance(owner.publicKey))) / 1e9;
  console.log(`done: court ${court.toBase58()} holds ${ids.length} encrypted Panta positions; devnet SOL spent ${spent.toFixed(5)}`);
  console.log(`next: seat jurors (add_juror_v3), cast_v3, resolve_v3 -> verdict -> Panta resolve_event(yes_wins = court.yes > court.no)`);
  return { court: court.toBase58(), id, holders: ids.length };
}

/** Panta markets disputed in a transaction (MarketDisputed events, else dispute_resolved_event's `event` account). */
async function disputedMarkets(signature: string): Promise<string[]> {
  const tx = await withRetry(() => mainnet.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 }));
  if (!tx?.meta?.logMessages || tx.meta.err) return [];
  const { ixs, events } = decodeLogs(tx.meta.logMessages);
  const fromEvents = events.filter((e) => e.name === "MarketDisputed").map((e) => e.data.event as string);
  if (fromEvents.length) return [...new Set(fromEvents)];
  if (!ixs.some((x) => DISPUTE_IXS.includes(x))) return [];
  // accounts: disputer, market_config, event, review_request, ...
  return tx.transaction.message.instructions
    .filter((ix: any) => ix.programId.equals(PANTA_PROGRAM) && ix.accounts?.length >= 3)
    .map((ix: any) => ix.accounts[2].toBase58());
}

const FEED = path.join(__dirname, "out", "live-feed.jsonl");
const POSITION_DISC = Buffer.from(require("./balr_market.json").accounts.find((a: any) => a.name === "UserPosition").discriminator);
// Panta events that create or change a position: [event name, wallet field(s)]
const POSITION_EVENTS: Record<string, string[]> = {
  SharesMinted: ["user"], PrimaryOrderPlaced: ["user"], SecondaryOrderPlaced: ["user"], OrderMatched: ["buyer", "seller"],
};

/** Appends one event to out/live-feed.jsonl (read by the web panel) and echoes it. */
function feed(e: Record<string, any>) {
  const line = { ts: new Date().toISOString(), ...e };
  fs.appendFileSync(FEED, JSON.stringify(line) + "\n");
  console.log(`[${line.ts}] ${e.text}`);
}

const parseWindow = (s: string) => {
  const m = s.match(/^(\d+)([mhd])$/);
  if (!m) throw new Error(`--backfill takes 90m / 24h / 7d, got ${s}`);
  return Number(m[1]) * { m: 60, h: 3600, d: 86400 }[m[2] as "m" | "h" | "d"];
};

/**
 * --backfill <window> first replays the window's Panta txs (Solami RPC when SOLAMI_API_KEY is set)
 * into the feed without opening courts for old disputes, then follows the live source.
 */
async function watch(intervalSec: number, backfillSec: number) {
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { lastSig: null, handled: {} };
  const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  const seen = new Set<string>(); // position accounts / (market,wallet) pairs already reported this run

  async function handle(u: RawUpdate & { blockTime?: number; keys?: string[]; preBalances?: number[]; postBalances?: number[] }, source: string, courts: boolean) {
    const chainTime = u.blockTime ? new Date(u.blockTime * 1000).toISOString() : undefined;
    if (u.type === "account") {
      const d = u.data;
      if (d.length !== 202 || !d.subarray(0, 8).equals(POSITION_DISC)) return;
      const market = new PublicKey(d.subarray(9, 41)).toBase58(), wallet = new PublicKey(d.subarray(41, 73)).toBase58();
      const isNew = !seen.has(u.pubkey);
      seen.add(u.pubkey);
      feed({ kind: "position", source, slot: u.slot, account: u.pubkey, market, wallet,
        text: `${isNew ? "new" : "changed"} position in market ${market} by wallet ${wallet}` });
      return;
    }
    const { ixs, events } = decodeLogs(u.logs);
    const inTx = new Set<string>(); // one feed line per (market, wallet) per tx: a buy emits SharesMinted + PrimaryOrderPlaced
    for (const e of events) for (const f of POSITION_EVENTS[e.name] ?? []) {
      const market = e.data.event, wallet = e.data[f];
      if (inTx.has(market + wallet)) continue;
      inTx.add(market + wallet);
      let isNew = !seen.has(market + wallet);
      if (u.keys && u.preBalances && u.postBalances) {
        // exact: the UserPosition PDA was created (0 -> rent lamports) in this tx
        const [pda] = PublicKey.findProgramAddressSync([Buffer.from("position"), new PublicKey(market).toBuffer(), new PublicKey(wallet).toBuffer()], PANTA_PROGRAM);
        const i = u.keys.indexOf(pda.toBase58());
        isNew = i >= 0 && u.preBalances[i] === 0 && u.postBalances[i] > 0;
      }
      seen.add(market + wallet);
      feed({ kind: "position", source, slot: u.slot, chainTime, signature: u.signature, event: e.name, market, wallet,
        text: `${isNew ? "new" : "changed"} position in market ${market} by wallet ${wallet} (${e.name})` });
    }
    let disputed = events.filter((e) => e.name === "MarketDisputed").map((e) => e.data.event as string);
    if (!disputed.length && ixs.some((x) => DISPUTE_IXS.includes(x))) disputed = await disputedMarkets(u.signature);
    for (const m of new Set(disputed)) {
      feed({ kind: "dispute", source, slot: u.slot, chainTime, signature: u.signature, market: m,
        bond_lamports: events.find((e) => e.name === "MarketDisputed")?.data.bond_lamports ?? null,
        text: `MarketDisputed on ${m} (${ex("tx", u.signature, "mainnet")})` });
      if (!courts || state.handled[m]) continue;
      const r = await openCourt(m, `MarketDisputed in ${ex("tx", u.signature, "mainnet")}`);
      state.handled[m] = { ...r, disputeTx: u.signature, at: new Date().toISOString() };
      save();
      feed({ kind: "court", market: m, court: r.court, holders: r.holders, text: `Saring court ${r.court} opened for ${m} (${r.holders} holders mirrored)` });
    }
  }

  if (backfillSec) {
    const key = process.env.SOLAMI_API_KEY;
    const conn = key ? new Connection(`https://rpc.solami.dev/sol?api_key=${key}`, "confirmed") : mainnet;
    const name = key ? "Solami RPC backfill (rpc.solami.dev)" : "RPC backfill";
    console.log(`backfilling the last ${backfillSec}s of Panta txs via ${name}`);
    let n = 0;
    for await (const u of recentTxs(conn, Math.floor(Date.now() / 1000) - backfillSec)) { await handle(u, name, false); n++; }
    console.log(`backfill done: ${n} txs`);
  }
  const source = pickSource(mainnet, intervalSec, state, save);
  console.log(`watching Panta ${PANTA_PROGRAM.toBase58()} on mainnet via ${source.name}; feed -> ${FEED}`);
  for await (const u of source.updates) await handle(u, source.name, true);
}

async function main() {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const arg = (f: string) => (process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : undefined);
  const once = arg("--once");
  const replay = arg("--replay");
  if (once) {
    await openCourt(once, "--once: opening a court for a Panta market replayed as a dispute (no live dispute required)");
  } else if (replay) {
    const markets = await disputedMarkets(replay);
    if (!markets.length) throw new Error(`${replay} is not a Panta dispute transaction`);
    for (const m of markets) await openCourt(m, `--replay of dispute tx ${ex("tx", replay, "mainnet")}`);
  } else {
    const back = arg("--backfill");
    await watch(Number(arg("--interval") ?? 20), back ? parseWindow(back) : 0);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
