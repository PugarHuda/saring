/**
 * Saring -> Tempo verdict relayer. Reads a resolved court on Solana devnet (sdk/src/venue.ts),
 * signs an EIP-712 Verdict attestation with the relayer key, and submits SaringMarket.settle()
 * on Tempo Moderato as a Tempo (0x76) transaction whose gas is paid in AlphaUSD.
 *
 *   npx tsx relayer.ts <courtAddress> [marketAddress]
 */
import { getContract, hashTypedData, parseSignature, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readCourtVerdict } from "../sdk/src/venue";
import { courtToBytes32, ensureFunded, key, logger, saveState, solana, state, tempoClient, txLink } from "./lib";
import { marketAbi } from "./market-abi";

export const verdictTypes = {
  Verdict: [
    { name: "court", type: "bytes32" },
    { name: "yes", type: "uint8" },
    { name: "no", type: "uint8" },
    { name: "excluded", type: "uint8" },
    { name: "incomplete", type: "bool" },
    { name: "resolvedSlot", type: "uint64" },
  ],
} as const;

export async function relay(court: string, market: Address, log: (s: string) => void) {
  const sol = solana();
  const v = await readCourtVerdict(sol, court); // refuses accounts not owned by the Saring program
  if (!v.resolved) throw new Error(`court ${court} is not resolved yet; nothing to relay`);
  const resolvedSlot = BigInt(await sol.getSlot("confirmed")); // court was already resolved at this slot
  log(`court ${court}: ${v.outcome} (yes ${v.yes}, no ${v.no}, excluded ${v.excluded}, incomplete ${v.incomplete}) observed at slot ${resolvedSlot}`);

  const relayer = tempoClient("relayer");
  await ensureFunded(relayer, log); // gas only, in AlphaUSD
  const message = { court: courtToBytes32(court), yes: v.yes, no: v.no, excluded: v.excluded, incomplete: v.incomplete, resolvedSlot };
  const domain = { name: "SaringMarket", version: "1", chainId: relayer.chain.id, verifyingContract: market } as const;
  const signature = await privateKeyToAccount(key("relayer")).signTypedData({ domain, types: verdictTypes, primaryType: "Verdict", message });
  const { r, s, yParity } = parseSignature(signature);

  const c = getContract({ address: market, abi: marketAbi, client: relayer });
  const onchainDigest = await c.read.verdictDigest([message]);
  if (onchainDigest !== hashTypedData({ domain, types: verdictTypes, primaryType: "Verdict", message })) throw new Error("EIP-712 digest mismatch");
  log(`signed EIP-712 Verdict by relayer ${relayer.account.address}, digest ${onchainDigest}`);

  const hash = await c.write.settle([message, yParity + 27, r, s]);
  const receipt = await relayer.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`settle reverted: ${hash}`);
  const [, , outcome] = await c.read.markets([message.court]);
  log(`settle() tx ${hash} (type ${receipt.type}, gas paid in ${(receipt as any).feeToken}) -> outcome ${["Open", "Yes", "No", "Refund"][outcome]}`);
  log(`  ${txLink(hash)}`);
  return hash;
}

if (require.main === module) {
  const log = logger("relayer");
  const court = process.argv[2];
  const market = (process.argv[3] ?? state().market) as Address;
  if (!court || !market) throw new Error("usage: relayer.ts <court> [market]");
  relay(court, market, log)
    .then((tx) => saveState({ settleTx: tx }))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
