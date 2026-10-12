/**
 * After the verdict: refund bonds, slash no-shows, pay counted jurors, all in shielded ZEC.
 *
 *   ts-node zcash/payout.ts <court address>
 *
 * 1. Reads the court from Solana devnet (sdk/src/venue.ts readCourtVerdict, which
 *    refuses accounts not owned by the Saring program); requires resolved && !incomplete.
 * 2. Rebuilds seats and casts from the court's own transactions (court.ts courtLog):
 *    a seat counts only if its seat key is the one the juror named in its bond memo.
 *    Requires (#seats that cast) == yes + no + excluded, and the operator's private
 *    conflicted set to be voters numbering exactly `excluded`.
 * 3. Applies zec.ts payoutPolicy: voters get their bond back; counted voters get
 *    REWARD_ZAT plus an equal share of the slashed no-show bonds; no-shows get nothing.
 * 4. Each payment goes only to an address that opens the juror's on-chain commitment
 *    uaCommit(court, commitment, address); otherwise it refuses to pay at all.
 * 5. ONE transaction from the operator wallet, memos "saring-refund:<court>:<c>" and
 *    "saring-reward:<court>:<verdict>:<c>". Refuses to pay a court twice.
 */
import { Connection } from "@solana/web3.js";
import * as fs from "fs";
import { readCourtVerdict } from "../sdk/src/venue";
import { type PrivateCourt, courtLog, privateCourtFile, rpc } from "./court";
import { BOND_ZAT, birthday, commitment, explorer, notes, orchardReceiver, parsePayoutMemo, pay, payoutPolicy, readJurors, refundMemo, rewardMemo, sync, taz, uaCommit, ufvk, viewWallet, writeOut } from "./zec";
import { bondsFor } from "./verify-bonds";

/** Seated = on-chain seat whose seat key matches the bond memo; voted = seated with a cast. */
export function seatedAndVoted(bonds: ReturnType<typeof bondsFor>, log: Awaited<ReturnType<typeof courtLog>>) {
  const valid = bonds.filter((b) => b.zat >= BOND_ZAT && b.seatKey && log.seats.get(b.commitment)?.seatKey === b.seatKey);
  const seated = new Set(valid.map((b) => b.commitment));
  const voted = new Set([...seated].filter((c) => log.casts.has(c)));
  return { seated, voted };
}

async function main() {
  const court = process.argv[2];
  if (!court) throw new Error("usage: payout.ts <court address>");
  const conn = new Connection(rpc, "confirmed");

  const v = await readCourtVerdict(conn, court);
  if (!v.resolved) throw new Error("court is not resolved");
  if (v.incomplete) throw new Error("verdict is incomplete (conflict check overflowed): refund bonds manually, no rewards");
  const verdict = v.outcome!;

  sync("operator");
  const already = notes("operator").filter((n) => !n.incoming && !n.expired && parsePayoutMemo(n.memo)?.court === court);
  if (already.length) throw new Error(`court already paid in ${[...new Set(already.map((n) => n.txid))].join(", ")}`);

  viewWallet("operator-watch", ufvk("operator"), birthday("operator"));
  const bonds = bondsFor("operator-watch", court);
  const log = await courtLog(conn, court);
  const { seated, voted } = seatedAndVoted(bonds, log);
  if (voted.size !== v.yes + v.no + v.excluded)
    throw new Error(`${voted.size} seats cast on chain but the tally counts ${v.yes + v.no + v.excluded} ballots: refusing to slash on a disputed record`);

  const priv: PrivateCourt = JSON.parse(fs.readFileSync(privateCourtFile(court), "utf8"));
  const conflicted = new Set(priv.seated.filter((s) => s.conflicted).map((s) => s.commitment));
  if (conflicted.size !== v.excluded || [...conflicted].some((c) => !voted.has(c)))
    throw new Error(`conflicted record (${conflicted.size}) disagrees with chain (excluded ${v.excluded})`);

  const policy = payoutPolicy(bonds.filter((b) => b.zat >= BOND_ZAT), seated, voted, conflicted);
  const jurors = readJurors();
  const addrOf = (c: string) => {
    const j = jurors.find((x) => commitment(x.jurorId, x.salt, court) === c);
    const onChain = log.seats.get(c)?.uaCommit;
    if (!j) throw new Error(`no registration for ${c}`);
    // a bonded-but-never-seated juror has no on-chain commitment; nothing to redirect against
    const addr = orchardReceiver(j.ua); // idempotent; older registrations stored the full UA
    if (onChain && uaCommit(court, c, addr) !== onChain) throw new Error(`address for ${c.slice(0, 12)} does not open its on-chain commitment`);
    return addr;
  };
  const outs = policy.pays.map((p) => ({
    ...p,
    address: addrOf(p.commitment),
    memo: p.kind === "refund" ? refundMemo(court, p.commitment) : rewardMemo(court, verdict, p.commitment),
  }));

  const txid = pay("operator", outs);
  const rec = {
    court,
    verdict: { ...v, court: undefined },
    policy: "voters: bond refunded; counted voters: reward + equal share of slashed bonds; seated no-shows: bond slashed; conflicted: refund only",
    noShowsSlashed: policy.noShows,
    slashed: taz(policy.slashed),
    slashSharePerCountedJuror: taz(policy.share),
    payments: outs.map((o) => ({ kind: o.kind, juror: o.commitment, amount: taz(o.zat), memo: o.memo, addressOpensOnChainCommitment: true })),
    total: taz(outs.reduce((s, o) => s + o.zat, 0)),
    txid,
    explorer: explorer(txid),
  };
  writeOut(`payout-${court}.json`, rec);
  console.log(JSON.stringify(rec, null, 2));
}

if (require.main === module)
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
