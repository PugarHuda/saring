/**
 * The Saring side on Solana devnet (program 3CeQ1DQY…, Arcium MPC), wired to Zcash bonds.
 *
 *   ts-node zcash/court.ts open "<question>"           -> opens a court, prints its address
 *   ts-node zcash/court.ts seat <court> [conflicted]   -> seats ONLY bonded jurors, runs a
 *                                                         scripted dispute, resolves
 *
 * `seat` reads out/allowlist-<court>.json (verify-bonds.ts). A registered juror whose
 * commitment is not on it is not seated. In the scripted dispute the juror named
 * `conflicted` holds a position in the disputed market (mirrored into the court),
 * votes YES, and MPC drops that ballot; everyone else votes NO.
 *
 * The operator's private record (ballot keys, who is conflicted) goes to
 * ~/.saring-zcash/court-<court>.json; the public part to zcash/out/court-<court>.json.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SaringClient, newBallotKey } from "../sdk/src/index";
import { HOME, OUT, commitment, readJurors, writeOut } from "./zec";

const rpc = process.env.SOLANA_RPC_URL ?? process.env.RPC_URL ?? "https://api.devnet.solana.com";
const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const tx = (s: string) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;

export interface PrivateCourt {
  courtId: number;
  court: string;
  seated: { name: string; commitment: string; jurorId: number; key: number; conflicted: boolean }[];
  notSeated: { name: string; commitment: string; reason: string }[];
}
export const privateCourtFile = (court: string) => path.join(HOME, `court-${court}.json`);

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
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

  if (cmd !== "seat" || !a) throw new Error('usage: court.ts open "<question>" | court.ts seat <court> [conflicted juror]');
  const court = new PublicKey(a).toBase58();
  const pub = JSON.parse(fs.readFileSync(path.join(OUT, `court-${court}.json`), "utf8"));
  const allow = new Set<string>(JSON.parse(fs.readFileSync(path.join(OUT, `allowlist-${court}.json`), "utf8")).allowlist);
  const priv: PrivateCourt = { courtId: pub.courtId, court, seated: [], notSeated: [] };
  const log: Record<string, unknown> = {};

  for (const j of readJurors()) {
    const c = commitment(j.jurorId, j.salt);
    if (!allow.has(c)) {
      priv.notSeated.push({ name: j.name, commitment: c, reason: "no shielded bond for this court" });
      console.log(`skip ${j.name}: no bond`);
      continue;
    }
    const key = newBallotKey();
    const r = await saring.seatJuror(pub.courtId, j.jurorId, key);
    priv.seated.push({ name: j.name, commitment: c, jurorId: j.jurorId, key, conflicted: j.name === b });
    log[`seat ${c.slice(0, 12)}`] = tx(r.callbackSig);
    console.log(`seated ${j.name} (${c.slice(0, 12)}…) ${tx(r.callbackSig)}`);
  }
  fs.writeFileSync(privateCourtFile(court), JSON.stringify(priv, null, 2), { mode: 0o600 });
  if (priv.seated.length === 0) throw new Error("no bonded jurors to seat");

  const holders = priv.seated.filter((s) => s.conflicted).map((s) => s.jurorId);
  for (const r of await saring.mirrorPositions(pub.courtId, holders)) log["mirror positions"] = tx(r.callbackSig);
  for (const s of priv.seated) {
    const r = await saring.cast(pub.courtId, { jurorId: s.jurorId, key: s.key, yes: s.conflicted });
    log[`cast ${s.commitment.slice(0, 12)}`] = tx(r.callbackSig);
    console.log(`cast ${s.name} ${s.conflicted ? "YES" : "NO"} ${tx(r.callbackSig)}`);
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
