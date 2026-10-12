/**
 * Base-native loop: real Limitless holders (Base mainnet) -> conflict-blind Saring court (Solana devnet)
 * -> Wormhole VAA -> Reality.eth v3 question on Base Sepolia ruled by SaringArbitrator.ruleWithVaa.
 *
 *   npx tsx limitless-court.ts [slug ...]          default: active Limitless markets opened in the last 6 days, top 10 by volume
 *   npx tsx limitless-court.ts --from-court <court> <slug>   skip to the Wormhole + Reality.eth part for an already resolved court
 *
 * 1. One chunked eth_getLogs scan (1000 blocks, public RPCs with fallback) of the Gnosis CTF Limitless uses, from the
 *    oldest candidate's creation block to head. Every TransferSingle/TransferBatch touching a candidate's YES/NO
 *    position id marks its from/to; CTF.balanceOfBatch at head confirms who still holds. The candidate with the most
 *    holders is the market.
 * 2. Saring court on devnet: juror A is that market's largest real holder (identity = evmIdentityId(address)),
 *    B and C are fresh EVM addresses confirmed to hold 0. All holders are mirrored encrypted. Scripted ballots:
 *    A YES, B/C NO. MPC drops A's ballot (excluded 1) without revealing whose it was.
 * 3. wormhole/attest.ts posts the verdict; wormhole/flow-reality.ts asks the mirrored question on Reality.eth (Base
 *    Sepolia), answers YES, requests arbitration, binds the court, and settles with ruleWithVaa.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";
import { Keypair } from "@solana/web3.js";
import { createPublicClient, http, parseAbi, parseAbiItem, type Address } from "viem";
import { base } from "viem/chains";
import { SaringClient, newBallotKey } from "../sdk/src/index";
import { evmIdentityId } from "../hyperliquid/hl";
import { main as realityFlow } from "../wormhole/flow-reality";
import { logger, saveState, solana } from "./lib";

const EXCHANGE = "0x05c748E2f4DcDe0ec9Fa8DDc40DE6b867f923fa5" as const; // Limitless CTFExchange (Base)
const ARB = "0x384822075dc735ea7de0b8417c9b4403bb9d682a" as const; // SaringArbitrator with ruleWithVaa (Base Sepolia), owner = deployer
const API = "https://api.limitless.exchange";
// ponytail: free endpoints only. Tenderly's public gateway serves archive logs (1000-block cap); publicnode only recent blocks.
const RPCS = (process.env.BASE_RPC ? [process.env.BASE_RPC] : []).concat([
  "https://gateway.tenderly.co/public/base",
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
]);
const CHUNK = 1000n;
const MAX_HOLDERS = 42; // court state holds 42 position slots (same cap as hyperliquid/court.ts)
const single = parseAbiItem("event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)");
const batch = parseAbiItem("event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)");
const ctfAbi = parseAbi(["function getCtf() view returns (address)", "function balanceOfBatch(address[] owners, uint256[] ids) view returns (uint256[])"]);
const clients = RPCS.map((url) => createPublicClient({ chain: base, transport: http(url, { retryCount: 0, timeout: 30_000 }) }));
const log = logger(__dirname, "limitless-court");
const devtx = (s: string) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;

/** Try each RPC in order (3 rounds) until one answers. */
async function rpc<T>(f: (c: (typeof clients)[number]) => Promise<T>): Promise<T> {
  let last: unknown;
  for (let round = 0; round < 3; round++)
    for (const c of clients)
      try {
        return await f(c);
      } catch (e) {
        last = e;
      }
  throw last;
}

type Market = { slug: string; title: string; conditionId: string; automationType: string; status: string; createdAt: string; expirationDate: string; volumeFormatted: string; tokens: { yes: string; no: string }; group?: string };

async function candidates(slugs: string[]): Promise<Market[]> {
  if (slugs.length) return Promise.all(slugs.map(async (s) => (await fetch(`${API}/markets/${s}`)).json()));
  const all: Market[] = [];
  for (let p = 1; ; p++) {
    const r = await (await fetch(`${API}/markets/active?limit=25&page=${p}`)).json();
    if (!r.data?.length) break;
    for (const m of r.data) (m.markets ?? [m]).forEach((s: Market) => all.push({ ...s, group: m.markets ? m.title : undefined }));
  }
  return all
    .filter((m) => m.tokens?.yes && Date.parse(m.createdAt) > Date.now() - 6 * 86400e3)
    .sort((a, b) => Number(b.volumeFormatted) - Number(a.volumeFormatted))
    .slice(0, 10);
}

