/**
 * A short, real dispute on devnet driven only by @saring/sdk, over a real Panta market:
 *   open court -> seat 3 jurors (1 real holder of the market, 2 real Panta traders who
 *   are not) -> mirror every holder of the market (read from mainnet) -> 3 ballots,
 *   one with a wrong key -> resolve -> read the verdict the way a venue would (venue.ts)
 *   -> exercise the built-in market helpers with a 0.001 SOL bet.
 *
 *   npx ts-node --transpile-only -P sdk/tsconfig.json sdk/examples/full-dispute.ts
 * Needs RPC_URL (devnet), MAINNET_RPC_URL, and ~/.config/solana/id.json. Writes sdk/out/court.json.
 */
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEMO_MARKET, allTraders, identityId as pantaIdentityId, marketHolders, marketQuestion } from "../../panta/panta";
import { SaringClient, identityId, newBallotKey, readCourtVerdict, verdictToYesWins } from "../src";

const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

async function main() {
  const devnet = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
  const mainnet = new Connection(process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8"))));
  const saring = new SaringClient(devnet, owner);
  const startBal = await devnet.getBalance(owner.publicKey);
  console.log(`operator ${owner.publicKey.toBase58()} balance ${startBal / LAMPORTS_PER_SOL} SOL (devnet)`);

  // --- real Panta data (mainnet) ---
  const market = DEMO_MARKET;
  const [question, holders, traders] = await Promise.all([marketQuestion(mainnet, market), marketHolders(mainnet, market), allTraders(mainnet)]);
  const outsiders = [...traders.keys()].filter((w) => !traders.get(w)!.has(market));
  const conflicted = holders.find((h) => h.yes + h.no > 0n)!.owner;
  const [cleanA, cleanB] = outsiders;
  console.log(`Panta market ${market}: "${question}"`);
  console.log(`${holders.length} holders on mainnet; jurors: ${short(conflicted)} (holder), ${short(cleanA)}, ${short(cleanB)} (traders elsewhere)`);
  if ((await identityId(conflicted)) !== (await pantaIdentityId(conflicted))) throw new Error("identityId mismatch with panta/panta.ts");

  const t0 = Date.now();
  const step = (label: string, r: { queueSig: string; callbackSig: string }) =>
    console.log(`  ${label.padEnd(28)} queue ${r.queueSig.slice(0, 16)}…  callback ${r.callbackSig.slice(0, 16)}…  (+${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  // --- court ---
  const opened = await saring.openCourt(`panta:${market.slice(0, 32)}`);
  const { courtId, court } = opened;
  console.log(`court ${court.toBase58()} (id ${courtId})`);
  step("init_court_v3", opened);

  const jurors = await Promise.all([conflicted, cleanA, cleanB].map(async (w) => ({ wallet: w, id: await identityId(w), key: newBallotKey() })));
  for (const j of jurors) step(`add_juror_v3 ${short(j.wallet)}`, await saring.seatJuror(courtId, j.id, j.key));

  const ids = await Promise.all(holders.map((h) => identityId(h.owner)));
  const batches = await saring.mirrorPositions(courtId, ids);
  batches.forEach((r, i) => step(`record_positions_v3 #${i + 1}`, r));
  console.log(`  mirrored ${ids.length} holders in ${batches.length} encrypted batches`);

  const [h, a, b] = jurors;
  step(`cast YES ${short(h.wallet)} (holder)`, await saring.cast(courtId, { jurorId: h.id, key: h.key, yes: true }));
  step(`cast NO  ${short(a.wallet)}`, await saring.cast(courtId, { jurorId: a.id, key: a.key, yes: false }));
  let wrong = newBallotKey();
  while (wrong === b.key) wrong = newBallotKey();
  step(`cast YES ${short(b.wallet)} WRONG KEY`, await saring.cast(courtId, { jurorId: b.id, key: wrong, yes: true }));

  // --- built-in market helpers: open, bet 0.001 SOL on NO before resolve ---
  const m = await saring.createMarket(court);
  const betSig = await saring.bet(court, false, 1_000_000);
  console.log(`  market ${m.market.toBase58()} created (${m.sig.slice(0, 16)}…), bet 0.001 SOL on NO (${betSig.slice(0, 16)}…)`);

  const resolved = await saring.resolve(courtId);
  step("resolve_v3", resolved);

  // --- what a venue does: read the account directly, no client ---
  const v = await readCourtVerdict(devnet, court);
  console.log(`verdict (venue.ts): yes=${v.yes} no=${v.no} excluded=${v.excluded} incomplete=${v.incomplete} outcome=${v.outcome}`);
  let yesWins: boolean | null = null;
  try {
    yesWins = verdictToYesWins(v);
    console.log(`verdictToYesWins -> ${yesWins}`);
  } catch (e) {
    console.log(`verdictToYesWins refused: ${(e as Error).message}`);
  }

  const before = await devnet.getBalance(owner.publicKey);
  const claimSig = await saring.claim(court);
  console.log(`  claim ${claimSig.slice(0, 16)}… paid ${(await devnet.getBalance(owner.publicKey)) - before + 5000} lamports (fee added back)`);

  const spent = (startBal - (await devnet.getBalance(owner.publicKey))) / LAMPORTS_PER_SOL;
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s; devnet SOL spent: ${spent.toFixed(4)}`);

  const out = path.join(__dirname, "..", "out", "court.json");
  fs.writeFileSync(
    out,
    JSON.stringify(
      { cluster: "devnet", court: court.toBase58(), courtId, pantaMarket: market, question, holdersMirrored: ids.length, verdict: { yes: v.yes, no: v.no, excluded: v.excluded, incomplete: v.incomplete, outcome: v.outcome }, yesWins, resolve: { queueSig: resolved.queueSig, callbackSig: resolved.callbackSig } },
      null,
      2
    )
  );
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
