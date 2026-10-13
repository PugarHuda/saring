/**
 * A real PNP Exchange market on Solana devnet whose settler (custom oracle) is the Saring court authority.
 *   1. mint a devnet SPL collateral token (6 dp) and fund two trader wallets A and B
 *   2. createMarketWithCustomOracle(settler = court authority) on PNP's own program 8PyE2diz…
 *   3. setMarketResolvable(true) in the same run (PNP freezes markets left non-resolvable > ~15 min)
 *   4. A buys YES, B buys NO: real holders of PNP's YES/NO mints
 *
 *   npx ts-node --transpile-only -P sdk/tsconfig.json pnp/market.ts      (from the repo root)
 * Writes pnp/out/market.json (public data only). Trader keys live in ~/.config/solana/pnp-{a,b}.json.
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createMint, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PNPClient } from "pnp-sdk";

export const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
export const OUT = path.join(__dirname, "out");
export const tx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const addr = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;

export function loadKey(file: string, create = false): Keypair {
  if (create && !fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 });
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}
const KEYDIR = `${os.homedir()}/.config/solana`;
export const owner = () => loadKey(`${KEYDIR}/id.json`);
export const traderA = () => loadKey(`${KEYDIR}/pnp-a.json`, true);
export const traderB = () => loadKey(`${KEYDIR}/pnp-b.json`, true);

const DEC = 6;
const UNIT = 10n ** BigInt(DEC);

/**
 * pnp-sdk 0.2.11's setMarketResolvable omits the market_{yes,no}_token_vault accounts its own IDL requires
 * ("Missing account ... market_yes_token_vault"), so this passes the full account list to the IDL builder.
 * Both vaults are the market's ATAs (IDL seeds: market, token_program, mint).
 */
