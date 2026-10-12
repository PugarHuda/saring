/**
 * Saring x UMA OOv3, settled through Wormhole (no Saring key in the verdict path):
 * deploy SaringEscalationManager(oo, relayer, wormholeCore, saringEmitter) -> assertTruth (EM = Saring)
 * -> bind court -> disputeAssertion -> resolveWithVaa(guardian-signed VAA of the Solana court) -> settleAssertion.
 *
 *   npx tsx flow-uma.ts arbitrum [court]   Arbitrum Sepolia, bond 100 UMA TestnetERC20 (mintable)
 *   npx tsx flow-uma.ts sepolia  [court]   Ethereum Sepolia, bond 0.002 WETH (OOv3 minimum), key ~/.saring-eth
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createPublicClient, createWalletClient, decodeEventLog, formatEther, http, parseAbi, stringToHex, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia, sepolia } from "viem/chains";
import { account, artifact, courtToBytes32, logger } from "../arbitrum/lib";
import { attest, EMITTER } from "./attest";

const NET = {
  // UMA networks/421614.json; Wormhole testnet core (wormhole.com/docs/products/reference/contract-addresses)
  arbitrum: { chain: arbitrumSepolia, rpc: "https://sepolia-rollup.arbitrum.io/rpc", explorer: "https://sepolia.arbiscan.io",
    oo: "0x1037A21a30aEfF90c269b01c3933eB9a5285d9b8", core: "0x6b9C8671cdDC8dEab9c719bB87cBd3e782bA6a35",
    currency: "0x689FF0D2c17ECbB01477420aB18482A8DAd45186", bond: 100n * 10n ** 18n, weth: false },
  // UMA networks/11155111.json (OptimisticOracleV3); WETH is on its collateral whitelist with minimum bond 0.002
  sepolia: { chain: sepolia, rpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io",
    oo: "0xFd9e2642a170aDD10F53Ee14a93FcF2F31924944", core: "0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78",
    currency: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9", bond: 2n * 10n ** 15n, weth: true },
} as const;

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
  "function deposit() payable",
  "function withdraw(uint256)",
  "function approve(address, uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

async function main() {
  const which = process.argv[2] as keyof typeof NET;
  const n = NET[which];
  if (!n) throw new Error("usage: flow-uma.ts arbitrum|sepolia [court]");
  const court = process.argv[3] ?? "24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb";
  const log = logger(__dirname, `flow-${which}`);
  const key = which === "sepolia" ? (fs.readFileSync(path.join(os.homedir(), ".saring-eth", "deployer.key"), "utf8").trim() as Hex) : null;
  const me = key ? privateKeyToAccount(key) : account("deployer");
  const transport = http(process.env.RPC_URL_EVM ?? n.rpc); // RPC_URL_EVM: anvil fork dry run
  const pub = createPublicClient({ chain: n.chain, transport });
  const wallet = createWalletClient({ chain: n.chain, transport, account: me });
  // Sepolia's wallet holds ~0.01 ETH: pin a small tip instead of the 1-1.5 gwei default (base fee is ~0.001 gwei).
  const tip = 10_000_000n;
  const fees = which === "sepolia" ? { maxPriorityFeePerGas: tip, maxFeePerGas: 2n * (await pub.getGasPrice()) + tip } : {};
  const link = (h: string) => `${n.explorer}/tx/${h}`;
  const send = async (label: string, p: Promise<Hex>) => {
    const hash = await p;
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    log(`${label}: ${link(hash)}`);
    return rc;
  };

  const vaaFile = path.join(__dirname, "out", `vaa-${court}.json`);
  const att = fs.existsSync(vaaFile) ? JSON.parse(fs.readFileSync(vaaFile, "utf8")) : await attest(court);
  log(`court ${court}; VAA from Solana tx ${att.solanaTx} (emitter ${att.emitter}, seq ${att.sequence})`);
  log(`deployer ${me.address}: ${formatEther(await pub.getBalance({ address: me.address }))} ETH`);

  const em = artifact(path.join(__dirname, "..", "arbitrum"), "SaringEscalationManager");
  const emitter = toHex(EMITTER.toBytes());
  const dep = await send("deployEM", wallet.deployContract({ ...fees, abi: em.abi, bytecode: em.bytecode, args: [n.oo, account("relayer").address, n.core, emitter] }));
  const EM = dep.contractAddress as Address;
  log(`SaringEscalationManager ${EM} (${n.explorer}/address/${EM}); wormhole ${n.core}, saringEmitter ${emitter}`);

  // Both bonds from the deployer; the deployer is also the disputer, so the winning side's refund comes back here.
  if (n.weth) await send("wrapWETH", wallet.writeContract({ ...fees, address: n.currency, abi: erc20, functionName: "deposit", value: 2n * n.bond }));
  else await send("mintBondToken", wallet.writeContract({ ...fees, address: n.currency, abi: erc20, functionName: "allocateTo", args: [me.address, 2n * n.bond] }));
  await send("approve", wallet.writeContract({ ...fees, address: n.currency, abi: erc20, functionName: "approve", args: [n.oo, 2n * n.bond] }));

  const claim = stringToHex(`Saring x Wormhole demo: the claim judged by Saring court ${court} (Solana devnet) is TRUE. ${new Date().toISOString()}`);
  const rc = await send("assertTruth", wallet.writeContract({ ...fees,
    address: n.oo, abi: ooAbi, functionName: "assertTruth",
    args: [claim, me.address, "0x0000000000000000000000000000000000000000", EM, 7200n, n.currency, n.bond, toHex("ASSERT_TRUTH", { size: 32 }), toHex(0, { size: 32 })],
  }));
  const made = rc.logs.map((l) => { try { return decodeEventLog({ abi: ooAbi, ...l }); } catch { return null; } }).find((e) => e?.eventName === "AssertionMade");
  const assertionId = (made!.args as any).assertionId as Hex;
  log(`assertionId ${assertionId}`);

  await send("bindCourt", wallet.writeContract({ ...fees, address: EM, abi: em.abi, functionName: "bindCourt", args: [assertionId, courtToBytes32(court)] }));
  await send("disputeAssertion", wallet.writeContract({ ...fees, address: n.oo, abi: ooAbi, functionName: "disputeAssertion", args: [assertionId, me.address] }));
  await send("resolveWithVaa", wallet.writeContract({ ...fees, address: EM, abi: em.abi, functionName: "resolveWithVaa", args: [assertionId, att.vaa] }));

  const st = await send("settleAssertion", wallet.writeContract({ ...fees, address: n.oo, abi: ooAbi, functionName: "settleAssertion", args: [assertionId] }));
  const settled = st.logs.map((l) => { try { return decodeEventLog({ abi: ooAbi, ...l }); } catch { return null; } }).find((e) => e?.eventName === "AssertionSettled");
  log(`AssertionSettled: ${JSON.stringify(settled?.args)}`);
  log(`getAssertionResult = ${await pub.readContract({ address: n.oo, abi: ooAbi, functionName: "getAssertionResult", args: [assertionId] })}`);
  if (n.weth) {
    const bal = await pub.readContract({ address: n.currency, abi: erc20, functionName: "balanceOf", args: [me.address] });
    await send("unwrapWETH", wallet.writeContract({ ...fees, address: n.currency, abi: erc20, functionName: "withdraw", args: [bal] }));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
