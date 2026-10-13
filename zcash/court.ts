/**
 * The Saring side on Solana devnet (program 3CeQ1DQY…, Arcium MPC), wired to Zcash bonds.
 *
 *   ts-node zcash/court.ts open "<question>"
 *   ts-node zcash/court.ts seat <court> [--conflicted <juror>] [--noshow <juror>]
 *
 * `seat` reads out/allowlist-<court>.json (verify-bonds.ts) and seats only bonded
 * commitments. Each add_juror transaction carries an SPL memo signed by the juror's
 * per-court seat key (the one named in its bond memo):
 *     saring-seat:<commitment>:<sha256("saring-ua:<court>:<commitment>:<payout address>")>
 * so the payout address is committed on chain, by the juror, atomically with seating.
 * Each cast transaction carries "saring-cast:<commitment>", signed by the same seat key,
 * so who voted (not how) is public. In the scripted dispute the `--conflicted` juror
 * holds a position and votes YES (MPC drops it); the `--noshow` juror never casts;
 * everyone else votes NO.
 *
 * Private record (ballot keys, who is conflicted): ~/.saring-zcash/court-<court>.json.
 * Public record: zcash/out/court-<court>.json.
 */
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import idl from "../sdk/src/idl/blindcourt.json";
import { SARING_PROGRAM_ID, SaringClient, type SaringSigner, newBallotKey } from "../sdk/src/index";
import { seatKey } from "./bond";
import { HOME, OUT, castMemo, commitment, orchardReceiver, readJurors, seatMemo, uaCommit, writeOut } from "./zec";

// The public devnet RPC answers courtLog's per-signature getTransaction loop with 429, so fall back to RPC_URL in ../.env.local.
const envLocalRpc = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, "../.env.local"), "utf8").match(/^RPC_URL=(.+)$/m)?.[1].trim();
  } catch {
    return undefined;
  }
})();
export const rpc = process.env.SOLANA_RPC_URL ?? process.env.RPC_URL ?? envLocalRpc ?? "https://api.devnet.solana.com";
const tx = (s: string) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export interface PrivateCourt {
  courtId: number;
  court: string;
  seated: { name: string; commitment: string; jurorId: number; key: number; conflicted: boolean; noShow: boolean }[];
  notSeated: { name: string; commitment: string; reason: string }[];
}
export const privateCourtFile = (court: string) => path.join(HOME, `court-${court}.json`);

/** Signer that appends a memo signed by `seat` to every transaction the operator pays for. */
function withSeatMemo(owner: Keypair, seat: Keypair, memo: string): SaringSigner {
  return {
    publicKey: owner.publicKey,
    async signTransaction<T>(t: T): Promise<T> {
      const lt = t as unknown as Transaction;
      lt.add(new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: seat.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(memo) }));
      lt.partialSign(owner, seat);
      return t;
    },
  };
}

export interface CourtLog {
  /** commitment -> the seat memo of the first successful add_juror tx that carried one. */
  seats: Map<string, { seatKey: string; uaCommit: string; sig: string; time: number }>;
  /** commitment -> successful cast txs signed by that commitment's seat key. */
  casts: Map<string, string[]>;
}

/**
 * Rebuilds seats and casts for a court from Solana alone: every successful transaction
 * that touched the court account, keeping a memo only if it sits in an add_juror / cast
 * instruction's own transaction and its single account (the seat key) signed it.
 */
export async function courtLog(conn: Connection, court: string): Promise<CourtLog> {
  const disc = (n: string) => Buffer.from(idl.instructions.find((i) => i.name === n)!.discriminator);
  const [SEAT, CAST] = [disc("add_juror"), disc("cast")];
  const sigs = [];
  for (let before: string | undefined; ; ) {
    const page = await conn.getSignaturesForAddress(new PublicKey(court), { before, limit: 1000 }, "confirmed");
    sigs.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  const log: CourtLog = { seats: new Map(), casts: new Map() };
  for (const s of sigs.reverse()) {
    if (s.err) continue;
    const t = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!t || t.meta?.err) continue;
    const msg = t.transaction.message;
    const keys = msg.getAccountKeys({ accountKeysFromLookups: t.meta?.loadedAddresses });
    let kind: "seat" | "cast" | null = null;
    const memos: { text: string; signer: string }[] = [];
    for (const ix of msg.compiledInstructions) {
      const prog = keys.get(ix.programIdIndex)!;
      const d = Buffer.from(ix.data);
      if (prog.equals(SARING_PROGRAM_ID)) kind = d.subarray(0, 8).equals(SEAT) ? "seat" : d.subarray(0, 8).equals(CAST) ? "cast" : kind;
      if (prog.equals(MEMO_PROGRAM_ID) && ix.accountKeyIndexes.length === 1 && msg.isAccountSigner(ix.accountKeyIndexes[0]))
        memos.push({ text: d.toString("utf8"), signer: keys.get(ix.accountKeyIndexes[0])!.toBase58() });
    }
    for (const m of memos) {
      const seat = kind === "seat" ? /^saring-seat:([0-9a-f]{64}):([0-9a-f]{64})$/.exec(m.text) : null;
      const cast = kind === "cast" ? /^saring-cast:([0-9a-f]{64})$/.exec(m.text) : null;
      if (seat && !log.seats.has(seat[1])) log.seats.set(seat[1], { seatKey: m.signer, uaCommit: seat[2], sig: s.signature, time: t.blockTime ?? 0 });
      if (cast && log.seats.get(cast[1])?.seatKey === m.signer) log.casts.set(cast[1], [...(log.casts.get(cast[1]) ?? []), s.signature]);
    }
  }
  return log;
}

