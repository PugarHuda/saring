/**
 * End-to-end dispute on a REAL Panta prediction market (Solana mainnet):
 *   - read every wallet holding a position in the disputed market from mainnet
 *   - mirror all of them, encrypted, into the court (record_positions, 6 per MPC call)
 *   - seat 5 jurors: 3 real holders of this market + 2 real Panta traders who are not
 *   - conflicted jurors vote YES; one clean juror shows a briber a YES "receipt",
 *     then silently re-votes NO; the other clean juror votes NO
 *   - resolve() drops conflicted jurors inside MPC: expect yes=0, no=2, excluded=3
 * Ballots are scripted (we don't hold these wallets' keys); positions and identities
 * are real chain data. A plain jury would have returned YES 4-1.
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Connection, PublicKey } from "@solana/web3.js";
import { Blindcourt } from "../target/types/blindcourt";
import { randomBytes } from "crypto";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  RescueCipher,
  deserializeLE,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  x25519,
  getComputationAccAddress,
  getMXEPublicKey,
  getClusterAccAddress,
  getLookupTableAddress,
  getArciumProgram,
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";
import { DEMO_MARKET, allTraders, holdsPosition, identityId, marketHolders, marketQuestion } from "../panta/panta";

const CIRCUITS = ["init_court", "add_juror", "record_positions", "cast", "resolve"];
const BATCH = 6;
// Fresh court per run so devnet re-runs don't collide with an existing PDA.
const COURT_ID = Math.floor(Math.random() * 2 ** 31);

describe("Blindcourt", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Blindcourt as Program<Blindcourt>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const arciumEnv = getArciumEnv();
  const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);
  const mainnet = new Connection(process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");

  const idBuf = Buffer.alloc(4);
  idBuf.writeUInt32LE(COURT_ID);
  const [courtPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("court"), owner.publicKey.toBuffer(), idBuf],
    program.programId
  );

  // Accounts every queue_computation instruction needs.
  const queueAccounts = (circuit: string, offset: anchor.BN) => ({
    computationAccount: getComputationAccAddress(arciumEnv.arciumClusterOffset, offset),
    clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
    mxeAccount: getMXEAccAddress(program.programId),
    mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
    executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
    compDefAccount: getCompDefAccAddress(
      program.programId,
      Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE()
    ),
  });

  // Sends one queued instruction and waits for its MPC callback.
  async function run(circuit: string, build: (offset: anchor.BN) => any) {
    const offset = new anchor.BN(randomBytes(8), "hex");
    await build(offset)
      .accountsPartial(queueAccounts(circuit, offset))
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
  }

  it("excludes jurors who hold a position in a real Panta market, without revealing who", async () => {
    // --- real market data from Solana mainnet ---
    const question = await marketQuestion(mainnet, DEMO_MARKET);
    const holders = await marketHolders(mainnet, DEMO_MARKET);
    const traders = await allTraders(mainnet);
    const outsiders = [...traders.keys()].filter((w) => !traders.get(w)!.has(DEMO_MARKET));
    console.log(`Panta market ${DEMO_MARKET}: "${question}"`);
    console.log(`${holders.length} wallets hold a position; ${outsiders.length} other Panta traders do not`);

    const conflicted = holders.filter((h) => h.yes + h.no > 0n).slice(0, 3).map((h) => h.owner);
    const clean = outsiders.slice(0, 2);
    for (const w of conflicted) expect(await holdsPosition(mainnet, DEMO_MARKET, w)).to.equal(true);
    for (const w of clean) expect(await holdsPosition(mainnet, DEMO_MARKET, w)).to.equal(false);

    // --- court on Arcium ---
    const mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);
    for (const c of CIRCUITS) await initCompDef(c);

    const priv = new Uint8Array(randomBytes(32));
    const pub = x25519.getPublicKey(priv);
    const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxePublicKey));
    const enc = (vals: bigint[]) => {
      const nonce = randomBytes(16);
      return { ct: cipher.encrypt(vals, nonce), nonce: new anchor.BN(deserializeLE(nonce).toString()) };
    };

    await run("init_court", (o) => program.methods.createCourt(o, COURT_ID, question.slice(0, 64)));
    console.log("court opened", courtPDA.toBase58());

    for (const w of [...conflicted, ...clean]) {
      const { ct, nonce } = enc([BigInt(await identityId(w))]);
      await run("add_juror", (o) =>
        program.methods.addJuror(o, COURT_ID, Array.from(ct[0]), Array.from(pub), nonce)
      );
    }
    console.log("5 jurors seated (encrypted)");

    const holderIds = await Promise.all(holders.map((h) => identityId(h.owner)));
    for (let i = 0; i < holderIds.length; i += BATCH) {
      const batch = holderIds.slice(i, i + BATCH);
      while (batch.length < BATCH) batch.push(0);
      const { ct, nonce } = enc(batch.map(BigInt));
      await run("record_positions", (o) =>
        program.methods
          .recordPositions(o, COURT_ID, ct.map((c) => Array.from(c)), Array.from(pub), nonce)
          .accountsPartial({ authority: owner.publicKey, courtAcc: courtPDA })
      );
    }
    console.log(`${holderIds.length} Panta positions mirrored (encrypted)`);

    const cast = async (wallet: string, yes: boolean) => {
      const { ct, nonce } = enc([BigInt(await identityId(wallet)), BigInt(yes)]);
      await run("cast", (o) =>
        program.methods
          .cast(o, COURT_ID, Array.from(ct[0]), Array.from(ct[1]), Array.from(pub), nonce)
          .accountsPartial({ authority: owner.publicKey, courtAcc: courtPDA })
      );
    };
    for (const w of conflicted) await cast(w, true);
    await cast(clean[0], true); // bribed: shows the briber this receipt...
    await cast(clean[0], false); // ...then silently overwrites it
    await cast(clean[1], false);
    console.log("ballots cast");

    await run("resolve", (o) => program.methods.resolve(o, COURT_ID));
    const court = await program.account.courtAccount.fetch(courtPDA);
    console.log(`verdict: yes=${court.yes} no=${court.no} excluded=${court.excluded}`);
    expect(court.resolved).to.equal(true);
    expect([court.yes, court.no, court.excluded]).to.deep.equal([0, 2, 3]);
  });

  async function initCompDef(circuit: string) {
    const offset = getCompDefAccOffset(circuit);
    const compDefPDA = PublicKey.findProgramAddressSync(
      [getArciumAccountBaseSeed("ComputationDefinitionAccount"), program.programId.toBuffer(), offset],
      getArciumProgramId()
    )[0];
    // Comp defs persist on-chain; skip ones already initialized (devnet re-runs).
    if (await provider.connection.getAccountInfo(compDefPDA)) return;
    const mxeAccount = getMXEAccAddress(program.programId);
    const mxeAcc = await getArciumProgram(provider).account.mxeAccount.fetch(mxeAccount);
    const method = `init${circuit
      .split("_")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join("")}CompDef`;
    await (program.methods as any)
      [method[0].toLowerCase() + method.slice(1)]()
      .accounts({
        compDefAccount: compDefPDA,
        payer: owner.publicKey,
        mxeAccount,
        addressLookupTable: getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot),
      })
      .signers([owner])
      .rpc({ preflightCommitment: "confirmed", commitment: "confirmed" });
    // Circuit bytes are fetched by Arx nodes from the off-chain source set in the program.
  }
});

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries = 20,
  retryDelayMs = 500
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const key = await getMXEPublicKey(provider, programId);
      if (key) return key;
    } catch {}
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  throw new Error(`Failed to fetch MXE public key after ${maxRetries} attempts`);
}

function readKpJson(path: string): anchor.web3.Keypair {
  return anchor.web3.Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path).toString())));
}
