/**
 * Demo scenario for a conflict-blind jury:
 *   - market "Did X happen by Oct 31?" goes to dispute; truth is NO
 *   - 5 jurors seated; 3 of them secretly also traded the market and vote YES
 *   - an honest juror is "bribed", shows a YES receipt, then silently re-votes NO
 *   - resolve() drops conflicted jurors in MPC: expect yes=0, no=2, excluded=3
 * A plain jury (Kleros/UMA-style) would have returned YES 3-2 (or 4-1 with the bribe).
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { Blindcourt } from "../target/types/blindcourt";
import { randomBytes } from "crypto";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  uploadCircuit,
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

const CIRCUITS = ["init_court", "add_juror", "record_position", "cast", "resolve"];
const COURT_ID = 1;

describe("Blindcourt", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Blindcourt as Program<Blindcourt>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const arciumEnv = getArciumEnv();
  const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

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

  it("excludes conflicted jurors without revealing who they are", async () => {
    const mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);
    for (const c of CIRCUITS) await initCompDef(c);

    const priv = new Uint8Array(randomBytes(32));
    const pub = x25519.getPublicKey(priv);
    const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxePublicKey));
    const enc = (vals: bigint[]) => {
      const nonce = randomBytes(16);
      return { ct: cipher.encrypt(vals, nonce), nonce: new anchor.BN(deserializeLE(nonce).toString()) };
    };

    await run("init_court", (o) =>
      program.methods.createCourt(o, COURT_ID, "Did X happen by Oct 31?")
    );
    console.log("court opened", courtPDA.toBase58());

    const insiders = [101, 102, 103]; // jurors who also traded this market
    const honest = [104, 105];
    const traders = [...insiders, 201, 202];

    for (const id of [...insiders, ...honest]) {
      const { ct, nonce } = enc([BigInt(id)]);
      await run("add_juror", (o) =>
        program.methods.addJuror(o, COURT_ID, Array.from(ct[0]), Array.from(pub), nonce)
      );
    }
    console.log("5 jurors seated (encrypted)");

    for (const id of traders) {
      const { ct, nonce } = enc([BigInt(id)]);
      await run("record_position", (o) =>
        program.methods
          .recordPosition(o, COURT_ID, Array.from(ct[0]), Array.from(pub), nonce)
          .accountsPartial({ authority: owner.publicKey, courtAcc: courtPDA })
      );
    }
    console.log("5 positions recorded (encrypted)");

    const cast = async (id: number, yes: boolean) => {
      const { ct, nonce } = enc([BigInt(id), BigInt(yes)]);
      await run("cast", (o) =>
        program.methods
          .cast(o, COURT_ID, Array.from(ct[0]), Array.from(ct[1]), Array.from(pub), nonce)
          .accountsPartial({ authority: owner.publicKey, courtAcc: courtPDA })
      );
    };
    for (const id of insiders) await cast(id, true);
    await cast(104, true); // bribed: shows the briber this receipt...
    await cast(104, false); // ...then silently overwrites it
    await cast(105, false);
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
    await uploadCircuit(provider, circuit, program.programId, fs.readFileSync(`build/${circuit}.arcis`), true);
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
