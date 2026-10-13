/**
 * Crank: Saring verdict -> PNP settleMarket -> the winning side redeems.
 *   1. readCourtVerdict (sdk/src/venue.ts: owner-checked against the Saring program) must be resolved and complete,
 *      and the court's authority must be this settler (the market's custom oracle); otherwise it refuses to sign
 *   2. settleMarket({ yesWinner }) on PNP's program, signed by the custom oracle, then a Memo tx binding court -> settle
 *   3. the trader on the winning side redeems; we print the collateral paid out, and the loser's redeem is refused
 *
 *   npx ts-node --transpile-only -P sdk/tsconfig.json pnp/settle.ts      (after pnp/court.ts)
 */
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { PNPClient } from "pnp-sdk";
import { readCourtVerdict, verdictToYesWins } from "../sdk/src/venue";
import { OUT, RPC, owner, traderA, traderB, tx } from "./market";

const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(OUT, "market.json"), "utf8"));
  const { court } = JSON.parse(fs.readFileSync(path.join(OUT, "court.json"), "utf8"));
  const conn = new Connection(RPC, "confirmed");
  const me = owner();
  const market = new PublicKey(state.market);

  // 1. the verdict, straight from the court account
  const v = await readCourtVerdict(conn as any, court);
  console.log(`court ${court}: resolved=${v.resolved} yes=${v.yes} no=${v.no} excluded=${v.excluded} incomplete=${v.incomplete} outcome=${v.outcome}`);
  const authority = (v.court as any).authority?.toBase58?.();
  if (authority !== me.publicKey.toBase58()) throw new Error(`court authority ${authority} is not this settler ${me.publicKey.toBase58()}`);
  const yesWinner = verdictToYesWins(v); // throws on unresolved / tie / incomplete
  const pnp = new PNPClient(RPC, me.secretKey);
  console.log(`settling PNP market ${state.market} -> ${yesWinner ? "YES" : "NO"} wins`);

  // 2. settle on PNP + memo binding the court to the settle tx
  // pnp-sdk's settleMarket() sends the admin-path `settle_market` (fails 6005 InvalidOwner for a custom oracle);
  // custom-oracle markets settle via `settle_market_v2` (settler, market, market_extension, global_config).
  // ponytail: memo rides in the same tx, so the court address is bound to the settlement itself.
  const memo = `saring-court:${court} outcome:${v.outcome} (${v.yes}-${v.no}, excluded ${v.excluded}) settles pnp-market:${state.market}`;
  const anchorClient: any = (pnp as any).anchorClient;
  const prog = anchorClient.program;
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(BigInt(state.marketId));
  const prior = path.join(OUT, "settle.json");
  const already = ((await pnp.fetchMarket(market)).account as any).resolved;
  if (already) console.log("market already settled; reusing the recorded settle tx and going to redeem");
  const signature: string = already
    ? JSON.parse(fs.readFileSync(prior, "utf8")).settle
    : await prog.methods
    .settleMarketV2(yesWinner)
    .accounts({
      settler: me.publicKey,
      market,
      marketExtension: PublicKey.findProgramAddressSync([Buffer.from("market_ext"), le], prog.programId)[0],
      globalConfig: PublicKey.findProgramAddressSync([Buffer.from("global_config")], prog.programId)[0],
    })
    .preInstructions([new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(memo) })])
    .signers([anchorClient.signer])
    .rpc();
  const settled = { signature };
  const memoSig = signature;
  console.log(`settle_market_v2 (+ memo "${memo}"): ${tx(signature)}`);
  const after: any = (await pnp.fetchMarket(market)).account;
  console.log(`PNP market account: resolved=${after.resolved} winning_token_id=${JSON.stringify(after.winning_token_id)}`);

  // 3. redeem
  const redeems: Record<string, any> = {};
  for (const [name, k, side] of [["A", traderA(), "YES"], ["B", traderB(), "NO"]] as const) {
    const c = new PNPClient(RPC, k.secretKey);
    const ata = getAssociatedTokenAddressSync(new PublicKey(state.collateralMint), k.publicKey);
    const bal = async () => BigInt((await conn.getTokenAccountBalance(ata)).value.amount);
    const before = await bal();
    try {
      // pnp-sdk's redeemPosition() passes camelCase keys to a snake_case IDL builder ("Missing account ... market_creator"),
      // so build the redeem_position_v2 account map directly.
      const col = new PublicKey(after.collateral_token);
      const admin = new PublicKey((await pnp.fetchGlobalConfig()).account.admin);
      const yesMint = new PublicKey(after.yes_token_mint),
        noMint = new PublicKey(after.no_token_mint);
      const r = await (c as any).redemption.redeemPositionV2({
        buyer: k.publicKey,
        admin,
        market_creator: new PublicKey(after.creator),
        market,
        global_config: PublicKey.findProgramAddressSync([Buffer.from("global_config")], new PublicKey(state.pnpProgram))[0],
        yes_token_mint: yesMint,
        no_token_mint: noMint,
        buyer_yes_token_account: getAssociatedTokenAddressSync(yesMint, k.publicKey),
        buyer_no_token_account: getAssociatedTokenAddressSync(noMint, k.publicKey),
        market_reserve_vault: getAssociatedTokenAddressSync(col, market, true),
        collateral_token_mint: col,
        buyer_collateral_token_account: ata,
        admin_collateral_token_account: getAssociatedTokenAddressSync(col, admin),
        creator_fee_treasury: new PublicKey(after.creator_fee_treasury),
        token_program: TOKEN_PROGRAM_ID,
        token_program_decision: TOKEN_PROGRAM_ID,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
        system_program: SystemProgram.programId,
      });
      await new Promise((res) => setTimeout(res, 3000)); // the RPC lags the redeem tx; the first run read 0
      const paid = (await bal()) - before;
      redeems[name] = { side, signature: r.signature, paid: Number(paid) / 1e6 };
      console.log(`${name} (${side}) redeemed ${Number(paid) / 1e6} sUSD: ${tx(r.signature!)}`);
    } catch (e) {
      redeems[name] = { side, refused: String((e as Error).message).slice(0, 200) };
      console.log(`${name} (${side}) redeem refused: ${String((e as Error).message).slice(0, 160)}`);
    }
  }

  fs.writeFileSync(
    path.join(OUT, "settle.json"),
    JSON.stringify({ court, market: state.market, verdict: { yes: v.yes, no: v.no, excluded: v.excluded, outcome: v.outcome }, yesWinner, settle: settled.signature, memo: memoSig, redeems }, null, 2)
  );
  console.log("wrote pnp/out/settle.json");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
