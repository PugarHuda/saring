/**
 * After the verdict: refund every bond and pay counted jurors, all in shielded ZEC.
 *
 *   ts-node zcash/payout.ts <court address>
 *
 * 1. Reads the court from Solana devnet (sdk/src/venue.ts readCourtVerdict, which
 *    refuses accounts not owned by the Saring program) and requires resolved && !incomplete.
 * 2. Cross-checks the operator's private seating record against the on-chain tally:
 *    counted jurors must equal yes + no, conflicted jurors must equal `excluded`.
 * 3. Re-verifies bonds with the view-only wallet, then sends ONE transaction from the
 *    operator wallet with one Orchard output per payment:
 *      - every bonded juror: bond refund, memo "saring-refund:<court>"
 *      - every counted juror: REWARD_ZAT, memo "saring-reward:<court>:<verdict>"
 *    Conflicted jurors get the refund and no reward. Refuses to pay a court twice.
 */
import { Connection } from "@solana/web3.js";
import * as fs from "fs";
import { readCourtVerdict } from "../sdk/src/venue";
import { type PrivateCourt, privateCourtFile } from "./court";
import { REWARD_ZAT, birthday, commitment, explorer, notes, pay, readJurors, sync, taz, ufvk, viewWallet, writeOut } from "./zec";
import { bondsFor } from "./verify-bonds";

const rpc = process.env.SOLANA_RPC_URL ?? process.env.RPC_URL ?? "https://api.devnet.solana.com";

async function main() {
  const court = process.argv[2];
  if (!court) throw new Error("usage: payout.ts <court address>");

  const v = await readCourtVerdict(new Connection(rpc, "confirmed"), court);
  if (!v.resolved) throw new Error("court is not resolved");
  if (v.incomplete) throw new Error("verdict is incomplete (conflict check overflowed): refund bonds manually, no rewards");
  const verdict = v.outcome!; // YES | NO | TIE: counted jurors did their job either way

  const priv: PrivateCourt = JSON.parse(fs.readFileSync(privateCourtFile(court), "utf8"));
  const counted = priv.seated.filter((s) => !s.conflicted);
  const conflicted = priv.seated.filter((s) => s.conflicted);
  if (counted.length !== v.yes + v.no || conflicted.length !== v.excluded)
    throw new Error(`seating record (${counted.length} counted, ${conflicted.length} conflicted) disagrees with chain (${v.yes}+${v.no} counted, ${v.excluded} excluded)`);

  sync("operator");
  const already = notes("operator").filter((n) => !n.incoming && /^saring-(refund|reward):/.test(n.memo ?? "") && n.memo!.split(":")[1] === court);
  if (already.length) throw new Error(`court already paid in ${[...new Set(already.map((n) => n.txid))].join(", ")}`);

  viewWallet("operator-watch", ufvk("operator"), birthday("operator"));
  const bonds = bondsFor("operator-watch", court);
  const jurors = readJurors();
  const uaOf = (c: string) => jurors.find((j) => commitment(j.jurorId, j.salt) === c)?.ua;

  const outs: { address: string; zat: number; memo: string; kind: string; juror: string }[] = [];
  for (const b of bonds) {
    const ua = uaOf(b.commitment);
    if (!ua) throw new Error(`bond ${b.commitment} has no registered UA`);
    outs.push({ address: ua, zat: b.zat, memo: `saring-refund:${court}`, kind: "refund", juror: b.commitment });
  }
  for (const s of counted) {
    const ua = uaOf(s.commitment)!;
    outs.push({ address: ua, zat: REWARD_ZAT, memo: `saring-reward:${court}:${verdict}`, kind: "reward", juror: s.commitment });
  }

  const txid = pay("operator", outs);
  const rec = {
    court,
    verdict: { ...v, court: undefined },
    policy: "every bond refunded; reward only to jurors whose ballot counted (conflicted jurors: refund, no reward)",
    payments: outs.map((o) => ({ kind: o.kind, juror: o.juror, amount: taz(o.zat), memo: o.memo })),
    total: taz(outs.reduce((s, o) => s + o.zat, 0)),
    txid,
    explorer: explorer(txid),
  };
  writeOut(`payout-${court}.json`, rec);
  console.log(JSON.stringify(rec, null, 2));
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
