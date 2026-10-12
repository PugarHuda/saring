/**
 * Saring x Reality.eth v3 on Base Sepolia, ruled through Wormhole (no Saring key in the verdict path):
 * deploy SaringArbitrator(reality, relayer, fee, wormholeCore, saringEmitter) -> askQuestion -> submitAnswer YES
 * -> disputer pays requestArbitration -> bind court -> ruleWithVaa(guardian-signed VAA) -> claimWinnings + withdraw.
 *
 *   npx tsx flow-reality.ts [court]        (RPC_URL_EVM=http://127.0.0.1:8545 for an anvil-fork dry run)
 */
import * as fs from "fs";
import * as path from "path";
import { decodeEventLog, encodePacked, formatEther, keccak256, parseAbi, parseEther, toHex, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { account, artifact, clients, courtToBytes32, logger, txLink } from "../arbitrum/lib";
import { attest, EMITTER } from "./attest";

const REALITY = "0x86b653Dc9aa6d7311109276925927087573f91CB" as const; // reality.eth deployments/84532/ETH/RealityETH-3.0.json
const CORE = "0x79A1027a6A159502049F10906D333EC57E95F083" as const; // Wormhole core, Base Sepolia (testnet)
const COURT = process.argv[2] ?? "24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb";
const EXPLORER = "https://sepolia.basescan.org";
const FEE = parseEther("0.00001");
const BOND = parseEther("0.00002");
const YES = "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex;
const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

const realityAbi = parseAbi([
  "function askQuestion(uint256 template_id, string question, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce) payable returns (bytes32)",
  "function submitAnswer(bytes32 question_id, bytes32 answer, uint256 max_previous) payable",
  "function resultFor(bytes32 question_id) view returns (bytes32)",
  "function isFinalized(bytes32 question_id) view returns (bool)",
  "function claimWinnings(bytes32 question_id, bytes32[] history_hashes, address[] addrs, uint256[] bonds, bytes32[] answers)",
  "function balanceOf(address) view returns (uint256)",
  "function withdraw()",
  "event LogNewQuestion(bytes32 indexed question_id, address indexed user, uint256 template_id, string question, bytes32 indexed content_hash, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce, uint256 created)",
]);

async function main() {
  const log = logger(__dirname, "flow-base");
  const { pub, wallet } = clients(baseSepolia, "deployer");
  const dsp = clients(baseSepolia, "disputer").wallet;
  const me = wallet.account.address;
  const disputer = dsp.account.address;
  const send = async (label: string, p: Promise<Hex>) => {
    const hash = await p;
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    log(`${label}: ${txLink(EXPLORER, hash)}`);
    return rc;
  };

  const vaaFile = path.join(__dirname, "out", `vaa-${COURT}.json`);
  const att = fs.existsSync(vaaFile) ? JSON.parse(fs.readFileSync(vaaFile, "utf8")) : await attest(COURT);
  log(`court ${COURT}; VAA from Solana tx ${att.solanaTx} (emitter ${att.emitter}, seq ${att.sequence})`);
  log(`deployer ${me}: ${formatEther(await pub.getBalance({ address: me }))} ETH; disputer ${disputer}`);

  const art = artifact(path.join(__dirname, "..", "base"), "SaringArbitrator");
  const emitter = toHex(EMITTER.toBytes());
  const dep = await send("deployArbitrator", wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [REALITY, account("relayer").address, FEE, CORE, emitter] }));
  const ARB = dep.contractAddress as Address;
  log(`SaringArbitrator ${ARB} (${EXPLORER}/address/${ARB}); wormhole ${CORE}, saringEmitter ${emitter}`);

  if ((await pub.getBalance({ address: disputer })) < parseEther("0.0001"))
    await send("fundDisputer", wallet.sendTransaction({ to: disputer, value: parseEther("0.0002") }));

  const question = `Saring x Wormhole demo: is the claim judged by Saring court ${COURT} true? ${new Date().toISOString()}␟saring␟en`;
  const ask = await send("askQuestion", wallet.writeContract({ address: REALITY, abi: realityAbi, functionName: "askQuestion", args: [0n, question, ARB, 86400, 0, BigInt(Date.now())] }));
  const ev = ask.logs.map((l) => { try { return decodeEventLog({ abi: realityAbi, ...l }); } catch { return null; } }).find((e) => e?.eventName === "LogNewQuestion");
  const qid = (ev!.args as any).question_id as Hex;
  log(`question_id ${qid}`);

  await send("submitAnswerYES", wallet.writeContract({ address: REALITY, abi: realityAbi, functionName: "submitAnswer", args: [qid, YES, 0n], value: BOND }));
  await send("requestArbitration", dsp.writeContract({ address: ARB, abi: art.abi, functionName: "requestArbitration", args: [qid, BOND], value: FEE }));
  await send("bindCourt", wallet.writeContract({ address: ARB, abi: art.abi, functionName: "bindCourt", args: [qid, courtToBytes32(COURT)] }));
  await finish(ARB, qid, att.vaa);
}

