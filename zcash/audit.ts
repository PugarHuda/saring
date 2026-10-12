/**
 * Selective disclosure with viewing keys, and a verifier anyone can run.
 *
 *   ts-node zcash/audit.ts publish-key        -> operator publishes its UFVK (view-only) to out/
 *   ts-node zcash/audit.ts verify <court>     -> public verifier: bonds, seats, slashing, payouts
 *   ts-node zcash/audit.ts auditor            -> ledger of every court from the UFVK
 *   ts-node zcash/audit.ts juror <wallet>     -> what a juror's own wallet decrypts (receipts)
 *   ts-node zcash/audit.ts public <txid...>   -> what the explorer shows anyone (no keys)
 *
 * verify needs nothing private: the published UFVK (out/operator-viewing-key.json,
 * a viewing key that cannot spend) imported into a fresh view-only wallet, plus Solana
 * devnet. It checks every bond against the on-chain seat (right seat key, enough TAZ,
 * mined before seating), derives no-shows from the court's own cast transactions,
 * recomputes the payout policy, and checks every payout output: amount, and that the
 * recipient address (recovered with the OVK) opens the juror's on-chain commitment.
 * The report (out/verify-<court>.json + .md) carries hashes and booleans, never addresses.
 */
import { Connection } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { readCourtVerdict } from "../sdk/src/venue";
import { courtLog, rpc } from "./court";
import { seatedAndVoted } from "./payout";
import { bondsFor } from "./verify-bonds";
import { BOND_ZAT, HOME, OUT, REWARD_ZAT, birthday, explorer, notes, parseBondMemo, parsePayoutMemo, sync, taz, uaCommit, ufvk, viewWallet, writeOut } from "./zec";

const keyFile = path.join(OUT, "operator-viewing-key.json");
const sol = (s: string) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;

function publishKey() {
  const k = ufvk("operator");
  if (!k.startsWith("uview")) throw new Error("refusing to publish: not a viewing key");
  writeOut("operator-viewing-key.json", { ufvk: k, birthday: birthday("operator"), note: "Unified Full Viewing Key: decrypts the operator's notes, cannot spend" });
  console.log(`published -> zcash/out/operator-viewing-key.json`);
}

async function verify(court: string) {
  const pubKey = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  if (!/^uview/.test(pubKey.ufvk)) throw new Error("published key is not a viewing key");
  viewWallet("verifier", pubKey.ufvk, pubKey.birthday); // fresh view-only wallet, nothing from the operator's machine
  const conn = new Connection(rpc, "confirmed");
  const v = await readCourtVerdict(conn, court);
  const bonds = bondsFor("verifier", court);
  const log = await courtLog(conn, court);
  const { seated, voted } = seatedAndVoted(bonds, log);
  const checks: { check: string; ok: boolean; detail?: string }[] = [];
  const check = (check: string, ok: boolean, detail?: string) => checks.push({ check, ok, detail });

  // before seating: every on-chain seat is backed by a bond that names its seat key and predates it
  for (const [c, s] of log.seats) {
    const b = bonds.find((x) => x.commitment === c);
    check(`seat ${c.slice(0, 12)} has a bond >= ${taz(BOND_ZAT)} naming its seat key, mined before seating`,
      !!b && b.zat >= BOND_ZAT && b.seatKey === s.seatKey && b.time > 0 && b.time <= s.time,
      b ? `bond ${taz(b.zat)} at ${b.time}, seat at ${s.time}` : "no bond");
  }
  const counted = v.yes + v.no;
  check("seats that cast == ballots in the on-chain tally (yes+no+excluded)", voted.size === counted + v.excluded, `${voted.size} vs ${counted + v.excluded}`);
  const noShows = [...seated].filter((c) => !voted.has(c));
  const slashed = bonds.filter((b) => noShows.includes(b.commitment)).reduce((s, b) => s + b.zat, 0);
  const rewardEach = REWARD_ZAT + (counted ? Math.floor(slashed / counted) : 0);

  // after payout: what the operator actually sent (recovered with the OVK)
  const paid = notes("verifier")
    .filter((n) => !n.incoming && !n.change && n.height !== null)
    .map((n) => ({ n, m: parsePayoutMemo(n.memo) }))
    .filter((x) => x.m?.court === court && x.m.commitment);
  const isPaid = paid.length > 0;
  const of = (c: string, k: string) => paid.filter((p) => p.m!.commitment === c && p.m!.kind === k);
  if (isPaid) {
    for (const p of paid) {
      const s = log.seats.get(p.m!.commitment!);
      check(`${p.m!.kind} to ${p.m!.commitment!.slice(0, 12)}: recipient opens the on-chain address commitment`, !!s && !!p.n.to && uaCommit(court, p.m!.commitment!, p.n.to) === s.uaCommit);
    }
    for (const c of noShows) check(`no-show ${c.slice(0, 12)} slashed: received nothing`, of(c, "refund").length + of(c, "reward").length === 0);
    for (const c of voted) {
      const b = bonds.find((x) => x.commitment === c)!;
      check(`voter ${c.slice(0, 12)} refunded its bond`, of(c, "refund").reduce((s, p) => s + p.n.zat, 0) === b.zat);
    }
    const rewards = paid.filter((p) => p.m!.kind === "reward");
    check(`${counted} rewards of ${taz(rewardEach)} (base + slashed/${counted}), only to voters, verdict ${v.outcome}`,
      rewards.length === counted && rewards.every((p) => p.n.zat === rewardEach && voted.has(p.m!.commitment!) && p.m!.verdict === v.outcome));
  }

  const rows = [...new Set([...bonds.map((b) => b.commitment), ...log.seats.keys()])].map((c) => {
    const b = bonds.find((x) => x.commitment === c);
    const s = log.seats.get(c);
    const sum = (k: string) => of(c, k).reduce((t, p) => t + p.n.zat, 0);
    return {
      juror: c,
      bond: b ? taz(b.zat) : null,
      bondTx: b?.txids.map(explorer) ?? [],
      seatTx: s ? sol(s.sig) : null,
      castTx: (log.casts.get(c) ?? []).map(sol),
      status: !seated.has(c) ? "bonded, not seated" : voted.has(c) ? "voted" : "NO-SHOW (slashed)",
      refund: isPaid ? taz(sum("refund")) : null,
      reward: isPaid ? taz(sum("reward")) : null,
      payoutTx: [...new Set(of(c, "refund").concat(of(c, "reward")).map((p) => explorer(p.n.txid)))],
    };
  });
  const ok = checks.every((x) => x.ok);
  const report = {
    court,
    verifiedWith: "published operator UFVK in a fresh view-only wallet + Solana devnet RPC; no operator secrets",
    verdict: { yes: v.yes, no: v.no, excluded: v.excluded, outcome: v.outcome },
    stage: isPaid ? "paid" : "seated, not paid yet",
    slashed: taz(slashed),
    ok,
    checks,
    jurors: rows,
  };
  writeOut(`verify-${court}.json`, report);
  const short = (u: string) => `[${u.split("/").pop()!.split("?")[0].slice(0, 8)}…](${u})`;
  const md = [
    `# Saring court ${court}`,
    "",
    `Verdict on chain: yes ${v.yes}, no ${v.no}, excluded ${v.excluded} -> **${v.outcome}**. Slashed: ${taz(slashed)}. Result: **${ok ? "ALL CHECKS PASS" : "FAIL"}**.`,
    "",
    "| juror commitment | bond | bond tx | seat tx | cast tx | status | refund | reward | payout tx |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) =>
      `| \`${r.juror.slice(0, 12)}…\` | ${r.bond ?? "-"} | ${r.bondTx.map(short).join(" ") || "-"} | ${r.seatTx ? short(r.seatTx) : "-"} | ${r.castTx.map(short).join(" ") || "-"} | ${r.status} | ${r.refund ?? "-"} | ${r.reward ?? "-"} | ${r.payoutTx.map(short).join(" ") || "-"} |`),
    "",
    "| check | result |",
    "|---|---|",
    ...checks.map((x) => `| ${x.check} | ${x.ok ? "pass" : `**FAIL** ${x.detail ?? ""}`} |`),
    "",
  ].join("\n");
  writeOut(`verify-${court}.md`, md);
  console.log(md);
  if (!ok) process.exitCode = 2;
}

