/**
 * Saring verdict (devnet) -> Panta settlement instruction -> simulated on Panta's mainnet program.
 *
 *   npx ts-node --transpile-only -P sdk/tsconfig.json sdk/examples/panta-adapter.ts [court] [pantaMarket]
 * court defaults to sdk/out/court.json (written by full-dispute.ts). The Panta market defaults
 * to an open, unresolved Panta market whose resolution time has passed (read from mainnet).
 *
 * Simulations run with sigVerify=false, so nothing is signed and nothing lands:
 *   A. oracle = this operator's key (not Panta's oracle): expected to fail authorization.
 *   B. oracle = the Panta admin key that signed Panta's real resolutions: shows how far the
 *      same instruction gets once the signer is one Panta accepts (signature not verified).
 */
import { BorshAccountsCoder, utils } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readCourtVerdict } from "../src";
import { PANTA_IDL, PANTA_PROGRAM_ID, buildPantaSettleIx, readPantaConfig, readPantaEvent, simulatePantaIx, type PantaSettlement } from "../src/panta";

async function pickMarket(mainnet: Connection): Promise<PublicKey> {
  const coder = new BorshAccountsCoder(PANTA_IDL);
  const evs = await mainnet.getProgramAccounts(PANTA_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(coder.accountDiscriminator("Event")) } }],
  });
  const now = Date.now() / 1000;
  const open = evs
    .map(({ pubkey, account }) => ({ pubkey, e: coder.decode("Event", account.data) }))
    .filter(({ e }) => !e.is_resolved && !e.is_cancelled && e.resolution_time.toNumber() < now)
    .sort((x, y) => y.e.total_volume.cmp(x.e.total_volume));
  if (!open.length) throw new Error("no unresolved Panta market past its resolution time");
  return open[0].pubkey;
}

async function main() {
  const devnet = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
  const mainnet = new Connection(process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const operator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8")))).publicKey;

  const courtArg = process.argv[2] || JSON.parse(fs.readFileSync(path.join(__dirname, "..", "out", "court.json"), "utf8")).court;
  const verdict = await readCourtVerdict(devnet, courtArg);
  console.log(`Saring court ${courtArg} (devnet): yes=${verdict.yes} no=${verdict.no} excluded=${verdict.excluded} outcome=${verdict.outcome}`);

  const event = process.argv[3] ? new PublicKey(process.argv[3]) : await pickMarket(mainnet);
  const e = await readPantaEvent(mainnet, event);
  console.log(`Panta market ${event.toBase58()} (mainnet): "${e.question}"`);
  console.log(
    `  is_resolved=${e.is_resolved} oracle_result_submitted=${e.oracle_result_submitted} pending_review=${Object.keys(e.pending_review)[0]} ` +
      `resolution_time=${new Date(e.resolution_time.toNumber() * 1000).toISOString()}`
  );
  const cfg = await readPantaConfig(mainnet);
  const pantaAdmin: PublicKey = cfg.admin[0];

  const runs: { label: string; oracle: PublicKey; instruction: PantaSettlement }[] = [
    { label: "A resolve_event, oracle = Saring operator key", oracle: operator, instruction: "resolve_event" },
    { label: "B resolve_event, oracle = Panta admin[0] (unsigned)", oracle: pantaAdmin, instruction: "resolve_event" },
    { label: "C submit_oracle_result, oracle = Panta admin[0] (unsigned)", oracle: pantaAdmin, instruction: "submit_oracle_result" },
  ];
  const results: any[] = [];
  for (const r of runs) {
    const built = await buildPantaSettleIx(mainnet, { event, oracle: r.oracle, verdict, instruction: r.instruction });
    // The fee payer must exist on mainnet; if the oracle key has no SOL there, Panta's treasury pays (signatures aren't checked).
    const payer = (await mainnet.getBalance(r.oracle)) > 0 ? r.oracle : (cfg.treasury as PublicKey);
    const sim = await simulatePantaIx(mainnet, built.instruction, payer);
    console.log(`\n== ${r.label}`);
    console.log(`  ${built.name}(yes_wins=${built.yesWins}), data=${built.instruction.data.toString("hex")}, fee payer ${payer.toBase58()}`);
    for (const [k, v] of Object.entries(built.accounts)) console.log(`    ${k.padEnd(32)} ${v}`);
    console.log(`  vault account discovered from tx ${built.vaultSource.slice(0, 20)}…`);
    console.log(`  simulation err=${JSON.stringify(sim.err)} units=${sim.unitsConsumed}`);
    console.log(`  anchor error: ${sim.anchorError ? `${sim.anchorError.name} (${sim.anchorError.code}): ${sim.anchorError.msg}` : "none"}`);
    for (const l of sim.logs) console.log(`    | ${l}`);
    results.push({ ...r, oracle: r.oracle.toBase58(), name: built.name, yesWins: built.yesWins, accounts: built.accounts, err: sim.err, anchorError: sim.anchorError, logs: sim.logs });
  }
  fs.writeFileSync(path.join(__dirname, "..", "out", `panta-simulation${process.argv[3] ? "-" + event.toBase58().slice(0, 8) : ""}.json`), JSON.stringify({ court: courtArg, verdict: { yes: verdict.yes, no: verdict.no, outcome: verdict.outcome }, pantaMarket: event.toBase58(), results }, null, 2));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
