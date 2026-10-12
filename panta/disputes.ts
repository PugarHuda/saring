/**
 * Scans Panta's balr_market program history on Solana mainnet for the dispute flow:
 *   dispute_resolved_event -> ReviewRequest + MarketDisputed
 *   submit_oracle_result / resolve_event -> OracleResultSubmitted / EventResolved / ResolutionDisputeSettled
 * Decodes Anchor events from "Program data:" logs with Panta's own IDL and counts
 * instructions from "Program log: Instruction: X" lines. Also reads MarketConfig and
 * every ReviewRequest account that exists right now.
 *
 *   npx ts-node --transpile-only -P tsconfig.json panta/disputes.ts [maxSignatures=10000]
 * Writes panta/out/disputes.json.
 */
import { BorshAccountsCoder, BorshEventCoder } from "@anchor-lang/core";
import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { PANTA_PROGRAM } from "./panta";

export const IDL = JSON.parse(fs.readFileSync(path.join(__dirname, "balr_market.json"), "utf8"));
export const MARKET_CONFIG = new PublicKey("8mJjfx7SuWwS4yfVZXtqC2cvzxr3TQHsCgKyjpuDWKAP");
export const DISPUTE_IXS = ["DisputeResolvedEvent", "DisputeResolvedEventUsdc"];
const WATCHED_IXS = [...DISPUTE_IXS, "SubmitOracleResult", "SubmitOracleResultUsdc", "ResolveEvent", "ResolveEventUsdc"];
const DISPUTE_EVENTS = ["MarketDisputed", "ResolutionDisputeSettled", "OracleResultSubmitted", "EventResolved"];

const eventCoder = new BorshEventCoder(IDL);
const accountsCoder = new BorshAccountsCoder(IDL);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** JSON-safe copy of decoded Anchor data (PublicKey/BN -> string, enums -> variant name). */
export function plain(v: any): any {
  if (v instanceof PublicKey) return v.toBase58();
  if (v && typeof v === "object" && typeof v.toString === "function" && v.constructor?.name === "BN") return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 1 && Object.keys(v[keys[0]] ?? {}).length === 0 && typeof v[keys[0]] === "object") return keys[0];
    return Object.fromEntries(keys.map((k) => [k, plain(v[k])]));
  }
  return v;
}

/** Panta instructions and events in one transaction's logs (only frames of the Panta program). */
export function decodeLogs(logs: string[]) {
  const ixs: string[] = [];
  const events: { name: string; data: any }[] = [];
  const stack: string[] = [];
  for (const l of logs) {
    let m;
    if ((m = l.match(/^Program (\w+) invoke/))) stack.push(m[1]);
    else if (/^Program \w+ (success|failed)/.test(l)) stack.pop();
    if (stack[stack.length - 1] !== PANTA_PROGRAM.toBase58()) continue;
    if ((m = l.match(/^Program log: Instruction: (\w+)/))) ixs.push(m[1]);
    else if ((m = l.match(/^Program data: (.+)$/))) {
      const ev = eventCoder.decode(m[1]);
      if (ev) events.push({ name: ev.name, data: plain(ev.data) });
    }
  }
  return { ixs, events };
}

