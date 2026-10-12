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

const CIRCUITS = ["init_court_v3", "add_juror_v3", "record_positions_v3", "cast_v3", "resolve_v3"];
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
    await awaitComputationFinalization(provider, offset, program.programId, "confirmed", 300_000);
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

    await run("init_court_v3", (o) => program.methods.createCourt(o, COURT_ID, question.slice(0, 64)));
    console.log("court opened", courtPDA.toBase58());

    // Each seat gets its own secret ballot key (31-bit, non-zero), chosen client-side.
    const newKey = () => BigInt((randomBytes(4).readUInt32LE() >>> 1) || 1);
    const keys = new Map<string, bigint>();
    for (const w of [...conflicted, ...clean]) {
      keys.set(w, newKey());
      const { ct, nonce } = enc([BigInt(await identityId(w)), keys.get(w)!]);
      await run("add_juror_v3", (o) =>
        program.methods.addJuror(o, COURT_ID, Array.from(ct[0]), Array.from(ct[1]), Array.from(pub), nonce)
      );
    }
    console.log("5 jurors seated with secret ballot keys (encrypted)");

    // A market that settles on this court; its bettors are mirrored into the court too.
    const [marketPDA] = PublicKey.findProgramAddressSync([Buffer.from("market"), courtPDA.toBuffer()], program.programId);
    const [vaultPDA] = PublicKey.findProgramAddressSync([Buffer.from("vault"), marketPDA.toBuffer()], program.programId);
    await program.methods.createMarket().accountsPartial({ courtAcc: courtPDA, market: marketPDA, vault: vaultPDA })
      .rpc({ commitment: "confirmed" });
    const rival = anchor.web3.Keypair.generate();
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(anchor.web3.SystemProgram.transfer({
      fromPubkey: owner.publicKey, toPubkey: rival.publicKey, lamports: 30_000_000,
    })), [], { commitment: "confirmed" });
    const bet = (who: anchor.web3.Keypair, yes: boolean, lamports: number) =>
      program.methods.bet(yes, new anchor.BN(lamports))
        .accountsPartial({ bettor: who.publicKey, courtAcc: courtPDA, market: marketPDA, vault: vaultPDA })
        .signers([who]).rpc({ commitment: "confirmed" });
    await bet(owner, false, 20_000_000); // 0.02 SOL on NO
    await bet(rival, true, 10_000_000); // 0.01 SOL on YES
    console.log("market opened: 0.02 SOL on NO, 0.01 SOL on YES");

    const positionIds = [
      ...(await Promise.all(holders.map((h) => identityId(h.owner)))),
      await identityId(owner.publicKey.toBase58()),
      await identityId(rival.publicKey.toBase58()),
    ];
    for (let i = 0; i < positionIds.length; i += BATCH) {
      const batch = positionIds.slice(i, i + BATCH);
      while (batch.length < BATCH) batch.push(0);
      const { ct, nonce } = enc(batch.map(BigInt));
      await run("record_positions_v3", (o) =>
        program.methods
          .recordPositions(o, COURT_ID, ct.map((c) => Array.from(c)), Array.from(pub), nonce)
          .accountsPartial({ authority: owner.publicKey, courtAcc: courtPDA })
      );
    }
    console.log(`${positionIds.length} positions mirrored (42 Panta holders + 2 bettors, encrypted)`);

    const cast = async (wallet: string, key: bigint, yes: boolean, rotateTo = 0n) => {
      const { ct, nonce } = enc([BigInt(await identityId(wallet)), key, rotateTo, BigInt(yes)]);
      await run("cast_v3", (o) =>
        program.methods
          .cast(o, COURT_ID, Array.from(ct[0]), Array.from(ct[1]), Array.from(ct[2]), Array.from(ct[3]), Array.from(pub), nonce)
          .accountsPartial({ authority: owner.publicKey, courtAcc: courtPDA })
      );
    };
    for (const w of conflicted) await cast(w, keys.get(w)!, true);
    const [bribed, honest] = clean;
    const receiptKey = keys.get(bribed)!;
    await cast(bribed, receiptKey, true); // the "receipt" shown to the briber, with the key handed over
    await cast(bribed, receiptKey, false, newKey()); // silently votes NO and rotates the key
    await cast(bribed, receiptKey, true); // briber re-sends YES with the stale key: ignored
    await cast(honest, keys.get(honest)!, false);
    await cast(honest, newKey(), true); // outsider overwrite attempt with a guessed key: ignored
    console.log("ballots cast (incl. a stale-key bribe and a forged overwrite, both ignored in MPC)");

    await run("resolve_v3", (o) => program.methods.resolve(o, COURT_ID));
    const court = await program.account.courtAccount.fetch(courtPDA);
    console.log(`verdict: yes=${court.yes} no=${court.no} excluded=${court.excluded} incomplete=${court.incomplete}`);
    expect(court.resolved).to.equal(true);
    expect(court.incomplete).to.equal(false);
    expect([court.yes, court.no, court.excluded]).to.deep.equal([0, 2, 3]);

    // Settlement: NO won, so the NO bettor takes the whole 0.03 SOL pool.
    const before = await provider.connection.getBalance(owner.publicKey);
    await program.methods.claim()
      .accountsPartial({ bettor: owner.publicKey, courtAcc: courtPDA, market: marketPDA, vault: vaultPDA })
      .rpc({ commitment: "confirmed" });
    const gained = (await provider.connection.getBalance(owner.publicKey)) - before;
    console.log(`claim paid ${gained / 1e9} SOL (minus fee) to the NO bettor`);
    expect(gained).to.be.greaterThan(29_000_000);
    await program.methods.claim()
      .accountsPartial({ bettor: rival.publicKey, courtAcc: courtPDA, market: marketPDA, vault: vaultPDA })
      .signers([rival]).rpc({ commitment: "confirmed" });
    const bal = await provider.connection.getBalance(vaultPDA);
    expect(bal).to.equal(0);
    console.log("losing bettor claimed 0; vault empty");
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
