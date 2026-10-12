/**
 * Saring x UMA OOv3 on Arbitrum Sepolia, end to end:
 * deploy SaringEscalationManager -> assertTruth (EM = Saring) -> bind court -> disputeAssertion
 * -> relayer signs the resolved Saring court's verdict (Solana devnet) -> resolve() -> settleAssertion.
 *
 *   npx tsx flow.ts [court]        (RPC_URL_EVM=http://127.0.0.1:8545 for an anvil-fork dry run)
 */
import { decodeEventLog, formatEther, parseAbi, stringToHex, toHex, type Address, type Hex } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { account, artifact, clients, courtToBytes32, logger, saveState, signCourtVerdict, txLink } from "./lib";

const OOV3 = "0x1037A21a30aEfF90c269b01c3933eB9a5285d9b8" as const; // UMA networks/421614.json
const DBT = "0x689FF0D2c17ECbB01477420aB18482A8DAd45186" as const; // UMA TestnetERC20 (default currency, allocateTo-mintable)
const BOND = 100n * 10n ** 18n; // OOv3 getMinimumBond(DBT)
const COURT = process.argv[2] ?? "24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb"; // resolved NO on devnet
const EXPLORER = "https://sepolia.arbiscan.io";

const ooAbi = parseAbi([
  "function assertTruth(bytes claim, address asserter, address callbackRecipient, address escalationManager, uint64 liveness, address currency, uint256 bond, bytes32 identifier, bytes32 domainId) returns (bytes32)",
  "function disputeAssertion(bytes32 assertionId, address disputer)",
  "function settleAssertion(bytes32 assertionId)",
  "function getAssertionResult(bytes32 assertionId) view returns (bool)",
  "event AssertionMade(bytes32 indexed assertionId, bytes32 domainId, bytes claim, address indexed asserter, address callbackRecipient, address escalationManager, address caller, uint64 expirationTime, address currency, uint256 bond, bytes32 indexed identifier)",
  "event AssertionSettled(bytes32 indexed assertionId, address indexed bondRecipient, bool disputed, bool settlementResolution, address settleCaller)",
]);
const erc20 = parseAbi([
  "function allocateTo(address to, uint256 amount)",
  "function approve(address, uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

async function main() {
  const log = logger(__dirname, "flow");
  const { pub, wallet } = clients(arbitrumSepolia, "deployer");
  const me = wallet.account.address;
  const disputer = account("disputer").address;
  const relayer = account("relayer").address;
  const link = (h: string) => txLink(EXPLORER, h);
  const send = async (label: string, p: Promise<Hex>) => {
    const hash = await p;
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    log(`${label}: ${link(hash)}`);
    saveState(__dirname, { [label]: hash });
    return rc;
  };

  log(`deployer ${me}: ${formatEther(await pub.getBalance({ address: me }))} ETH; disputer ${disputer}; relayer ${relayer}`);
  const em = artifact(__dirname, "SaringEscalationManager");
  const dep = await send("deployEM", wallet.deployContract({ abi: em.abi, bytecode: em.bytecode, args: [OOV3, relayer, "0x6b9C8671cdDC8dEab9c719bB87cBd3e782bA6a35", "0x54c231cefc5bd0966f82594e4333d6211f9a1ab4740be61271fdcb2d5ceb6238"] } /* + Wormhole core, saring emitter: see wormhole/ */));
  const EM = dep.contractAddress as Address;
  log(`SaringEscalationManager ${EM} (${EXPLORER}/address/${EM})`);
  saveState(__dirname, { escalationManager: EM, court: COURT });

  // Bonds: asserter (deployer) and disputer side both funded in DBT; the deployer pays the dispute
  // bond on the disputer's behalf (OOv3 credits the `disputer` argument), so the disputer key needs no gas.
  await send("mintDBT", wallet.writeContract({ address: DBT, abi: erc20, functionName: "allocateTo", args: [me, 2n * BOND] }));
  await send("approveDBT", wallet.writeContract({ address: DBT, abi: erc20, functionName: "approve", args: [OOV3, 2n * BOND] }));

  const claim = stringToHex(`Saring demo: the claim judged by Saring court ${COURT} (Solana devnet) is TRUE. ${new Date().toISOString()}`);
  const rc = await send("assertTruth", wallet.writeContract({
    address: OOV3, abi: ooAbi, functionName: "assertTruth",
    args: [claim, me, "0x0000000000000000000000000000000000000000", EM, 7200n, DBT, BOND, toHex("ASSERT_TRUTH", { size: 32 }), toHex(0, { size: 32 })],
  }));
  const made = rc.logs.map((l) => { try { return decodeEventLog({ abi: ooAbi, ...l }); } catch { return null; } }).find((e) => e?.eventName === "AssertionMade");
  const assertionId = (made!.args as any).assertionId as Hex;
  log(`assertionId ${assertionId}`);
  saveState(__dirname, { assertionId });

  await send("bindCourt", wallet.writeContract({ address: EM, abi: em.abi, functionName: "bindCourt", args: [assertionId, courtToBytes32(COURT)] }));
  await send("disputeAssertion", wallet.writeContract({ address: OOV3, abi: ooAbi, functionName: "disputeAssertion", args: [assertionId, disputer] }));

  // Relayer: read the court on Solana, sign, submit (any account may submit; only the relayer signature counts).
  const sv = await signCourtVerdict(COURT, "SaringEscalationManager", arbitrumSepolia.id, EM, log);
  await send("resolve", wallet.writeContract({ address: EM, abi: em.abi, functionName: "resolve", args: [assertionId, sv.message, sv.sigV, sv.r, sv.s] }));

  const before = await pub.readContract({ address: DBT, abi: erc20, functionName: "balanceOf", args: [disputer] });
  const st = await send("settleAssertion", wallet.writeContract({ address: OOV3, abi: ooAbi, functionName: "settleAssertion", args: [assertionId] }));
  const settled = st.logs.map((l) => { try { return decodeEventLog({ abi: ooAbi, ...l }); } catch { return null; } }).find((e) => e?.eventName === "AssertionSettled");
  const result = await pub.readContract({ address: OOV3, abi: ooAbi, functionName: "getAssertionResult", args: [assertionId] });
  const after = await pub.readContract({ address: DBT, abi: erc20, functionName: "balanceOf", args: [disputer] });
  log(`AssertionSettled: ${JSON.stringify(settled?.args)}`);
  log(`getAssertionResult = ${result}; disputer DBT +${formatEther(after - before)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
