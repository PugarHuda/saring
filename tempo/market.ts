/**
 * End-to-end on Tempo Moderato: a pathUSD YES/NO market that settles only on a Saring verdict.
 *   deploy SaringMarket(pathUSD, relayer) -> bettor A YES, bettor B NO (each one atomic Tempo batch
 *   tx: approve + bet) -> relayer.ts settles from the real Solana devnet court -> winner claims ->
 *   loser's claim and a late bet are both rejected by the contract.
 *
 *   (cd contracts && forge build) && npx tsx market.ts [courtAddress]
 */
import * as fs from "fs";
import * as path from "path";
import { encodeFunctionData, erc20Abi, getContract, parseUnits, type Address, type Hex } from "viem";
import { PATH_USD, addrLink, courtToBytes32, ensureFunded, logger, saveState, tempoClient, txLink } from "./lib";
import { marketAbi } from "./market-abi";
import { relay } from "./relayer";

const usd = (x: bigint) => (Number(x) / 1e6).toFixed(6);

async function main() {
  const log = logger("market");
  const court = process.argv[2] ?? "24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb";
  const id = courtToBytes32(court);
  const operator = tempoClient("operator");
  const relayer = tempoClient("relayer");
  const A = tempoClient("bettorA");
  const B = tempoClient("bettorB");
  for (const c of [operator, A, B]) await ensureFunded(c, log);

  // --- deploy (gas in AlphaUSD; Tempo has no native token) ---
  const art = JSON.parse(fs.readFileSync(path.join(__dirname, "contracts/out/SaringMarket.sol/SaringMarket.json"), "utf8"));
  const deployHash = await operator.deployContract({ abi: marketAbi, bytecode: art.bytecode.object as Hex, args: [PATH_USD, relayer.account.address] });
  const dr = await operator.waitForTransactionReceipt({ hash: deployHash });
  const market = dr.contractAddress as Address;
  if (dr.status !== "success" || !market) throw new Error(`deploy failed ${deployHash}`);
  log(`SaringMarket deployed at ${market} (token pathUSD, relayer ${relayer.account.address})`);
  log(`  deploy tx ${txLink(deployHash)}  contract ${addrLink(market)}`);
  saveState({ market, deployTx: deployHash, marketCourt: court });

  // --- bets: approve + bet in ONE Tempo transaction (type 0x76 batched calls, atomic) ---
  const bets: Record<string, Hex> = {};
  for (const [name, c, yes, amt] of [["A", A, true, "3"], ["B", B, false, "2"]] as const) {
    const amount = parseUnits(amt, 6);
    const r = await c.sendTransactionSync({
      calls: [
        { to: PATH_USD, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [market, amount] }) },
        { to: market, data: encodeFunctionData({ abi: marketAbi, functionName: "bet", args: [id, yes, amount] }) },
      ],
    } as any);
    if (r.status !== "success") throw new Error(`bet ${name} failed ${r.transactionHash}`);
    bets[name] = r.transactionHash;
    log(`bettor ${name} ${c.account.address} bets ${amt} pathUSD on ${yes ? "YES" : "NO"}: batched approve+bet tx (type ${r.type}) ${txLink(r.transactionHash)}`);
  }
  const m = getContract({ address: market, abi: marketAbi, client: operator });
  const [yesPool, noPool] = await m.read.markets([id]);
  log(`pools: YES ${usd(yesPool)} / NO ${usd(noPool)} pathUSD`);

  // --- relay the real Saring verdict ---
  const settleTx = await relay(court, market, log);

  // --- claims ---
  const pathBal = async (a: Address) => (await operator.token.getBalance({ token: PATH_USD, account: a })).amount;
  const claims: Record<string, Hex | string> = {};
  for (const [name, c] of [["A", A], ["B", B]] as const) {
    const due = await m.read.claimable([id, c.account.address]);
    if (due === 0n) {
      try {
        await c.simulateContract({ address: market, abi: marketAbi, functionName: "claim", args: [id], account: c.account });
        throw new Error(`bettor ${name} claim with nothing due did not revert`);
      } catch (e: any) {
        if (!/NothingToClaim/.test(e?.message ?? "")) throw e;
        claims[name] = "reverts NothingToClaim";
        log(`bettor ${name} has nothing to claim (contract reverts NothingToClaim)`);
      }
      continue;
    }
    const before = await pathBal(c.account.address);
    const hash = await c.writeContract({ address: market, abi: marketAbi, functionName: "claim", args: [id] } as any);
    const r = await c.waitForTransactionReceipt({ hash });
    const after = await pathBal(c.account.address);
    claims[name] = hash;
    log(`bettor ${name} claims ${usd(due)} pathUSD: tx ${txLink(hash)} status=${r.status}, pathUSD balance +${usd(after - before)}`);
  }

  // --- betting is closed after the attestation ---
  try {
    await A.simulateContract({ address: market, abi: marketAbi, functionName: "bet", args: [id, true, 1n], account: A.account });
    throw new Error("late bet did not revert");
  } catch (e: any) {
    if (!/MarketClosed/.test(e?.message ?? "")) throw e;
    log("late bet after settlement rejected: MarketClosed");
  }
  log(`contract pathUSD balance after claims: ${usd(await pathBal(market))}`);
  saveState({ bets, settleTx, claims });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
