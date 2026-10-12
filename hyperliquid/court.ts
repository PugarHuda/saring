/**
 * Saring court (Solana devnet, Arcium MPC) for a live Hyperliquid HIP-4 outcome market.
 *
 *   ts-node hyperliquid/court.ts <question> <outcome>      e.g. 391 8659 (Ballon d'Or 2026: Lamine Yamal)
 *
 * 1. Reads the question's holders live from HL mainnet (hl.ts: recentTrades -> spotClearinghouseState).
 *    Every holder of ANY outcome in the question counts as conflicted: question outcomes are linked
 *    (negate/merge), so a Mbappe-YES holder has a stake in whether Yamal wins too.
 * 2. Opens a court, seats 3 jurors: the largest real HL holder (identity = evmIdentityId(address))
 *    and 2 fresh EVM addresses confirmed live to hold nothing in the question.
 * 3. Mirrors all holder identities into the court, encrypted (6 per MPC call).
 * 4. Scripted ballots: the holder-juror votes YES, the clean jurors vote NO. MPC drops the holder's
 *    ballot (excluded) without revealing who it was.
 * 5. Resolves and prints the HyperCore settleOutcome action a deployer (or settle-only sub-deployer)
 *    would submit. NOT submitted: we hold no deployer / sub-deployer key for this venue.
 *
 * Outputs hyperliquid/out/court-<court>.json. No keys are written (ballot keys stay in memory).
 */
import { Connection, Keypair } from "@solana/web3.js";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SaringClient, type Verdict, newBallotKey } from "../sdk/src/index";
import { evmIdentityId, info, marketOutcomes, outcomeHolders, writeOut } from "./hl";

const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const tx = (s: string) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;
const MAX_HOLDERS = 42; // ponytail: court state holds 42 position slots; bigger markets need a bigger court account

/**
 * Verdict -> HIP-4 settleFraction. YES=1, NO=0. Tie/incomplete: "0.5" for a standalone outcome;
 * question outcomes may only settle to "0"/"1" (HIP-4 deployer-actions docs), so there it is null
 * (do not settle; re-run the court / escalate).
 */
export function settleFraction(v: Pick<Verdict, "outcome">, inQuestion: boolean): string | null {
  if (v.outcome === "YES") return "1";
  if (v.outcome === "NO") return "0";
  if (v.outcome === "TIE" || v.outcome === "INCOMPLETE") return inQuestion ? null : "0.5";
  throw new Error("court not resolved");
}