export async function setResolvable(pnp: PNPClient, market: PublicKey): Promise<{ signature: string }> {
  const mod: any = (pnp as any).market;
  const acc: any = (await pnp.fetchMarket(market)).account;
  const id = BigInt(acc.id.toString());
  const prog = (pnp as any).client.programId as PublicKey;
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(id);
  const pda = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed), le], prog)[0];
  const yes = pda("yes_token"),
    no = pda("no_token");
  const creator = new PublicKey(acc.creator);
  const META = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
  const meta = (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("metadata"), META.toBuffer(), m.toBuffer()], META)[0];
  const accounts = {
    authority: mod.signer.publicKey,
    global_config: PublicKey.findProgramAddressSync([Buffer.from("global_config")], prog)[0],
    market,
    market_extension: pda("market_ext"),
    collateral_token_mint: new PublicKey(acc.collateral_token ?? acc.collateralToken),
    yes_token_mint: yes,
    no_token_mint: no,
    creator,
    creator_yes_token_account: getAssociatedTokenAddressSync(yes, creator),
    creator_no_token_account: getAssociatedTokenAddressSync(no, creator),
    market_yes_token_vault: getAssociatedTokenAddressSync(yes, market, true),
    market_no_token_vault: getAssociatedTokenAddressSync(no, market, true),
    token_metadata_program: META,
    yes_metadata: meta(yes),
    no_metadata: meta(no),
    token_program: TOKEN_PROGRAM_ID,
    associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
    rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
  };
  return mod.setMarketResolvableIdl(accounts, { market_id: id, resolvable: true, force_resolve: undefined });
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const me = owner();
  const [a, b] = [traderA(), traderB()];
  const start = await conn.getBalance(me.publicKey);
  console.log(`authority/settler ${me.publicKey.toBase58()} ${start / LAMPORTS_PER_SOL} SOL; traders A ${a.publicKey.toBase58()} B ${b.publicKey.toBase58()}`);

  // gas for the two traders
  const fund = new Transaction();
  for (const k of [a, b]) {
    if ((await conn.getBalance(k.publicKey)) < 0.03 * LAMPORTS_PER_SOL)
      fund.add(SystemProgram.transfer({ fromPubkey: me.publicKey, toPubkey: k.publicKey, lamports: 0.04 * LAMPORTS_PER_SOL }));
  }
  const fundSig = fund.instructions.length ? await sendAndConfirmTransaction(conn, fund, [me]) : null;
  if (fundSig) console.log(`funded traders: ${tx(fundSig)}`);

  // 1. self-minted collateral
  const mint = await createMint(conn, me, me.publicKey, null, DEC);
  console.log(`collateral mint (sUSD, ${DEC} dp): ${mint.toBase58()}`);
  const mintSigs: string[] = [];
  for (const [k, amt] of [[me, 1000n], [a, 100n], [b, 100n]] as const) {
    const ata = await getOrCreateAssociatedTokenAccount(conn, me, mint, k.publicKey);
    mintSigs.push(await mintTo(conn, me, mint, ata.address, me, amt * UNIT));
  }
  console.log(`minted 1000/100/100 sUSD to authority/A/B: ${mintSigs.map((s) => s.slice(0, 12)).join(", ")}`);

  // 2. market with the Saring court authority as custom oracle
  const pnp = new PNPClient(RPC, me.secretKey);
  const question = "Saring x PNP demo: will the Saring jury rule NO on this devnet market? (settled by a conflict-blind Saring court)";
  // PNP lets the oracle settle only after end_time (earlier, settleMarket fails with 6000 "MarketEnded").
  // The recorded run used 45 min; 15 min covers the buys plus the ~1 min court.
  const endTime = BigInt(Math.floor(Date.now() / 1000) + 15 * 60);
  const created = await pnp.createMarketWithCustomOracle({ question, initialLiquidity: 100n * UNIT, endTime, collateralMint: mint, settlerAddress: me.publicKey });
  const market = created.market;
  console.log(`GO: PNP accepted the self-minted collateral. market ${market.toBase58()} create ${tx(created.signature)}`);

  // 3. resolvable in the same run
  const resolvable = await setResolvable(pnp, market);
  console.log(`setMarketResolvable(true): ${tx(resolvable.signature)}`);

  const state = {
    cluster: "devnet",
    pnpProgram: "8PyE2dizL52ga7ytqLtqRyjwWp4yXEx8M5Z4BAHgHuTb",
    market: market.toBase58(),
    marketId: ((await pnp.fetchMarket(market)).account as any).id.toString(),
    question,
    collateralMint: mint.toBase58(),
    settler: me.publicKey.toBase58(),
    traders: { A: { wallet: a.publicKey.toBase58(), side: "YES" }, B: { wallet: b.publicKey.toBase58(), side: "NO" } },
    txs: { fund: fundSig, mint: mintSigs, create: created.signature, setResolvable: resolvable.signature } as Record<string, any>,
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "market.json"), JSON.stringify(state, null, 2));
  await new Promise((r) => setTimeout(r, 8000)); // the YES/NO mints are created by setResolvable; let the RPC catch up
  await buys();
  console.log(`spent ${((start - (await conn.getBalance(me.publicKey))) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
}

/** 4. real positions: A buys YES, B buys NO (skips a wallet that already holds its side, so it can resume). */
export async function buys() {
  const file = path.join(OUT, "market.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  const conn = new Connection(RPC, "confirmed");
  const market = new PublicKey(state.market);
  for (const [name, k, yes] of [["A", traderA(), true], ["B", traderB(), false]] as const) {
    const c = new PNPClient(RPC, k.secretKey);
    const held = await c.trading!.getBalances(market);
    if (Number(yes ? held.yes.uiAmount : held.no.uiAmount) > 0) {
      state.txs[`buy${name}`] ??= (await conn.getSignaturesForAddress(k.publicKey, { limit: 1 }))[0].signature;
      console.log(`${name} already holds ${yes ? "YES" : "NO"}: ${tx(state.txs[`buy${name}`])}`);
      continue;
    }
    const r = await c.trading!.buyTokensUsdc({ market, buyYesToken: yes, amountUsdc: 10 });
    state.txs[`buy${name}`] = r.signature;
    console.log(`${name} bought ${yes ? "YES" : "NO"} for ${r.usdcSpent} sUSD -> ${r.tokensReceived} tokens: ${tx(r.signature)}`);
  }
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
  console.log("wrote pnp/out/market.json");
}

// resume after a crash: ts-node pnp/market.ts --resolvable <market>
const resume = process.argv.indexOf("--resolvable");
if (require.main === module && resume > 0)
  setResolvable(new PNPClient(RPC, owner().secretKey), new PublicKey(process.argv[resume + 1])).then(
    (r) => (console.log(`setMarketResolvable(true): ${tx(r.signature)}`), process.exit(0)),
    (e) => (console.error(e), process.exit(1))
  );
else if (require.main === module)
  (process.argv.includes("--buys") ? buys() : main()).then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    }
  );
