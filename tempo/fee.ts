/**
 * A venue pays Saring's per-dispute fee in stablecoin on Tempo Moderato:
 * TIP-20 transferWithMemo(operator, 1.00 pathUSD, memo = 32-byte Saring court pubkey),
 * gas paid in AlphaUSD. Then reads the receipt back and decodes the memo to the court.
 *
 *   npx tsx fee.ts [courtAddress]
 */
import { parseEventLogs, parseUnits } from "viem";
import { Abis } from "viem/tempo";
import { readCourtVerdict } from "../sdk/src/venue";
import { PATH_USD, bytes32ToCourt, courtToBytes32, ensureFunded, logger, saveState, solana, state, tempoClient, txLink } from "./lib";

const FEE = parseUnits("1.00", 6); // TIP-20 stablecoins use 6 decimals

async function main() {
  const log = logger("fee");
  const court = process.argv[2] ?? "24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb";

  // The fee only makes sense for a real court: refuse anything the Saring program doesn't own.
  const v = await readCourtVerdict(solana(), court);
  log(`court ${court} on Solana devnet: "${v.court.market}" resolved=${v.resolved} outcome=${v.outcome}`);

  const venue = tempoClient("venue");
  const operator = tempoClient("operator");
  log(`venue ${venue.account.address}  operator ${operator.account.address}`);
  await ensureFunded(venue, log);

  const memo = courtToBytes32(court);
  const { receipt } = await venue.token.transferSync({ token: PATH_USD, to: operator.account.address, amount: FEE, memo });
  log(`transferWithMemo 1.00 pathUSD -> operator, memo ${memo}`);
  log(`  tx ${receipt.transactionHash} status=${receipt.status} block=${receipt.blockNumber} (tx type ${(receipt as any).type})`);
  log(`  gas: ${receipt.gasUsed} units, paid in fee token ${(receipt as any).feeToken ?? "AlphaUSD"} by ${(receipt as any).feePayer ?? venue.account.address}`);
  log(`  ${txLink(receipt.transactionHash)}`);

  // Verify from chain, not from what we sent: re-fetch the receipt and decode the TIP-20 event.
  const onchain = await venue.getTransactionReceipt({ hash: receipt.transactionHash });
  const ev = parseEventLogs({ abi: Abis.tip20, logs: onchain.logs, eventName: "TransferWithMemo" })[0];
  if (!ev) throw new Error("no TransferWithMemo event in receipt");
  const decoded = bytes32ToCourt(ev.args.memo);
  log(`verified: TransferWithMemo from=${ev.args.from} to=${ev.args.to} amount=${Number(ev.args.amount) / 1e6} memo->court ${decoded}`);
  if (decoded !== court || ev.args.amount !== FEE || ev.args.to !== operator.account.address) throw new Error("on-chain payment does not match");

  saveState({ scanFrom: state().scanFrom ?? Number(receipt.blockNumber) - 10, fees: [...(state().fees ?? []), { court, tx: receipt.transactionHash, amount: "1.00 pathUSD" }] });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