/** Retries on 429/transient errors with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, tries = 8): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      if (i >= tries) throw e;
      await sleep(500 * 2 ** i);
    }
  }
}

async function scan(mainnet: Connection, maxSigs: number) {
  // 1. signatures, newest first
  const sigs: { signature: string; blockTime?: number | null; err: any }[] = [];
  let before: string | undefined;
  while (sigs.length < maxSigs) {
    const page = await withRetry(() =>
      mainnet.getSignaturesForAddress(PANTA_PROGRAM, { before, limit: Math.min(1000, maxSigs - sigs.length) })
    );
    if (!page.length) break;
    sigs.push(...page);
    before = page[page.length - 1].signature;
    process.stdout.write(`\rsignatures: ${sigs.length}`);
    if (page.length < 1000) break;
  }
  const ok = sigs.filter((s) => !s.err);
  console.log(`\n${sigs.length} signatures (${ok.length} succeeded); fetching transactions...`);

  // 2. transactions: ~10 per second (Helius free tier counts each tx in a batch)
  const ixCounts: Record<string, number> = {};
  const eventCounts: Record<string, number> = {};
  const rows: any[] = [];
  const BATCH = 10, INFLIGHT = 1;
  let done = 0;
  const batches: string[][] = [];
  for (let i = 0; i < ok.length; i += BATCH) batches.push(ok.slice(i, i + BATCH).map((s) => s.signature));
  for (let i = 0; i < batches.length; i += INFLIGHT) {
    const results = await Promise.all(
      batches.slice(i, i + INFLIGHT).map((b) =>
        withRetry(() => mainnet.getParsedTransactions(b, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }))
      )
    );
    for (const tx of results.flat()) {
      if (!tx?.meta?.logMessages) continue;
      const { ixs, events } = decodeLogs(tx.meta.logMessages);
      for (const x of ixs) ixCounts[x] = (ixCounts[x] ?? 0) + 1;
      for (const e of events) eventCounts[e.name] = (eventCounts[e.name] ?? 0) + 1;
      const hit = ixs.filter((x) => WATCHED_IXS.includes(x));
      const evs = events.filter((e) => DISPUTE_EVENTS.includes(e.name));
      if (!hit.length && !evs.length) continue;
      rows.push({
        signature: tx.transaction.signatures[0],
        time: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
        signers: tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey.toBase58()),
        instructions: hit,
        events: evs,
      });
    }
    done += results.flat().length;
    process.stdout.write(`\rtransactions: ${done}/${ok.length}`);
    await sleep(1000);
  }
  console.log();
  const times = sigs.map((s) => s.blockTime).filter((t): t is number => !!t);
  return { sigs, ok, ixCounts, eventCounts, rows, times };
}

async function currentState(mainnet: Connection) {
  const cfgInfo = await mainnet.getAccountInfo(MARKET_CONFIG);
  const marketConfig = cfgInfo ? plain(accountsCoder.decode("MarketConfig", cfgInfo.data)) : null;
  const rrDisc = Buffer.from(IDL.accounts.find((a: any) => a.name === "ReviewRequest").discriminator);
  const rr = await mainnet.getProgramAccounts(PANTA_PROGRAM, { filters: [{ memcmp: { offset: 0, bytes: require("bs58").encode(rrDisc) } }] });
  const reviewRequests = rr.map(({ pubkey, account }) => ({
    address: pubkey.toBase58(),
    lamports: account.lamports,
    ...plain(accountsCoder.decode("ReviewRequest", account.data)),
  }));
  return { marketConfig, reviewRequests };
}

async function main() {
  const maxSigs = Number(process.argv[2] ?? 10_000);
  const mainnet = new Connection(process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const { marketConfig, reviewRequests } = await currentState(mainnet);
  const s = await scan(mainnet, maxSigs);

  const disputes = s.rows.flatMap((r) => r.events.filter((e: any) => e.name === "MarketDisputed").map((e: any) => ({ signature: r.signature, time: r.time, ...e.data })));
  const settlements = s.rows.flatMap((r) => r.events.filter((e: any) => e.name === "ResolutionDisputeSettled").map((e: any) => ({ signature: r.signature, time: r.time, ...e.data })));
  const resolvers: Record<string, number> = {};
  for (const r of s.rows) if (r.instructions.some((x: string) => /Resolve|Oracle/.test(x))) for (const k of r.signers) resolvers[k] = (resolvers[k] ?? 0) + 1;
  const bonds = [...disputes, ...reviewRequests].map((d: any) => Number(d.bond_lamports)).filter((b) => b > 0);

  const out = {
    scannedAt: new Date().toISOString(),
    program: PANTA_PROGRAM.toBase58(),
    signaturesScanned: s.sigs.length,
    succeededTxs: s.ok.length,
    reachedProgramStart: s.sigs.length < maxSigs,
    range: s.times.length
      ? { from: new Date(Math.min(...s.times) * 1000).toISOString(), to: new Date(Math.max(...s.times) * 1000).toISOString() }
      : null,
    watchedInstructionCounts: Object.fromEntries(WATCHED_IXS.map((x) => [x, s.ixCounts[x] ?? 0])),
    disputeEventCounts: Object.fromEntries(DISPUTE_EVENTS.map((x) => [x, s.eventCounts[x] ?? 0])),
    allInstructionCounts: s.ixCounts,
    allEventCounts: s.eventCounts,
    bondLamports: bonds.length ? { count: bonds.length, min: Math.min(...bonds), max: Math.max(...bonds), values: bonds } : null,
    resolutionSigners: resolvers,
    disputes,
    settlements,
    reviewRequestsOnChainNow: reviewRequests,
    marketConfig,
    marketConfigNote: "MarketConfig has no bond field; the dispute bond is computed inside the program (see ReviewRequest.bond_lamports / MarketDisputed.bond_lamports).",
    rows: s.rows,
  };
  fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "out", "disputes.json"), JSON.stringify(out, null, 2));

  console.log(`range: ${out.range?.from} .. ${out.range?.to}  (${out.signaturesScanned} sigs, reached program start: ${out.reachedProgramStart})`);
  console.log("instructions:", out.watchedInstructionCounts);
  console.log("events:", out.disputeEventCounts);
  console.log("ReviewRequest accounts on chain now:", reviewRequests.length, reviewRequests.map((r) => `${r.review_kind}:${r.bond_lamports}`).join(", "));
  console.log("bonds (lamports):", out.bondLamports ?? "none observed");
  console.log("resolution signers:", resolvers);
  console.log(disputes.length ? `${disputes.length} MarketDisputed events found` : "0 MarketDisputed events in the scanned history.");
  console.log("wrote panta/out/disputes.json");
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
