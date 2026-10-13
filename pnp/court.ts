/**
 * The real holders of the PNP market (read from PNP's YES/NO mints on devnet) -> a new conflict-blind Saring court.
 *   1. getProgramAccounts(Token program, mint = PNP YES/NO mint PDA) -> every wallet holding a side of the market
 *   2. openCourt, seat 3 jurors: trader A (a real YES holder) + two fresh wallets confirmed to hold neither side
 *   3. mirror every holder encrypted (record_positions_v3), scripted ballots: A YES, the two clean jurors NO
 *   4. resolve: MPC drops A's ballot (excluded 1) without revealing whose it was
 *
 *   npx ts-node --transpile-only -P sdk/tsconfig.json pnp/court.ts      (after pnp/market.ts)
 * Reads/writes pnp/out/market.json, writes pnp/out/court.json.
 */
// The repo-root web3.js copy, the same one SaringClient/anchor use (pnp/node_modules has its own).
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "../node_modules/@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SaringClient, identityId, newBallotKey, readCourtVerdict } from "../sdk/src";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const OUT = path.join(__dirname, "out");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const PNP = new PublicKey("8PyE2dizL52ga7ytqLtqRyjwWp4yXEx8M5Z4BAHgHuTb");
const tx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

/** Every owner with a non-zero balance of the market's YES or NO mint, minus the market PDA's own vaults. */
export async function pnpHolders(conn: Connection, market: PublicKey, marketId: bigint) {
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(marketId);
  const mints = { YES: PublicKey.findProgramAddressSync([Buffer.from("yes_token"), le], PNP)[0], NO: PublicKey.findProgramAddressSync([Buffer.from("no_token"), le], PNP)[0] };
  const holders = new Map<string, { yes: bigint; no: bigint }>();
  for (const [side, mint] of Object.entries(mints)) {
    const accs = await conn.getProgramAccounts(TOKEN, { filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint.toBase58() } }] });
    for (const { account } of accs) {
      const owner = new PublicKey(account.data.subarray(32, 64)).toBase58();
      const amount = account.data.readBigUInt64LE(64);
      if (amount === 0n || owner === market.toBase58()) continue;
      const h = holders.get(owner) ?? { yes: 0n, no: 0n };
      side === "YES" ? (h.yes += amount) : (h.no += amount);
      holders.set(owner, h);
    }
  }
  return { mints, holders };
}

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(OUT, "market.json"), "utf8"));
  const conn = new Connection(RPC, "confirmed");
  const me = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8"))));
  const startBal = await conn.getBalance(me.publicKey);
  const market = new PublicKey(state.market);

  const { mints, holders } = await pnpHolders(conn, market, BigInt(state.marketId));
  console.log(`PNP market ${state.market} (YES mint ${mints.YES.toBase58()}, NO mint ${mints.NO.toBase58()}): ${holders.size} holders on devnet`);
  for (const [w, h] of holders) console.log(`  ${w} YES ${Number(h.yes) / 1e6} NO ${Number(h.no) / 1e6}`);

  const conflicted: string = state.traders.A.wallet;
  if (!(holders.get(conflicted)?.yes ?? 0n)) throw new Error(`juror A ${conflicted} does not hold YES on chain`);
  const clean = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
  for (const w of clean) if (holders.has(w)) throw new Error(`clean juror ${w} holds a position`);

  const saring = new SaringClient(conn, me);
  const t0 = Date.now();
  const steps: Record<string, { queueSig: string; callbackSig: string }> = {};
  const step = (label: string, r: { queueSig: string; callbackSig: string }) => {
    steps[label] = { queueSig: r.queueSig, callbackSig: r.callbackSig };
    console.log(`  ${label.padEnd(30)} queue ${tx(r.queueSig)}\n  ${"".padEnd(30)} callback ${tx(r.callbackSig)} (+${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  };

  const opened = await saring.openCourt(`pnp:${state.market.slice(0, 32)}`);
  const { courtId, court } = opened;
  console.log(`court ${court.toBase58()} (id ${courtId})`);
  step("init_court_v3", opened);

  const jurors = await Promise.all([conflicted, ...clean].map(async (w) => ({ wallet: w, id: await identityId(w), key: newBallotKey() })));
  for (const j of jurors) step(`add_juror_v3 ${short(j.wallet)}`, await saring.seatJuror(courtId, j.id, j.key));

  const ids = await Promise.all([...holders.keys()].map((w) => identityId(w)));
  (await saring.mirrorPositions(courtId, ids)).forEach((r, i) => step(`record_positions_v3 #${i + 1}`, r));
  console.log(`  mirrored ${ids.length} PNP holders (encrypted)`);

  const [h, a, b] = jurors;
  step(`cast YES ${short(h.wallet)} (holder)`, await saring.cast(courtId, { jurorId: h.id, key: h.key, yes: true }));
  step(`cast NO  ${short(a.wallet)}`, await saring.cast(courtId, { jurorId: a.id, key: a.key, yes: false }));
  step(`cast NO  ${short(b.wallet)}`, await saring.cast(courtId, { jurorId: b.id, key: b.key, yes: false }));

  step("resolve_v3", await saring.resolve(courtId));
  const v = await readCourtVerdict(conn, court);
  console.log(`verdict: yes=${v.yes} no=${v.no} excluded=${v.excluded} incomplete=${v.incomplete} outcome=${v.outcome}`);
  console.log(`devnet SOL spent: ${((startBal - (await conn.getBalance(me.publicKey))) / LAMPORTS_PER_SOL).toFixed(4)}`);

  const out = {
    court: court.toBase58(),
    courtId,
    pnpMarket: state.market,
    holders: Object.fromEntries([...holders].map(([w, x]) => [w, { yes: x.yes.toString(), no: x.no.toString() }])),
    jurors: { holder: conflicted, clean },
    verdict: { yes: v.yes, no: v.no, excluded: v.excluded, incomplete: v.incomplete, outcome: v.outcome },
    steps,
  };
  fs.writeFileSync(path.join(OUT, "court.json"), JSON.stringify(out, null, 2));
  console.log("wrote pnp/out/court.json");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
