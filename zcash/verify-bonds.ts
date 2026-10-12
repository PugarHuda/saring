/**
 * The operator checks who bonded for a court, using only a viewing key.
 *
 *   ts-node zcash/verify-bonds.ts <court address>
 *
 * Runs on "operator-watch", a wallet that holds the operator's UFVK and no spending
 * key: it trial-decrypts every shielded output on testnet, keeps the notes addressed
 * to the operator, and reads their memos. On chain these bonds are opaque shielded
 * actions: no sender, no receiver, no amount, no memo.
 *
 * Output: out/allowlist-<court>.json, the juror commitments (and their seat keys)
 * that posted at least BOND_ZAT for this court. court.ts seats only those.
 */
import { BOND_ZAT, birthday, explorer, notes, parseBondMemo, taz, ufvk, viewWallet, writeOut } from "./zec";

export interface Bond {
  commitment: string;
  /** Seat key named in the (first) bond memo; null for pre-v2 bonds. */
  seatKey: string | null;
  zat: number;
  /** Block time of the first bond note (unix seconds). */
  time: number;
  txids: string[];
}

export function bondsFor(wallet: string, court: string): Bond[] {
  const byC = new Map<string, Bond>();
  for (const n of notes(wallet)) {
    const b = n.incoming && n.height !== null ? parseBondMemo(n.memo) : null;
    if (!b || b.court !== court) continue;
    const e = byC.get(b.commitment) ?? { commitment: b.commitment, seatKey: b.seatKey, zat: 0, time: n.time ?? 0, txids: [] };
    e.zat += n.zat;
    e.txids.push(n.txid);
    byC.set(b.commitment, e);
  }
  return [...byC.values()];
}

if (require.main === module) {
  const court = process.argv[2];
  if (!court) throw new Error("usage: verify-bonds.ts <court address>");
  viewWallet("operator-watch", ufvk("operator"), birthday("operator"));
  const bonds = bondsFor("operator-watch", court);
  const ok = bonds.filter((b) => b.zat >= BOND_ZAT && b.seatKey);
  for (const b of bonds)
    console.log(`${ok.includes(b) ? "BONDED " : "INVALID"} ${b.commitment.slice(0, 16)}...  ${taz(b.zat)}  ${b.txids.map(explorer).join(" ")}`);
  const out = {
    court,
    verifiedWith: "UFVK in a view-only wallet (no spending key)",
    minBond: taz(BOND_ZAT),
    allowlist: ok.map((b) => b.commitment),
    bonds: bonds.map((b) => ({ ...b, amount: taz(b.zat) })),
  };
  writeOut(`allowlist-${court}.json`, out);
  console.log(`${ok.length} bonded juror commitment(s) -> zcash/out/allowlist-${court}.json`);
}
