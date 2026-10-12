/**
 * Real holders of one Limitless Exchange market on Base mainnet, read from the chain:
 * ERC-1155 TransferSingle/TransferBatch logs of the Gnosis CTF Limitless uses (CTFExchange.getCtf()),
 * filtered to the market's YES/NO position ids, then confirmed with CTF.balanceOfBatch.
 * These are the addresses Saring would mirror into a court and exclude from its jury.
 *
 *   npx tsx limitless-holders.ts [market-slug]
 *   BASE_RPC=<archive rpc> npx tsx limitless-holders.ts   # full eth_getLogs scan since market creation
 */
import { createPublicClient, http, parseAbi, parseAbiItem, parseEventLogs, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { logger, saveState } from "./lib";

const EXCHANGE = "0x05c748E2f4DcDe0ec9Fa8DDc40DE6b867f923fa5" as const; // Limitless CTFExchange (Base)
const SLUG = process.argv[2] ?? "bills-vs-rams-1791332408841"; // highest-volume `manual` (admin-resolved) market on 2026-10-12
const ZERO = "0x0000000000000000000000000000000000000000";
const single = parseAbiItem("event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)");
const batch = parseAbiItem("event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)");

async function main() {
  const log = logger(__dirname, "limitless-holders");
  const m = await (await fetch(`https://api.limitless.exchange/markets/${SLUG}`)).json();
  const ids = { [BigInt(m.tokens.yes).toString()]: "YES", [BigInt(m.tokens.no).toString()]: "NO" } as Record<string, string>;
  const pub = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC ?? "https://base.drpc.org") });
  const ctf = (await pub.readContract({ address: EXCHANGE, abi: parseAbi(["function getCtf() view returns (address)"]), functionName: "getCtf" })) as Address;
  log(`Limitless market "${m.title}" (${SLUG}), automationType=${m.automationType}, status=${m.status}, condition ${m.conditionId}`);
  log(`exchange ${EXCHANGE} -> getCtf() ${ctf}`);

  const latest = await pub.getBlock();
  const touched = new Set<Address>();
  let transfers = 0;
  const take = (l: any) => {
    const a = l.args;
    const hit = l.eventName === "TransferSingle" ? ids[a.id.toString()] : a.ids.some((i: bigint) => ids[i.toString()]);
    if (!hit) return;
    transfers++;
    for (const who of [a.from, a.to]) if (who !== ZERO) touched.add(who);
  };
  let source: string;
  if (process.env.BASE_RPC) {
    // Archive RPC: scan every CTF transfer since the market was created (Base: one block per 2 s).
    const from = latest.number - BigInt(Math.ceil((Number(latest.timestamp) - Date.parse(m.createdAt) / 1000) / 2)) - 1800n;
    for (let start = from, step = 5_000n; start <= latest.number; ) {
      const end = start + step - 1n > latest.number ? latest.number : start + step - 1n;
      try {
        (await pub.getLogs({ address: ctf, events: [single, batch], fromBlock: start, toBlock: end })).forEach(take);
        start = end + 1n;
      } catch (e) {
        if (step <= 100n) throw e;
        step /= 2n;
      }
    }
    source = `eth_getLogs blocks ${from}..${latest.number}`;
  } else {
    // ponytail: free public RPCs rate-limit / archive-gate a 5-day CTF log scan (~150k logs), so read the
    // TransferSingle/Batch logs from the receipts of every fill Limitless lists for this market instead.
    const txs = new Set<Hex>();
    for (let page = 1; ; page++) {
      const r = await (await fetch(`https://api.limitless.exchange/markets/${SLUG}/events?page=${page}&limit=100`)).json();
      r.events.forEach((e: any) => e.txHash && txs.add(e.txHash));
      if (page >= r.totalPages) break;
    }
    for (const hash of txs) {
      const rc = await pub.getTransactionReceipt({ hash });
      parseEventLogs({ abi: [single, batch], logs: rc.logs.filter((l) => l.address.toLowerCase() === ctf.toLowerCase()) }).forEach(take);
    }
    source = `receipts of ${txs.size} fill txs listed by api.limitless.exchange`;
  }
  log(`${source}: ${transfers} transfers of this market's positions, ${touched.size} addresses touched`);

  const addrs = [...touched];
  const yesId = BigInt(m.tokens.yes), noId = BigInt(m.tokens.no);
  const bals = (await pub.readContract({
    address: ctf,
    abi: parseAbi(["function balanceOfBatch(address[] owners, uint256[] ids) view returns (uint256[])"]),
    functionName: "balanceOfBatch",
    args: [[...addrs, ...addrs], [...addrs.map(() => yesId), ...addrs.map(() => noId)]],
    blockNumber: latest.number,
  })) as bigint[];
  const holders = addrs
    .map((a, i) => ({ address: a, yes: bals[i], no: bals[i + addrs.length] }))
    .filter((h) => (h.yes > 0n || h.no > 0n) && h.address.toLowerCase() !== EXCHANGE.toLowerCase());
  holders.sort((x, y) => Number(y.yes + y.no - (x.yes + x.no)));
  log(`holders at block ${latest.number} (CTF.balanceOfBatch, 6-decimal shares):`);
  for (const h of holders) log(`  ${h.address}  YES ${(Number(h.yes) / 1e6).toFixed(2)}  NO ${(Number(h.no) / 1e6).toFixed(2)}  https://basescan.org/address/${h.address}`);
  saveState(__dirname, { limitless: { slug: SLUG, conditionId: m.conditionId, ctf, block: latest.number, holders } });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