async function holdersOf(ms: Market[]) {
  const ctf = (await rpc((c) => c.readContract({ address: EXCHANGE, abi: ctfAbi, functionName: "getCtf" }))) as Address;
  const head = await rpc((c) => c.getBlock());
  const owner = new Map<string, Market>(); // position id -> market
  for (const m of ms) for (const id of [m.tokens.yes, m.tokens.no]) owner.set(BigInt(id).toString(), m);
  const oldest = Math.min(...ms.map((m) => Date.parse(m.createdAt) / 1000));
  const from = head.number - BigInt(Math.ceil((Number(head.timestamp) - oldest) / 2)) - 1800n; // Base: 2 s blocks, 1 h margin
  const touched = new Map<string, Set<Address>>(ms.map((m) => [m.slug, new Set<Address>()]));
  const transfers = new Map<string, number>(ms.map((m) => [m.slug, 0]));
  const starts: bigint[] = [];
  for (let b = from; b <= head.number; b += CHUNK) starts.push(b);
  log(`CTF ${ctf}: eth_getLogs blocks ${from}..${head.number} (${starts.length} chunks of ${CHUNK}) for ${ms.length} candidate markets`);
  let done = 0, logs = 0;
  const work = async () => {
    for (let s; (s = starts.shift()) !== undefined; ) {
      const to = s + CHUNK - 1n > head.number ? head.number : s + CHUNK - 1n;
      const got = await rpc((c) => c.getLogs({ address: ctf, events: [single, batch], fromBlock: s, toBlock: to, strict: true }));
      logs += got.length;
      for (const l of got) {
        const a: any = l.args;
        const hit = new Set<Market>();
        for (const id of l.eventName === "TransferSingle" ? [a.id] : a.ids) {
          const m = owner.get(id.toString());
          if (m) hit.add(m);
        }
        for (const m of hit) {
          transfers.set(m.slug, transfers.get(m.slug)! + 1);
          for (const who of [a.from, a.to]) if (!/^0x0{40}$/.test(who)) touched.get(m.slug)!.add(who);
        }
      }
      if (++done % 50 === 0) console.log(`  ${done} chunks, ${logs} CTF logs`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, work));
  log(`scanned ${logs} CTF transfer logs`);

  return Promise.all(
    ms.map(async (m) => {
      const addrs = [...touched.get(m.slug)!].filter((a) => a.toLowerCase() !== EXCHANGE.toLowerCase());
      const [yes, no] = [BigInt(m.tokens.yes), BigInt(m.tokens.no)];
      const bals = addrs.length
        ? ((await rpc((c) => c.readContract({ address: ctf, abi: ctfAbi, functionName: "balanceOfBatch", args: [[...addrs, ...addrs], [...addrs.map(() => yes), ...addrs.map(() => no)]], blockNumber: head.number }))) as bigint[])
        : [];
      const holders = addrs
        .map((address, i) => ({ address, yes: bals[i], no: bals[i + addrs.length] }))
        .filter((h) => h.yes > 0n || h.no > 0n)
        .sort((x, y) => (y.yes + y.no > x.yes + x.no ? 1 : -1));
      return { m, ctf, block: head.number, from, transfers: transfers.get(m.slug)!, touched: addrs.length, holders };
    })
  );
}

/** Fresh EVM addresses with 0 shares in this market, confirmed by balanceOfBatch. */
async function cleanAddresses(ctf: Address, m: Market, n: number) {
  const out: Address[] = [];
  while (out.length < n) {
    const a = ("0x" + randomBytes(20).toString("hex")) as Address;
    const b = (await rpc((c) => c.readContract({ address: ctf, abi: ctfAbi, functionName: "balanceOfBatch", args: [[a, a], [BigInt(m.tokens.yes), BigInt(m.tokens.no)]] }))) as bigint[];
    if (b[0] === 0n && b[1] === 0n) out.push(a);
  }
  return out;
}

async function court(pick: Awaited<ReturnType<typeof holdersOf>>[number]) {
  const { m, ctf } = pick;
  const conn = solana();
  if (!(await conn.getGenesisHash()).startsWith("EtWTRABZaYq6iMfeYKouRu166VU2xqa1")) throw new Error("RPC is not Solana devnet");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
  const before = await conn.getBalance(payer.publicKey);
  const holders = pick.holders.slice(0, MAX_HOLDERS);
  const jurors = [
    { label: "juror A (real Limitless holder)", address: holders[0].address, yes: true },
    ...(await cleanAddresses(ctf, m, 2)).map((address, i) => ({ label: `juror ${"BC"[i]} (clean, 0 shares)`, address, yes: false })),
  ].map((j) => ({ ...j, jurorId: evmIdentityId(j.address), key: newBallotKey() }));

  const saring = new SaringClient(conn, payer);
  const label = Buffer.from(`limitless:${m.slug}`).subarray(0, 64).toString(); // court.market, <=64 bytes (slugs are ASCII)
  const r = await saring.openCourt(label);
  const courtAddr = r.court.toBase58();
  const txs: Record<string, string> = { open: devtx(r.callbackSig) };
  log(`court ${courtAddr} (id ${r.courtId}) "${label}" ${txs.open}`);
  for (const j of jurors) {
    txs[`seat ${j.address}`] = devtx((await saring.seatJuror(r.courtId, j.jurorId, j.key)).callbackSig);
    log(`seated ${j.label} ${j.address} id=${j.jurorId} ${txs[`seat ${j.address}`]}`);
  }
  const ids = holders.map((h) => evmIdentityId(h.address));
  (await saring.mirrorPositions(r.courtId, ids)).forEach((x, i) => {
    txs[`mirror ${i + 1}`] = devtx(x.callbackSig);
    log(`mirrored ${ids.length} Limitless holders, batch ${i + 1} (encrypted) ${txs[`mirror ${i + 1}`]}`);
  });
  for (const j of jurors) {
    txs[`cast ${j.address}`] = devtx((await saring.cast(r.courtId, { jurorId: j.jurorId, key: j.key, yes: j.yes })).callbackSig);
    log(`cast ${j.label} ${j.yes ? "YES" : "NO"} ${txs[`cast ${j.address}`]}`);
  }
  const v = await saring.resolve(r.courtId);
  txs.resolve = devtx(v.callbackSig);
  const verdict = { yes: v.yes, no: v.no, excluded: v.excluded, incomplete: v.incomplete, outcome: v.outcome };
  log(`verdict ${JSON.stringify(verdict)} ${txs.resolve}`);
  if (v.excluded < 1) throw new Error("expected the holder-juror's ballot to be excluded");
  const spent = (before - (await conn.getBalance(payer.publicKey))) / 1e9;
  log(`devnet SOL spent ${spent.toFixed(5)}`);
  return { court: courtAddr, courtId: r.courtId, label, jurors: jurors.map(({ key, ...j }) => j), mirroredIds: ids, txs, verdict, devnetSolSpent: spent };
}

async function main() {
  const args = process.argv.slice(2);
  const resumeCourt = args[0] === "--from-court" ? args[1] : undefined;
  const ms = await candidates(resumeCourt ? args.slice(2) : args);
  if (!ms.length) throw new Error("no candidate markets");
  let result: any;
  if (!resumeCourt) {
    const scanned = await holdersOf(ms);
    for (const s of scanned) log(`  ${s.m.slug}: ${s.transfers} transfers, ${s.touched} addresses touched, ${s.holders.length} holders`);
    const pick = scanned.sort((a, b) => b.holders.length - a.holders.length)[0];
    const { m } = pick;
    log(`\nmarket: "${m.group ? m.group + ": " : ""}${m.title}" (${m.slug}) ${m.automationType}/${m.status}, expires ${m.expirationDate}, condition ${m.conditionId}`);
    log(`holders at block ${pick.block} (CTF.balanceOfBatch, 6-decimal shares):`);
    for (const h of pick.holders) log(`  ${h.address}  YES ${(Number(h.yes) / 1e6).toFixed(2)}  NO ${(Number(h.no) / 1e6).toFixed(2)}  https://basescan.org/address/${h.address}`);
    if (!pick.holders.length) throw new Error("market has no holders");
    result = { market: m, ctf: pick.ctf, scan: { fromBlock: pick.from, toBlock: pick.block, transfers: pick.transfers }, holders: pick.holders, ...(await court(pick)) };
    saveState(__dirname, { limitlessCourt: result });
  } else {
    result = { market: ms[0], court: resumeCourt };
  }

  const m: Market = result.market;
  const question = `Limitless (Base) market "${m.group ? m.group + ": " : ""}${m.title}" [${m.slug}, CTF condition ${m.conditionId}]: does it resolve YES? Disputes go to Saring court ${result.court}␟limitless␟en`;
  const r = await realityFlow(result.court, question, ARB);
  log(`Reality.eth question ${r.qid} on arbitrator ${ARB}: resultFor = ${r.answer}`);
  saveState(__dirname, { limitlessCourt: { ...result, reality: { arbitrator: ARB, questionId: r.qid, resultFor: r.answer } } });
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
