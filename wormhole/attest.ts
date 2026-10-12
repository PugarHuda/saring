/**
 * Posts a resolved Saring court's verdict through Wormhole and waits for the guardian-signed VAA.
 *
 *   npx tsx attest.ts [court]     -> out/vaa-<court>.json  { vaa (hex), sequence, tx, ... }
 *
 * No trusted key is involved in the verdict: saring_wormhole reads the CourtAccount on-chain
 * (owner == Saring program, discriminator, resolved && !pending) and posts it as its PDA emitter.
 * The payer here only pays fees.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { solana } from "../arbitrum/lib";

export const PROGRAM = new PublicKey("DdNYVoQVXZdWjAaYq9pnrH2fec17F1QnSXDyfnTQWdPq");
export const WORMHOLE = new PublicKey("3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5");
export const EMITTER = PublicKey.findProgramAddressSync([Buffer.from("emitter")], PROGRAM)[0];
const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, WORMHOLE)[0];
const SCAN = "https://api.testnet.wormholescan.io/api/v1/vaas/1";

export function log(s: string) {
  console.log(s);
  fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
  fs.appendFileSync(path.join(__dirname, "out", "attest.log"), s + "\n");
}

export async function attest(court: string) {
  const conn = solana();
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
  const message = Keypair.generate();
  const sequence = pda([Buffer.from("Sequence"), EMITTER.toBuffer()]);
  const keys = [
    [payer.publicKey, true, true], [new PublicKey(court), false, false], [pda([Buffer.from("Bridge")]), false, true],
    [message.publicKey, true, true], [EMITTER, false, false], [sequence, false, true], [pda([Buffer.from("fee_collector")]), false, true],
    [SYSVAR_CLOCK_PUBKEY, false, false], [SYSVAR_RENT_PUBKEY, false, false], [SystemProgram.programId, false, false], [WORMHOLE, false, false],
  ].map(([pubkey, isSigner, isWritable]) => ({ pubkey: pubkey as PublicKey, isSigner: isSigner as boolean, isWritable: isWritable as boolean }));
  const tx = new Transaction().add(new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.alloc(0) }));
  log(`\n=== ${new Date().toISOString()} attest court ${court} (emitter ${EMITTER.toBase58()} = 0x${EMITTER.toBuffer().toString("hex")})`);
  const sig = await sendAndConfirmTransaction(conn, tx, [payer, message], { commitment: "confirmed" });
  log(`solana tx: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  const seq = (await conn.getAccountInfo(sequence, "confirmed"))!.data.readBigUInt64LE(0) - 1n;
  const id = `${EMITTER.toBuffer().toString("hex")}/${seq}`;
  log(`wormhole sequence ${seq}; waiting for the guardian signature (Solana finality ~15 s) ...`);
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`${SCAN}/${id}`);
    if (r.ok) {
      const j: any = await r.json();
      const vaa = "0x" + Buffer.from(j.data.vaa, "base64").toString("hex");
      log(`VAA: https://wormholescan.io/#/tx/${sig}?network=Testnet  (api ${SCAN}/${id})`);
      const out = { court, solanaTx: sig, emitter: "0x" + EMITTER.toBuffer().toString("hex"), sequence: seq.toString(), vaa };
      fs.writeFileSync(path.join(__dirname, "out", `vaa-${court}.json`), JSON.stringify(out, null, 2));
      return out;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`no VAA for ${id} after 10 min`);
}

/** Simulates (no fee, nothing lands) an attestation of `account`: shows the program's on-chain refusal of a non-court. */
export async function simulate(account: string) {
  const conn = solana();
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
  const message = Keypair.generate();
  const keys = [
    [payer.publicKey, true, true], [new PublicKey(account), false, false], [pda([Buffer.from("Bridge")]), false, true],
    [message.publicKey, true, true], [EMITTER, false, false], [pda([Buffer.from("Sequence"), EMITTER.toBuffer()]), false, true], [pda([Buffer.from("fee_collector")]), false, true],
    [SYSVAR_CLOCK_PUBKEY, false, false], [SYSVAR_RENT_PUBKEY, false, false], [SystemProgram.programId, false, false], [WORMHOLE, false, false],
  ].map(([pubkey, isSigner, isWritable]) => ({ pubkey: pubkey as PublicKey, isSigner: isSigner as boolean, isWritable: isWritable as boolean }));
  const tx = new Transaction().add(new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.alloc(0) }));
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(payer, message);
  const r = await conn.simulateTransaction(tx);
  const owner = (await conn.getAccountInfo(new PublicKey(account)))?.owner.toBase58();
  log(`
=== ${new Date().toISOString()} simulate attest of ${account} (owner ${owner}): err ${JSON.stringify(r.value.err)}`);
  for (const l of r.value.logs ?? []) if (/saring|DdNY|failed|Program log/i.test(l) || l.includes(PROGRAM.toBase58())) log(`  ${l}`);
}

if (require.main === module)
  (process.argv[2] === "--simulate" ? simulate(process.argv[3]) : attest(process.argv[2] ?? "24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb")).catch((e) => {
    console.error(e);
    process.exit(1);
  });