async function main() {
  console.assert(settleFraction({ outcome: "YES" }, true) === "1" && settleFraction({ outcome: "NO" }, true) === "0");
  console.assert(settleFraction({ outcome: "TIE" }, false) === "0.5" && settleFraction({ outcome: "INCOMPLETE" }, true) === null);

  const [qa, oa] = process.argv.slice(2);
  if (!qa || !oa) throw new Error("usage: court.ts <question> <outcome>");
  const { q, outcomes } = await marketOutcomes(Number(qa));
  const target = outcomes.find((o) => o.outcome === Number(oa));
  if (!target) throw new Error(`outcome ${oa} not in question ${qa}`);

  const conn = new Connection(rpc, "confirmed");
  if (!(await conn.getGenesisHash()).startsWith("EtWTRABZaYq6iMfeYKouRu166VU2xqa1")) throw new Error("RPC is not Solana devnet");
  const before = await conn.getBalance(owner.publicKey);
  console.log(`devnet payer balance ${(before / 1e9).toFixed(4)} SOL`);

  // 1. real holders, live
  const live = await outcomeHolders(outcomes.map((o) => o.outcome));
  const holders = live.holders.slice(0, MAX_HOLDERS);
  console.log(`HL #${q.question} ${q.description}`);
  console.log(`target outcome ${target.outcome}: ${target.description}`);
  console.log(`${live.holders.length} confirmed holders (of ${live.candidates} trade counterparties)${live.holders.length > MAX_HOLDERS ? `, mirroring ${MAX_HOLDERS}` : ""}`);

  // 2. jurors
  const size = (h: { balances: Record<string, string> }) => Object.values(h.balances).reduce((s, x) => s + Number(x), 0);
  const holderJuror = [...holders].sort((a, b) => size(b) - size(a))[0];
  const clean: string[] = [];
  while (clean.length < 2) {
    const addr = "0x" + randomBytes(20).toString("hex");
    const s = await info<{ balances: { coin: string; total: string }[] }>({ type: "spotClearinghouseState", user: addr });
    if (!s.balances.some((b) => b.coin.startsWith("+") && Number(b.total) !== 0)) clean.push(addr);
  }
  const jurors = [
    { label: "juror A (real HL holder)", address: holderJuror.address, yes: true, holds: holderJuror.balances },
    ...clean.map((address, i) => ({ label: `juror ${"BC"[i]} (clean, confirmed 0 outcome balance)`, address, yes: false, holds: {} })),
  ].map((j) => ({ ...j, jurorId: evmIdentityId(j.address), key: newBallotKey() }));

  const saring = new SaringClient(conn, owner);
  const label = `hl:${target.venue}:q${q.question}:o${target.outcome}`; // court.market, <=64 bytes
  const r = await saring.openCourt(label);
  const court = r.court.toBase58();
  const txs: Record<string, string> = { open: tx(r.callbackSig) };
  console.log(`court ${court} (id ${r.courtId}) label "${label}" ${tx(r.callbackSig)}`);

  for (const j of jurors) {
    const s = await saring.seatJuror(r.courtId, j.jurorId, j.key);
    txs[`seat ${j.address}`] = tx(s.callbackSig);
    console.log(`seated ${j.label} ${j.address} id=${j.jurorId} ${tx(s.callbackSig)}`);
  }

  // 3. mirror holders (encrypted)
  const ids = holders.map((h) => evmIdentityId(h.address));
  (await saring.mirrorPositions(r.courtId, ids)).forEach((m, i) => {
    txs[`mirror batch ${i + 1}`] = tx(m.callbackSig);
    console.log(`mirrored holders batch ${i + 1} (encrypted) ${tx(m.callbackSig)}`);
  });

  // 4. ballots
  for (const j of jurors) {
    const c = await saring.cast(r.courtId, { jurorId: j.jurorId, key: j.key, yes: j.yes });
    txs[`cast ${j.address}`] = tx(c.callbackSig);
    console.log(`cast ${j.label} ${j.yes ? "YES" : "NO"} ${tx(c.callbackSig)}`);
  }

  // 5. verdict -> HyperCore settlement value
  const v = await saring.resolve(r.courtId);
  txs.resolve = tx(v.callbackSig);
  const verdict = { yes: v.yes, no: v.no, excluded: v.excluded, incomplete: v.incomplete, outcome: v.outcome };
  console.log("verdict", verdict, tx(v.callbackSig));
  const frac = settleFraction(v, true);
  const settleAction =
    frac === null
      ? null
      : {
          type: "outcomeDeploy",
          venue: target.venue,
          operation: {
            settleOutcome: {
              outcome: target.outcome,
              settleFraction: frac,
              details: "",
              nameAndDescription: [target.name, target.description],
              sideNames: target.sideSpecs.map((s) => s.name),
            },
          },
        };
  console.log(`HyperCore settlement (NOT SUBMITTED: requires the deployer's settleOutcome permission for venue "${target.venue}"):`);
  console.log(JSON.stringify(settleAction, null, 2));

  const spent = (before - (await conn.getBalance(owner.publicKey))) / 1e9;
  console.log(`devnet SOL spent ${spent.toFixed(5)}`);
  writeOut(`court-${court}.json`, {
    at: new Date().toISOString(),
    hyperliquid: { info: "https://api.hyperliquid.xyz/info", question: q, target, holders, candidates: live.candidates, trades: live.trades },
    court, courtId: r.courtId, label,
    jurors: jurors.map(({ key, ...j }) => j), // ballot keys omitted
    mirroredIds: ids, txs, verdict,
    settlement: { submitted: false, reason: "requires the deployer's (or a settleOutcome sub-deployer's) key for this venue", settleFraction: frac, action: settleAction },
    devnetSolSpent: spent,
  });
  process.exit(0);
}

if (require.main === module)
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
