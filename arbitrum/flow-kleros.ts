/**
 * Saring as a Kleros v2 IArbitratorV2 on Arbitrum Sepolia, end to end:
 * deploy SaringArbitratorV2 + SaringEscrow (IArbitrableV2) -> open a deal -> dispute (pays arbitrationCost,
 * escrow calls createDispute) -> bindCourt -> ruleWithVaa(guardian-signed VAA of the Solana court)
 * -> arbitrator calls escrow.rule() -> escrow pays out.
 *
 *   npx tsx flow-kleros.ts [court]   (RPC_URL_EVM=http://127.0.0.1:8545 for an anvil-fork dry run)
 * The VAA comes from ../wormhole/out/vaa-<court>.json (wormhole/attest.ts writes it).
 */
import * as fs from "fs";
import * as path from "path";
import { decodeEventLog, formatEther, parseEther, type Address, type Hex } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { account, artifact, clients, courtToBytes32, logger, saveState, txLink } from "./lib";

const CORE = "0x6b9C8671cdDC8dEab9c719bB87cBd3e782bA6a35" as const; // Wormhole core, Arbitrum Sepolia
const EMITTER = "0x54c231cefc5bd0966f82594e4333d6211f9a1ab4740be61271fdcb2d5ceb6238" as const; // saring_wormhole PDA
const COURT = process.argv[2] ?? "24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb"; // resolved NO on devnet
const FEE = parseEther("0.00001"); // arbitrationCost; forwarded to the operator (= deployer here)
const DEAL = parseEther("0.0001");
const EXPLORER = "https://sepolia.arbiscan.io";

async function main() {
  const log = logger(__dirname, "flow-kleros");
  const { pub, wallet } = clients(arbitrumSepolia, "deployer");
  const me = wallet.account.address;
  const payee = account("disputer").address; // needs no gas: the payer (deployer) opens and disputes
  const att = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "wormhole", "out", `vaa-${COURT}.json`), "utf8"));
  const link = (h: string) => txLink(EXPLORER, h);
  let gasEth = 0n;
  const send = async (label: string, p: Promise<Hex>) => {
    const hash = await p;
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    gasEth += rc.gasUsed * rc.effectiveGasPrice;
    log(`${label}: ${link(hash)} (gas ${rc.gasUsed})`);
    saveState(__dirname, { [`kleros_${label}`]: hash });
    return rc;
  };

  log(`deployer ${me}: ${formatEther(await pub.getBalance({ address: me }))} ETH; payee ${payee}; court ${COURT}, VAA from Solana tx ${att.solanaTx}`);
  const A = artifact(__dirname, "SaringArbitratorV2");
  const E = artifact(__dirname, "SaringEscrow");
  const ARB = (await send("deployArbitrator", wallet.deployContract({ abi: A.abi, bytecode: A.bytecode, args: [CORE, EMITTER, FEE] }))).contractAddress as Address;
  const ESC = (await send("deployEscrow", wallet.deployContract({ abi: E.abi, bytecode: E.bytecode, args: [ARB] }))).contractAddress as Address;
  log(`SaringArbitratorV2 ${EXPLORER}/address/${ARB}\nSaringEscrow ${EXPLORER}/address/${ESC}`);
  saveState(__dirname, { klerosArbitrator: ARB, klerosEscrow: ESC, klerosCourt: COURT });

  await send("open", wallet.writeContract({ address: ESC, abi: E.abi, functionName: "open", args: [payee], value: DEAL }));
  const dealId = 0n;
  const cost = (await pub.readContract({ address: ARB, abi: A.abi, functionName: "arbitrationCost", args: ["0x"] })) as bigint;
  const rc = await send("dispute", wallet.writeContract({ address: ESC, abi: E.abi, functionName: "dispute", args: [dealId], value: cost }));
  const created = rc.logs.map((l) => { try { return decodeEventLog({ abi: A.abi, ...l }); } catch { return null; } }).find((e) => e?.eventName === "DisputeCreation");
  const disputeID = (created!.args as any)._disputeID as bigint;
  log(`DisputeCreation disputeID ${disputeID} (arbitrationCost ${formatEther(cost)} ETH)`);

  await send("bindCourt", wallet.writeContract({ address: ARB, abi: A.abi, functionName: "bindCourt", args: [disputeID, courtToBytes32(COURT)] }));
  const before = await pub.getBalance({ address: payee });
  const ruled = await send("ruleWithVaa", wallet.writeContract({ address: ARB, abi: A.abi, functionName: "ruleWithVaa", args: [disputeID, att.vaa] }));
  for (const l of ruled.logs) {
    for (const abi of [A.abi, E.abi]) {
      try { const e = decodeEventLog({ abi, ...l }); log(`  ${e.eventName} ${JSON.stringify(e.args, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`); break; } catch {}
    }
  }
  const [ruling, tied, overridden] = (await pub.readContract({ address: ARB, abi: A.abi, functionName: "currentRuling", args: [disputeID] })) as [bigint, boolean, boolean];
  const deal = (await pub.readContract({ address: ESC, abi: E.abi, functionName: "deals", args: [dealId] })) as any[];
  log(`currentRuling = (${ruling}, tied ${tied}, overridden ${overridden}); deal closed ${deal[5]}; payee +${formatEther((await pub.getBalance({ address: payee })) - before)} ETH; escrow balance ${formatEther(await pub.getBalance({ address: ESC }))}`);
  log(`total gas paid ${formatEther(gasEth)} ETH; deployer now ${formatEther(await pub.getBalance({ address: me }))} ETH`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