function auditor() {
  const kf = path.join(HOME, "auditor.ufvk");
  if (!fs.existsSync(kf)) fs.writeFileSync(kf, ufvk("operator") + "\n", { mode: 0o600 });
  viewWallet("auditor", fs.readFileSync(kf, "utf8").trim(), birthday("operator"));

  type Row = { bonds: number; bondCount: number; refunds: number; refundCount: number; rewards: number; rewardCount: number; verdicts: Set<string>; txids: Set<string> };
  const courts = new Map<string, Row>();
  const row = (c: string) =>
    courts.get(c) ?? courts.set(c, { bonds: 0, bondCount: 0, refunds: 0, refundCount: 0, rewards: 0, rewardCount: 0, verdicts: new Set(), txids: new Set() }).get(c)!;

  for (const n of notes("auditor")) {
    if (n.height === null || n.change) continue;
    const b = n.incoming ? parseBondMemo(n.memo) : null;
    const m = !n.incoming ? parsePayoutMemo(n.memo) : null;
    const r = b ? row(b.court) : m ? row(m.court) : null;
    if (!r) continue;
    r.txids.add(n.txid);
    if (b) {
      r.bonds += n.zat;
      r.bondCount++;
    } else if (m!.kind === "refund") {
      r.refunds += n.zat;
      r.refundCount++;
    } else {
      r.rewards += n.zat;
      r.rewardCount++;
      r.verdicts.add(m!.verdict ?? "?");
    }
  }

  const report = [...courts].map(([court, r]) => ({
    court,
    bondsReceived: `${r.bondCount} x = ${taz(r.bonds)}`,
    refundsPaid: `${r.refundCount} x = ${taz(r.refunds)}`,
    rewardsPaid: `${r.rewardCount} x = ${taz(r.rewards)}`,
    verdictInMemos: [...r.verdicts],
    bondsKeptOrSlashed: taz(r.bonds - r.refunds),
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

if (require.main === module) {
  const [cmd, w, ...rest] = process.argv.slice(2);
  const run = async () => {
    if (cmd === "publish-key") publishKey();
    else if (cmd === "verify" && w) await verify(w);
    else if (cmd === "auditor") auditor();
    else if (cmd === "juror" && w) juror(w);
    else if (cmd === "public" && w) await publicView([w, ...rest]);
    else throw new Error("usage: audit.ts publish-key | verify <court> | auditor | juror <wallet> | public <txid...>");
  };
  run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
