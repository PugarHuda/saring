/**
 * Saring x Tempo Moderato, settled through Wormhole (no Saring key in the verdict path):
 * deploy SaringMarket(pathUSD, relayer, wormholeCore, saringEmitter) -> bettor A YES, bettor B NO
 * (one batched 0x76 tx each) -> bettor B submits settleWithVaa(guardian-signed VAA) -> B claims the pool.
 *
 *   npx tsx flow-tempo.ts [court]
 */
import * as fs from "fs";
import * as path from "path";
import { encodeFunctionData, erc20Abi, parseUnits, toHex, type Address, type Hex } from "viem";
import { logger } from "../arbitrum/lib";
import { PATH_USD, addrLink, courtToBytes32, ensureFunded, tempoClient, txLink } from "../tempo/lib";
import { attest, EMITTER } from "./attest";

const CORE = "0xa29E8c21924834E6249bCE1FD733f24eC492018c" as const; // Wormhole core, Tempo testnet (wormhole.com/docs contract addresses)
const usd = (x: bigint) => (Number(x) / 1e6).toFixed(6);

async function main() {
  const court = process.argv[2] ?? "24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb";
  const id = courtToBytes32(court);
  const log = logger(__dirname, "flow-tempo");
  const vaaFile = path.join(__dirname, "out", `vaa-${court}.json`);
  const att = fs.existsSync(vaaFile) ? JSON.parse(fs.readFileSync(vaaFile, "utf8")) : await attest(court);
  log(`court ${court}; VAA from Solana tx ${att.solanaTx} (emitter ${att.emitter}, seq ${att.sequence})`);

  const operator = tempoClient("operator");
  const relayer = tempoClient("relayer");
  const A = tempoClient("bettorA");
  const B = tempoClient("bettorB");
  for (const c of [operator, A, B]) await ensureFunded(c, log);

  const art = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "tempo", "contracts/out/SaringMarket.sol/SaringMarket.json"), "utf8"));
  const abi = art.abi;
  const emitter = toHex(EMITTER.toBytes());
  const deployHash = await operator.deployContract({ abi, bytecode: art.bytecode.object as Hex, args: [PATH_USD, relayer.account.address, CORE, emitter] } as any);
  const dr = await operator.waitForTransactionReceipt({ hash: deployHash });
  const market = dr.contractAddress as Address;
  if (dr.status !== "success" || !market) throw new Error(`deploy failed ${deployHash}`);
  log(`SaringMarket ${market} (${addrLink(market)}); wormhole ${CORE}, saringEmitter ${emitter}`);
  log(`deployMarket: ${txLink(deployHash)}`);

  for (const [name, c, yes, amt] of [["A", A, true, "3"], ["B", B, false, "2"]] as const) {
    const amount = parseUnits(amt, 6);
    const r = await c.sendTransactionSync({
      calls: [
        { to: PATH_USD, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [market, amount] }) },
        { to: market, data: encodeFunctionData({ abi, functionName: "bet", args: [id, yes, amount] }) },
      ],
    } as any);
    if (r.status !== "success") throw new Error(`bet ${name} failed ${r.transactionHash}`);
    log(`bet${name} ${amt} pathUSD ${yes ? "YES" : "NO"} (batched approve+bet): ${txLink(r.transactionHash)}`);
  }

  // Bettor B delivers the VAA itself: no operator, no relayer key.
  const sh = await B.writeContract({ address: market, abi, functionName: "settleWithVaa", args: [att.vaa] } as any);
  const sr = await B.waitForTransactionReceipt({ hash: sh });
  if (sr.status !== "success") throw new Error(`settleWithVaa reverted ${sh}`);
  const [, , outcome] = (await operator.readContract({ address: market, abi, functionName: "markets", args: [id] })) as any;
  log(`settleWithVaa (sent by bettor B): ${txLink(sh)} -> outcome ${["Open", "Yes", "No", "Refund"][outcome]}`);

  const bal = async (a: Address) => (await operator.token.getBalance({ token: PATH_USD, account: a })).amount;
  const before = await bal(B.account.address);
  const ch = await B.writeContract({ address: market, abi, functionName: "claim", args: [id] } as any);
  const cr = await B.waitForTransactionReceipt({ hash: ch });
  log(`claimB: ${txLink(ch)} status=${cr.status}, pathUSD +${usd((await bal(B.account.address)) - before)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