/** After bindCourt. Resume a run with `ARB=0x.. QID=0x.. npx tsx flow-reality.ts`. */
async function finish(ARB: Address, qid: Hex, vaa: Hex) {
  const log = logger(__dirname, "flow-base");
  const { pub, wallet } = clients(baseSepolia, "deployer");
  const dsp = clients(baseSepolia, "disputer").wallet;
  const me = wallet.account.address;
  const disputer = dsp.account.address;
  const art = artifact(path.join(__dirname, "..", "base"), "SaringArbitrator");
  const send = async (label: string, p: Promise<Hex>) => {
    const hash = await p;
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    log(`${label}: ${txLink(EXPLORER, hash)}`);
    return rc;
  };
  // sepolia.base.org is load-balanced: wait until the node we hit has seen bindCourt before simulating.
  for (let i = 0; (await pub.readContract({ address: ARB, abi: art.abi, functionName: "courtOf", args: [qid] })) !== courtToBytes32(COURT); i++) {
    if (i > 30) throw new Error("court not bound");
    await new Promise((r) => setTimeout(r, 2000));
  }
  // Submitted by the disputer: anyone can deliver the VAA, the contract only trusts the guardian signatures + emitter.
  await send("ruleWithVaa", dsp.writeContract({ address: ARB, abi: art.abi, functionName: "ruleWithVaa", args: [qid, vaa, ZERO32, YES, me] }));

  // sepolia.base.org is load-balanced: wait until the node we hit has seen the ruling.
  for (let i = 0; !(await pub.readContract({ address: REALITY, abi: realityAbi, functionName: "isFinalized", args: [qid] })); i++) {
    if (i > 30) throw new Error("question not finalized after ruleWithVaa()");
    await new Promise((r) => setTimeout(r, 2000));
  }
  const answer = await pub.readContract({ address: REALITY, abi: realityAbi, functionName: "resultFor", args: [qid] });
  log(`Reality.eth isFinalized=true resultFor=${answer}`);

  const h1 = keccak256(encodePacked(["bytes32", "bytes32", "uint256", "address", "bool"], [ZERO32, YES, BOND, me, false]));
  await send("claimWinnings", dsp.writeContract({ address: REALITY, abi: realityAbi, functionName: "claimWinnings", args: [qid, [h1, ZERO32], [disputer, me], [0n, BOND], [answer, YES]] }));
  log(`disputer Reality.eth balance ${formatEther(await pub.readContract({ address: REALITY, abi: realityAbi, functionName: "balanceOf", args: [disputer] }))} ETH`);
  await send("withdraw", dsp.writeContract({ address: REALITY, abi: realityAbi, functionName: "withdraw" }));
}

const resume = () => finish(process.env.ARB as Address, process.env.QID as Hex, JSON.parse(fs.readFileSync(path.join(__dirname, "out", `vaa-${COURT}.json`), "utf8")).vaa);
(process.env.QID ? resume() : main()).catch((e) => {
  console.error(e);
  process.exit(1);
});
