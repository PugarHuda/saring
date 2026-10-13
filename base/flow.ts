/**
 * Saring x Reality.eth v3 on Base Sepolia, end to end:
 * deploy SaringArbitrator -> askQuestion (arbitrator = Saring) -> submitAnswer YES with a bond
 * -> disputer pays requestArbitration -> bind court -> relayer signs the resolved Saring court's
 * verdict (Solana devnet) -> rule() -> Reality.eth finalizes -> claimWinnings + withdraw.
 *
 *   npx tsx flow.ts [court]        (RPC_URL_EVM=http://127.0.0.1:8545 for an anvil-fork dry run)
 */
import { decodeEventLog, encodePacked, formatEther, keccak256, parseAbi, parseEther, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import fs from "node:fs";
import path from "node:path";
import { account, artifact, clients, courtToBytes32, logger, saveState, signCourtVerdict, txLink } from "./lib";

const REALITY = "0x86b653Dc9aa6d7311109276925927087573f91CB" as const; // reality.eth deployments/84532/ETH/RealityETH-3.0.json
const COURT = process.argv[2] ?? "24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb"; // resolved NO on devnet
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
  const log = logger(__dirname, "flow");
  const { pub, wallet } = clients(baseSepolia, "deployer");
  const dsp = clients(baseSepolia, "disputer").wallet;
  const me = wallet.account.address;
  const disputer = dsp.account.address;
  const relayer = account("relayer").address;
  const send = async (label: string, p: Promise<Hex>) => {
    const hash = await p;
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    log(`${label}: ${txLink(EXPLORER, hash)}`);
    saveState(__dirname, { [label]: hash });
    return rc;
  };

  log(`deployer ${me}: ${formatEther(await pub.getBalance({ address: me }))} ETH; disputer ${disputer}; relayer ${relayer}`);
  const art = artifact(__dirname, "SaringArbitrator");
  const dep = await send("deployArbitrator", wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [REALITY, relayer, FEE, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000000000000000000000000000"] } /* legacy EIP-712 demo: no Wormhole core; a VAA deployment takes no relayer (wormhole/) */));
  const ARB = dep.contractAddress as Address;
  log(`SaringArbitrator ${ARB} (${EXPLORER}/address/${ARB})`);
  saveState(__dirname, { arbitrator: ARB, court: COURT });

  // The disputer pays the arbitration fee from its own key (Reality.eth records it as requester / payee_if_wrong).
  await send("fundDisputer", wallet.sendTransaction({ to: disputer, value: parseEther("0.001") }));

  const question = `Saring demo: is the claim judged by Saring court ${COURT} true? ${new Date().toISOString()}␟saring␟en`;
  const ask = await send("askQuestion", wallet.writeContract({ address: REALITY, abi: realityAbi, functionName: "askQuestion", args: [0n, question, ARB, 86400, 0, BigInt(Date.now())] }));
  const ev = ask.logs.map((l) => { try { return decodeEventLog({ abi: realityAbi, ...l }); } catch { return null; } }).find((e) => e?.eventName === "LogNewQuestion");
  const qid = (ev!.args as any).question_id as Hex;
  log(`question_id ${qid}`);
  saveState(__dirname, { questionId: qid });

  await send("submitAnswerYES", wallet.writeContract({ address: REALITY, abi: realityAbi, functionName: "submitAnswer", args: [qid, YES, 0n], value: BOND }));
  await send("requestArbitration", dsp.writeContract({ address: ARB, abi: art.abi, functionName: "requestArbitration", args: [qid, BOND], value: FEE }));
  await send("bindCourt", wallet.writeContract({ address: ARB, abi: art.abi, functionName: "bindCourt", args: [qid, courtToBytes32(COURT)] }));

  // Relayer: read the court on Solana, sign, submit. Last history entry = the single YES answer above.
  const sv = await signCourtVerdict(COURT, "SaringArbitrator", baseSepolia.id, ARB, log);
  await send("rule", wallet.writeContract({ address: ARB, abi: art.abi, functionName: "rule", args: [qid, sv.message, sv.sigV, sv.r, sv.s, ZERO32, YES, me] }));
  await settle(qid);
}

/** After rule(): read the result and pay out. Resume with `RESUME=1 npx tsx flow.ts` (reads questionId from out/state.json). */
async function settle(qid: Hex) {
  const log = logger(__dirname, "flow");
  const { pub, wallet } = clients(baseSepolia, "deployer");
  const dsp = clients(baseSepolia, "disputer").wallet;
  const me = wallet.account.address;
  const disputer = dsp.account.address;
  const send = async (label: string, p: Promise<Hex>) => {
    const hash = await p;
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    log(`${label}: ${txLink(EXPLORER, hash)}`);
    saveState(__dirname, { [label]: hash });
    return rc;
  };
  // sepolia.base.org is load-balanced: a read right after a receipt can hit a node that hasn't seen the block yet,
  // and resultFor reverts until finalized. Wait until the node we hit agrees.
  for (let i = 0; !(await pub.readContract({ address: REALITY, abi: realityAbi, functionName: "isFinalized", args: [qid] })); i++) {
    if (i > 30) throw new Error("question not finalized after rule()");
    await new Promise((r) => setTimeout(r, 2000));
  }
  const answer = await pub.readContract({ address: REALITY, abi: realityAbi, functionName: "resultFor", args: [qid] });
  log(`Reality.eth isFinalized=${await pub.readContract({ address: REALITY, abi: realityAbi, functionName: "isFinalized", args: [qid] })} resultFor=${answer}`);

  // Bond payout: history (last to first) = [arbitrator answer credited to disputer, deployer's YES].
  const h1 = keccak256(encodePacked(["bytes32", "bytes32", "uint256", "address", "bool"], [ZERO32, YES, BOND, me, false]));
  await send("claimWinnings", dsp.writeContract({ address: REALITY, abi: realityAbi, functionName: "claimWinnings", args: [qid, [h1, ZERO32], [disputer, me], [0n, BOND], [answer, YES]] }));
  log(`disputer Reality.eth balance ${formatEther(await pub.readContract({ address: REALITY, abi: realityAbi, functionName: "balanceOf", args: [disputer] }))} ETH`);
  await send("withdraw", dsp.writeContract({ address: REALITY, abi: realityAbi, functionName: "withdraw" }));
}

(process.env.RESUME ? settle(JSON.parse(fs.readFileSync(path.join(__dirname, "out", "state.json"), "utf8")).questionId) : main()).catch((e) => {
  console.error(e);
  process.exit(1);
});
