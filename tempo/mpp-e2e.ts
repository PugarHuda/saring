/**
 * One paid dispute, end to end, no step skipped:
 *  1. a venue bot pays the MPP 402 (0.50 pathUSD on Tempo) and the MPP server opens a REAL Saring court on Solana devnet
 *  2. 3 jurors are seated; juror A is secretly conflicted (its identity is mirrored as a position holder)
 *  3. ballots: A YES, B NO, C NO; Arcium MPC drops A's ballot and resolves NO (yes 0 / no 2 / excluded 1)
 *  4. saring_wormhole posts the verdict; the guardian-signed VAA is fetched from Wormholescan
 *  5. a fresh SaringMarket for this court gets a YES and a NO bet (one batched 0x76 tx each)
 *  6. settleWithVaa is sent by a brand-new ZERO-BALANCE address as a 0x76 tx whose feePayer is the
 *     operator, paying the fee in pathUSD: the 402 fee pays for the settlement
 *  7. the operator sends the payer a TIP-20 transferWithMemo receipt (memo = court pubkey)
 *  8. reconcile.ts shows the MPP payment as resolved
 *
 *   npx tsx mpp-e2e.ts ["question <= 64 bytes"]      -> out/mpp-e2e.log, out/state.json (mppE2E)
 *   npx tsx mpp-e2e.ts --resume                       continue from the last checkpoint (Tempo RPC 502s happen)
 */
import { execFileSync, spawn } from "child_process";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Keypair } from "@solana/web3.js";
import { Receipt } from "mppx";
import { Mppx, tempo } from "mppx/client";
import { encodeFunctionData, erc20Abi, parseUnits, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Account, createClient, http } from "viem/tempo";
import { tempoModerato } from "viem/chains";
import { SaringClient, identityId, newBallotKey } from "../sdk/src";
import { attest, EMITTER } from "../wormhole/attest";
import { PATH_USD, addrLink, courtToBytes32, ensureFunded, key, logger, saveState, solana, state, tempoClient, txLink } from "./lib";

const CORE = "0xa29E8c21924834E6249bCE1FD733f24eC492018c" as const; // Wormhole core, Tempo testnet
const PORT = 8788;
const sol = (s: string) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;
const log = logger("mpp-e2e");

/** Starts mpp-server.ts as its own process (the real server, unmodified) and waits until it listens. */
function startServer() {
  const f = path.join(os.homedir(), ".saring-tempo", "mpp-secret");
  const secret = fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : randomBytes(32).toString("hex");
  const p = spawn("npx", ["tsx", "mpp-server.ts"], { cwd: __dirname, env: { ...process.env, MPP_SECRET_KEY: secret, PORT: String(PORT) } });
  p.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  return new Promise<typeof p>((ok, fail) => {
    p.stdout.on("data", (d) => {
      process.stdout.write(`[server] ${d}`);
      if (String(d).includes("MPP court endpoint")) ok(p);
    });
    p.on("exit", (c) => fail(new Error(`mpp-server exited ${c}`)));
  });
}

