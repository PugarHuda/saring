/**
 * Selective disclosure with viewing keys.
 *
 *   ts-node zcash/audit.ts auditor          -> auditor ledger from the operator's UFVK only
 *   ts-node zcash/audit.ts juror <wallet>   -> what a juror's own wallet decrypts (receipts)
 *
 * auditor: the operator hands over its Unified Full Viewing Key (written to
 * ~/.saring-zcash/auditor.ufvk, never to the repo). The auditor imports it into a
 * separate view-only wallet, scans testnet, and rebuilds the full bond + payout ledger
 * per court from the decrypted notes and memos (incoming via the IVK, outgoing via the
 * OVK), then checks: refunds == bonds received, and every reward carries the verdict.
 * The block explorer shows the same transactions as opaque Orchard actions.
 */
import * as fs from "fs";
import * as path from "path";
import { HOME, birthday, explorer, notes, parseBondMemo, sync, taz, ufvk, viewWallet, writeOut } from "./zec";

function auditor() {
  const keyFile = path.join(HOME, "auditor.ufvk");
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, ufvk("operator") + "\n", { mode: 0o600 });
  viewWallet("auditor", fs.readFileSync(keyFile, "utf8").trim(), birthday("operator"));

  type Row = { bonds: number; bondCount: number; refunds: number; refundCount: number; rewards: number; rewardCount: number; verdicts: Set<string>; txids: Set<string> };
  const courts = new Map<string, Row>();
  const row = (c: string) =>
    courts.get(c) ?? courts.set(c, { bonds: 0, bondCount: 0, refunds: 0, refundCount: 0, rewards: 0, rewardCount: 0, verdicts: new Set(), txids: new Set() }).get(c)!;

  for (const n of notes("auditor")) {
    if (n.height === null || n.change) continue;
    const b = n.incoming ? parseBondMemo(n.memo) : null;
    const m = !n.incoming ? /^saring-(refund|reward):([1-9A-HJ-NP-Za-km-z]{32,44})(?::(\w+))?$/.exec(n.memo ?? "") : null;
    const r = b ? row(b.court) : m ? row(m[2]) : null;
    if (!r) continue;
    r.txids.add(n.txid);
    if (b) {
      r.bonds += n.zat;
      r.bondCount++;
    } else if (m![1] === "refund") {
      r.refunds += n.zat;
      r.refundCount++;
    } else {
      r.rewards += n.zat;
      r.rewardCount++;
      r.verdicts.add(m![3]);
    }
  }

  const report = [...courts].map(([court, r]) => ({
    court,
    bondsReceived: `${r.bondCount} x = ${taz(r.bonds)}`,
    refundsPaid: `${r.refundCount} x = ${taz(r.refunds)}`,
    rewardsPaid: `${r.rewardCount} x = ${taz(r.rewards)}`,
    verdictInMemos: [...r.verdicts],
    refundsMatchBonds: r.refundCount === 0 ? "not paid out yet" : r.refunds === r.bonds,
    transactions: [...r.txids].map(explorer),
  }));
  writeOut("audit.json", { viewer: "auditor (UFVK only, view-only wallet, cannot spend)", courts: report });
  console.log(JSON.stringify(report, null, 2));
}

function juror(w: string) {
  sync(w);
  const got = notes(w)
    .filter((n) => n.incoming)
    .map((n) => ({ txid: n.txid, height: n.height, pool: n.pool, amount: taz(n.zat), memo: n.memo, explorer: explorer(n.txid) }));
  writeOut(`receipts-${w}.json`, { wallet: w, view: "juror's own wallet: notes decrypted with its incoming viewing key", received: got });
  console.log(JSON.stringify(got, null, 2));
}

/** What anyone without a key sees: the explorer's own decoding of each tx (ZecBlock API). */
async function publicView(txids: string[]) {
  const rows = [];
  for (const t of txids) {
    const r: any = await (await fetch(`https://api.testnet.zecblock.com/api/tx/${t}`)).json();
    rows.push({
      txid: t,
      explorer: explorer(t),
      block: r.blockHeight,
      fee: r.fee,
      shieldedActions: { orchard: r.orchardActions, ironwood: r.ironwoodActions, saplingOutputs: r.saplingOutputCount },
      transparentInputs: r.inputCount,
      transparentOutputs: r.outputCount,
      // value moving inside the shielded pool is not in the tx; only the net pool balance (= fee) is
      netShieldedValueBalance: r.valueBalance,
    });
  }
  writeOut("public-view.json", { viewer: "anyone, no keys (api.testnet.zecblock.com)", txs: rows });
  console.log(JSON.stringify(rows, null, 2));
}

const [cmd, w, ...rest] = process.argv.slice(2);
if (cmd === "auditor") auditor();
else if (cmd === "juror" && w) juror(w);
else if (cmd === "public" && w) publicView([w, ...rest]);
else {
  console.error("usage: audit.ts auditor | audit.ts juror <wallet> | audit.ts public <txid...>");
  process.exit(1);
}
