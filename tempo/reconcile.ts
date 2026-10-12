/**
 * Reconciles Saring's stablecoin income on Tempo against Saring courts on Solana:
 * scans TIP-20 TransferWithMemo events paid to the operator, maps memo -> court pubkey,
 * reads each court's verdict from Solana devnet, prints a settlement table.
 *
 *   npx tsx reconcile.ts [fromBlock]
 */
import { getAbiItem } from "viem";
import { Abis } from "viem/tempo";
import { readCourtVerdict } from "../sdk/src/venue";
import { ALPHA_USD, PATH_USD, bytes32ToCourt, logger, solana, state, tempoClient, txLink } from "./lib";

const CHUNK = 50_000n; // ponytail: fixed getLogs window; an indexer replaces this at scale

async function main() {
  const log = logger("reconcile");
  const operator = tempoClient("operator");
  const sol = solana();
  const latest = await operator.getBlockNumber();
  const from = process.argv[2] ? BigInt(process.argv[2]) : BigInt(state().scanFrom ?? Number(latest - 200_000n));
  const event = getAbiItem({ abi: Abis.tip20, name: "TransferWithMemo" });

  const logs = [];
  for (let b = from; b <= latest; b += CHUNK) {
    const to = b + CHUNK - 1n > latest ? latest : b + CHUNK - 1n;
    logs.push(...(await operator.getLogs({ address: [PATH_USD, ALPHA_USD], event, args: { to: operator.account.address }, fromBlock: b, toBlock: to })));
  }
  log(`operator ${operator.account.address}: ${logs.length} memo payments in blocks ${from}..${latest}`);

  const mppLedger = state().mppCourts ?? [];
  const rows = [];
  for (const l of logs) {
    const token = l.address.toLowerCase() === PATH_USD ? "pathUSD" : "AlphaUSD";
    const paid = `${(Number(l.args.amount) / 1e6).toFixed(2)} ${token}`;
    // Direct fee: memo IS the court pubkey. MPP payment: memo is MPP's attribution hash, so the
    // court comes from the MPP server's ledger (payment tx -> court it opened).
    const mpp = mppLedger.find((m: any) => m.paymentTx?.toLowerCase() === l.transactionHash.toLowerCase());
    const candidates = [bytes32ToCourt(l.args.memo!), mpp?.court].filter(Boolean) as string[];
    let court = "-", via = "-", verdict = "UNMATCHED (memo is not a Saring court)";
    for (const c of candidates) {
      try {
        const v = await readCourtVerdict(sol, c); // throws unless owned by the Saring program
        court = c;
        via = c === mpp?.court ? "MPP ledger" : "memo";
        verdict = v.resolved ? `${v.outcome} (yes ${v.yes} / no ${v.no} / excluded ${v.excluded})` : "OPEN (not resolved yet)";
        break;
      } catch {}
    }
    rows.push({ block: l.blockNumber, from: l.args.from, paid, court, via, verdict, tx: l.transactionHash });
  }

  log(["block", "payer", "paid", "saring court (devnet)", "matched via", "verdict", "tempo tx"].join(" | "));
  for (const r of rows) log([r.block, r.from, r.paid, r.court, r.via, r.verdict, txLink(r.tx)].join(" | "));
  const total = rows.reduce((s, r) => s + parseFloat(r.paid), 0);
  log(`total received: ${total.toFixed(2)} USD across ${rows.length} payments; ${rows.filter((r) => r.verdict.startsWith("UNMATCHED")).length} unmatched`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