async function main() {
  const resume = process.argv[2] === "--resume";
  const question = (!resume && process.argv[2]) || "MPP e2e: did the venue's market resolve YES?";
  const url = `http://localhost:${PORT}/courts`;
  const venue = tempoClient("venue");
  const operator = tempoClient("operator");
  const A = tempoClient("bettorA");
  const B = tempoClient("bettorB");
  for (const c of [venue, operator, A, B]) await ensureFunded(c, log);

  const conn = solana();
  const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
  const solBefore = await conn.getBalance(owner.publicKey);
  const r: Record<string, any> = resume ? state().mppE2E : { question };
  const save = () => saveState({ mppE2E: r }); // checkpoint after every step
  if (resume) log(`resuming court ${r.court} from checkpoint`);

  if (!r.court) {
  // 1. pay the 402; the server opens the court
  const server = await startServer();
  let opened: any;
  try {
    const raw = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
    log(`1. unpaid POST /courts -> HTTP ${raw.status} (${raw.headers.get("www-authenticate")?.slice(0, 60)}...)`);
    const mppx = Mppx.create({ methods: [tempo({ account: privateKeyToAccount(key("venue")), expectedChainId: 42431 })], polyfill: false });
    const res = await mppx.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
    opened = await res.json();
    if (!res.ok) throw new Error(`paid request failed: HTTP ${res.status} ${JSON.stringify(opened)}`);
    r.paymentTx = Receipt.fromResponse(res).reference;
  } finally {
    server.kill();
  }
  Object.assign(r, { court: opened.court, courtId: opened.courtId, open: opened.callbackSig });
  log(`   paid 0.50 pathUSD: ${txLink(r.paymentTx)}`);
  log(`   court ${r.court} (id ${r.courtId}) opened on devnet: ${sol(r.open)}`);

  // 2-3. seat, mirror the conflicted juror, vote, resolve (same authority as the server: courts are PDAs of it)
  const saring = new SaringClient(conn, owner);
  const jurors = await Promise.all(
    [["A (conflicted)", true], ["B", false], ["C", false]].map(async ([label, yes]) => ({
      label: label as string, yes: yes as boolean, jurorId: await identityId(Keypair.generate().publicKey), key: newBallotKey(),
    }))
  );
  r.seats = [];
  for (const j of jurors) {
    const s = await saring.seatJuror(r.courtId, j.jurorId, j.key);
    r.seats.push(s.callbackSig);
    log(`2. seated juror ${j.label}: ${sol(s.callbackSig)}`);
  }
  const [m] = await saring.mirrorPositions(r.courtId, [jurors[0].jurorId]);
  r.mirror = m.callbackSig;
  log(`   mirrored juror A's identity as a position holder (encrypted): ${sol(m.callbackSig)}`);
  r.casts = [];
  for (const j of jurors) {
    const c = await saring.cast(r.courtId, { jurorId: j.jurorId, key: j.key, yes: j.yes });
    r.casts.push(c.callbackSig);
    log(`3. juror ${j.label} votes ${j.yes ? "YES" : "NO"}: ${sol(c.callbackSig)}`);
  }
  const v = await saring.resolve(r.courtId);
  r.resolve = v.callbackSig;
  r.verdict = { outcome: v.outcome, yes: v.yes, no: v.no, excluded: v.excluded, incomplete: v.incomplete };
  log(`   MPC resolved ${v.outcome} (yes ${v.yes} / no ${v.no} / excluded ${v.excluded}): ${sol(v.callbackSig)}`);
  r.solSpent = (solBefore - (await conn.getBalance(owner.publicKey))) / 1e9;
  log(`   devnet SOL spent on the court: ${r.solSpent.toFixed(5)}`);
  save();
  }

  // 4. Wormhole VAA
  const vaaFile = path.join(__dirname, "..", "wormhole", "out", `vaa-${r.court}.json`);
  const att = fs.existsSync(vaaFile) ? JSON.parse(fs.readFileSync(vaaFile, "utf8")) : await attest(r.court);
  Object.assign(r, { wormholeTx: att.solanaTx, sequence: att.sequence });
  log(`4. saring_wormhole post: ${sol(att.solanaTx)}`);
  log(`   VAA seq ${att.sequence}: https://wormholescan.io/#/tx/${att.solanaTx}?network=Testnet`);

  save();

  // 5. fresh market bound to this court (market id = court pubkey) + one bet per side
  const art = JSON.parse(fs.readFileSync(path.join(__dirname, "contracts/out/SaringMarket.sol/SaringMarket.json"), "utf8"));
  const abi = art.abi;
  const id = courtToBytes32(r.court);
  if (!r.market) {
  // relayer = address(0): VAA path only, no Saring key can settle this market
  const dh = await operator.deployContract({ abi, bytecode: art.bytecode.object as Hex, args: [PATH_USD, "0x0000000000000000000000000000000000000000", CORE, toHex(EMITTER.toBytes())] } as any);
  const dr = await operator.waitForTransactionReceipt({ hash: dh });
  if (dr.status !== "success" || !dr.contractAddress) throw new Error(`deploy failed ${dh}`);
  Object.assign(r, { market: dr.contractAddress, deployTx: dh });
  log(`5. SaringMarket ${addrLink(r.market)} (relayer = 0x0, VAA only): ${txLink(dh)}`);
  save();
  }
  const market = r.market as Address;
  if (!r.openTx) {
    // Betting deadline (security review finding 2). In production the operator opens before voting starts.
    r.openTx = await operator.writeContract({ address: market, abi, functionName: "open", args: [id, BigInt(Math.floor(Date.now() / 1000) + 600)] } as any);
    await operator.waitForTransactionReceipt({ hash: r.openTx });
    log(`   open(court, closesAt = now + 10 min): ${txLink(r.openTx)}`);
    save();
  }
  r.bets ??= {};
  for (const [name, c, yes, amt] of [["A", A, true, "3"], ["B", B, false, "2"]] as const) {
    if (r.bets[name]) continue;
    const amount = parseUnits(amt, 6);
    const br = await c.sendTransactionSync({
      calls: [
        { to: PATH_USD, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [market, amount] }) },
        { to: market, data: encodeFunctionData({ abi, functionName: "bet", args: [id, yes, amount] }) },
      ],
    } as any);
    if (br.status !== "success") throw new Error(`bet ${name} failed ${br.transactionHash}`);
    r.bets[name] = br.transactionHash;
    log(`   bettor ${name} ${amt} pathUSD ${yes ? "YES" : "NO"} (approve+bet, one 0x76 tx): ${txLink(br.transactionHash)}`);
    save();
  }

  if (!r.settleTx) {
  // 6. sponsored settle: zero-balance submitter, operator pays the fee in pathUSD
  const submitter = createClient({ account: Account.fromSecp256k1(generatePrivateKey()), chain: tempoModerato, transport: http("https://rpc.moderato.tempo.xyz") });
  const sponsor = Account.fromSecp256k1(key("operator"));
  const subBal = (await operator.token.getBalance({ token: PATH_USD, account: submitter.account.address })).amount;
  const opBefore = (await operator.token.getBalance({ token: PATH_USD, account: operator.account.address })).amount;
  const sh = await submitter.writeContract({ address: market, abi, functionName: "settleWithVaa", args: [att.vaa], feePayer: sponsor, feeToken: PATH_USD } as any);
  const sr = await operator.waitForTransactionReceipt({ hash: sh });
  if (sr.status !== "success") throw new Error(`settleWithVaa reverted ${sh}`);
  const opAfter = (await operator.token.getBalance({ token: PATH_USD, account: operator.account.address })).amount;
  const [, , outcome] = (await operator.readContract({ address: market, abi, functionName: "markets", args: [id] })) as any;
  Object.assign(r, { settleTx: sh, submitter: submitter.account.address, outcome: ["Open", "Yes", "No", "Refund"][outcome] });
  log(`6. settleWithVaa from ${submitter.account.address} (pathUSD balance ${subBal}), feePayer = operator: ${txLink(sh)}`);
  log(`   tx type ${(sr as any).type}, fee payer ${(sr as any).feePayer ?? "?"}; operator paid ${(Number(opBefore - opAfter) / 1e6).toFixed(6)} pathUSD gas; market outcome ${r.outcome}`);
  save();
  }
  if (!r.claimB) {
  const bb = (await operator.token.getBalance({ token: PATH_USD, account: B.account.address })).amount;
  const ch = await B.writeContract({ address: market, abi, functionName: "claim", args: [id] } as any);
  await B.waitForTransactionReceipt({ hash: ch });
  r.claimB = ch;
  save();
  log(`   bettor B claims +${(Number((await operator.token.getBalance({ token: PATH_USD, account: B.account.address })).amount - bb) / 1e6).toFixed(2)} pathUSD: ${txLink(ch)}`);

  }

  // 7. receipt to the payer
  if (!r.receiptTx) {
  const { receipt } = await operator.token.transferSync({ token: PATH_USD, to: venue.account.address, amount: 10_000n, memo: id });
  r.receiptTx = receipt.transactionHash;
  log(`7. receipt 0.01 pathUSD transferWithMemo -> payer ${venue.account.address}, memo = court ${id}: ${txLink(receipt.transactionHash)}`);
  save();
  }

  // 8. reconcile (the MPP ledger entry written by the server maps paymentTx -> court)
  const out = execFileSync("npx", ["tsx", "reconcile.ts"], { cwd: __dirname, encoding: "utf8" });
  const row = out.split("\n").find((l) => l.toLowerCase().includes(String(r.paymentTx).toLowerCase()));
  log(`8. reconcile row for this payment: ${row ?? "(not found)"}`);
  if (!row?.includes(`${r.verdict.outcome} (`)) throw new Error("reconcile does not show the dispute resolved");
  log("done: paid -> juried -> resolved -> VAA -> sponsored settle -> receipt -> reconciled");
  process.exit(0);
}

main().catch((e) => {
  log(`error: ${e?.message ?? e}`);
  process.exit(1);
});