async function main() {
  const [cmd, a, ...rest] = process.argv.slice(2);
  const flag = (f: string) => (rest.includes(f) ? rest[rest.indexOf(f) + 1] : undefined);
  const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
  const conn = new Connection(rpc, "confirmed");
  if (!(await conn.getGenesisHash()).startsWith("EtWTRABZaYq6iMfeYKouRu166VU2xqa1")) throw new Error("RPC is not Solana devnet");
  const saring = new SaringClient(conn, owner);

  if (cmd === "open") {
    const r = await saring.openCourt(a ?? "Saring x Zcash: bonded jury demo");
    const pub = { courtId: r.courtId, court: r.court.toBase58(), question: a, open: { queue: tx(r.queueSig), callback: tx(r.callbackSig) } };
    writeOut(`court-${pub.court}.json`, pub);
    console.log(JSON.stringify(pub, null, 2));
    return;
  }

  if (cmd !== "seat" || !a) throw new Error('usage: court.ts open "<question>" | court.ts seat <court> [--conflicted <juror>] [--noshow <juror>]');
  const court = new PublicKey(a).toBase58();
  const pub = JSON.parse(fs.readFileSync(path.join(OUT, `court-${court}.json`), "utf8"));
  const allow = JSON.parse(fs.readFileSync(path.join(OUT, `allowlist-${court}.json`), "utf8"));
  const bondSeat = new Map<string, string>(allow.bonds.map((b: any) => [b.commitment, b.seatKey]));
  const priv: PrivateCourt = { courtId: pub.courtId, court, seated: [], notSeated: [] };
  const log: Record<string, string> = {};
  const seatKeys = new Map<string, Keypair>();

  for (const j of readJurors()) {
    const c = commitment(j.jurorId, j.salt, court);
    if (!allow.allowlist.includes(c)) {
      priv.notSeated.push({ name: j.name, commitment: c, reason: "no shielded bond for this court" });
      console.log(`skip ${j.name}: no bond`);
      continue;
    }
    const sk = seatKey(j.name, court);
    if (bondSeat.get(c) !== sk.publicKey.toBase58()) throw new Error(`${j.name}: seat key differs from the one in its bond memo`);
    seatKeys.set(c, sk);
    const key = newBallotKey();
    // the juror co-signs its own seat memo; the operator only pays the fee
    const r = await new SaringClient(conn, withSeatMemo(owner, sk, seatMemo(c, uaCommit(court, c, orchardReceiver(j.ua))))).seatJuror(pub.courtId, j.jurorId, key);
    priv.seated.push({ name: j.name, commitment: c, jurorId: j.jurorId, key, conflicted: j.name === flag("--conflicted"), noShow: j.name === flag("--noshow") });
    log[`seat ${c.slice(0, 12)}`] = tx(r.queueSig);
    console.log(`seated ${j.name} (${c.slice(0, 12)}...) ${tx(r.queueSig)}`);
  }
  fs.writeFileSync(privateCourtFile(court), JSON.stringify(priv, null, 2), { mode: 0o600 });
  if (priv.seated.length === 0) throw new Error("no bonded jurors to seat");

  const holders = priv.seated.filter((s) => s.conflicted).map((s) => s.jurorId);
  if (holders.length) for (const r of await saring.mirrorPositions(pub.courtId, holders)) log["mirror positions"] = tx(r.callbackSig);
  for (const s of priv.seated) {
    if (s.noShow) {
      console.log(`no-show ${s.name}: never casts`);
      continue;
    }
    const r = await new SaringClient(conn, withSeatMemo(owner, seatKeys.get(s.commitment)!, castMemo(s.commitment))).cast(pub.courtId, { jurorId: s.jurorId, key: s.key, yes: s.conflicted });
    log[`cast ${s.commitment.slice(0, 12)}`] = tx(r.queueSig);
    console.log(`cast ${s.name} ${s.conflicted ? "YES" : "NO"} ${tx(r.queueSig)}`);
  }
  const v = await saring.resolve(pub.courtId);
  log.resolve = tx(v.callbackSig);
  const verdict = { yes: v.yes, no: v.no, excluded: v.excluded, incomplete: v.incomplete, outcome: v.outcome };
  console.log("verdict", verdict);
  writeOut(`court-${court}.json`, { ...pub, seatedCount: priv.seated.length, notSeatedCount: priv.notSeated.length, txs: log, verdict });
}

if (require.main === module)
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
