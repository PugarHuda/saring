// Browser port of tests/blindcourt.ts: same instructions, same accounts, same scenario.
import { AnchorProvider, BN, Program, type Wallet } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import {
  RescueCipher,
  awaitComputationFinalization,
  deserializeLE,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getExecutingPoolAccAddress,
  getMXEAccAddress,
  getMXEPublicKey,
  getMempoolAccAddress,
  x25519,
} from "@arcium-hq/client";
import idl from "./idl/blindcourt.json";
import type { Blindcourt } from "./idl/blindcourt";

export const CLUSTER_OFFSET = 456; // Arcium devnet cluster
export const RPC_URL: string = import.meta.env.VITE_RPC_URL || "https://api.devnet.solana.com";
export const PROGRAM_ID = new PublicKey(idl.address);
export const MARKET = "Did X happen by Oct 31?";
const FINALIZE_TIMEOUT_MS = 300_000;

export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddr = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;

// ---------- burner wallet ----------

const BURNER_KEY = "blindcourt.burner.v1";

export function loadBurner(): Keypair {
  try {
    const saved = localStorage.getItem(BURNER_KEY);
    if (saved) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved)));
  } catch {
    /* storage blocked or corrupt: fall through to a fresh key */
  }
  const kp = Keypair.generate();
  try {
    localStorage.setItem(BURNER_KEY, JSON.stringify(Array.from(kp.secretKey)));
  } catch {
    /* session-only burner */
  }
  return kp;
}

function burnerWallet(kp: Keypair): Wallet {
  const sign = <T extends Transaction | VersionedTransaction>(tx: T): T => {
    if (tx instanceof VersionedTransaction) tx.sign([kp]);
    else tx.partialSign(kp);
    return tx;
  };
  return {
    publicKey: kp.publicKey,
    payer: kp,
    signTransaction: async (tx) => sign(tx),
    signAllTransactions: async (txs) => txs.map(sign),
  };
}

export function makeClient(kp: Keypair) {
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, burnerWallet(kp), { commitment: "confirmed" });
  const program = new Program<Blindcourt>(idl as Blindcourt, provider);
  return { connection, provider, program, authority: kp.publicKey };
}
export type Client = ReturnType<typeof makeClient>;

// ---------- scenario ----------

export type Action =
  | { kind: "create" }
  | { kind: "juror"; id: number }
  | { kind: "position"; id: number }
  | { kind: "cast"; id: number; yes: boolean }
  | { kind: "resolve" };

export interface ScriptStep {
  action: Action;
  title: string;
  note: string;
}

export const INSIDERS = [101, 102, 103]; // jurors who also traded the market
export const HONEST = [104, 105];
export const OUTSIDE_TRADERS = [201, 202];

export const SCRIPT: ScriptStep[] = [
  { action: { kind: "create" }, title: "Open the court", note: `Market: “${MARKET}”` },
  ...[...INSIDERS, ...HONEST].map((id) => ({
    action: { kind: "juror", id } as Action,
    title: `Seat juror #${id}`,
    note: "Id sent as ciphertext",
  })),
  ...[...INSIDERS, ...OUTSIDE_TRADERS].map((id) => ({
    action: { kind: "position", id } as Action,
    title: `Record a position for trader #${id}`,
    note: INSIDERS.includes(id) ? "Also a juror. Nobody on chain can tell" : "Ordinary trader",
  })),
  ...INSIDERS.map((id) => ({
    action: { kind: "cast", id, yes: true } as Action,
    title: `Juror #${id} votes YES`,
    note: "Conflicted: holds a position",
  })),
  { action: { kind: "cast", id: 104, yes: true }, title: "Juror #104 votes YES", note: "Bribed: this is the receipt shown to the briber" },
  { action: { kind: "cast", id: 104, yes: false }, title: "Juror #104 re-votes NO", note: "Silently overwrites the bribed ballot" },
  { action: { kind: "cast", id: 105, yes: false }, title: "Juror #105 votes NO", note: "Honest" },
  { action: { kind: "resolve" }, title: "Resolve", note: "MPC drops conflicted jurors, tallies the rest" },
];

const CIRCUIT: Record<Action["kind"], string> = {
  create: "init_court",
  juror: "add_juror",
  position: "record_position",
  cast: "cast",
  resolve: "resolve",
};

// ---------- chain calls ----------

export function courtPda(authority: PublicKey, id: number): PublicKey {
  const idBuf = Buffer.alloc(4);
  idBuf.writeUInt32LE(id);
  return PublicKey.findProgramAddressSync([Buffer.from("court"), authority.toBuffer(), idBuf], PROGRAM_ID)[0];
}

const rand = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export const newComputationOffset = () => new BN(rand(8), "hex");
export const newCourtId = () => new DataView(rand(4).buffer).getUint32(0) >>> 1; // fits i32 like the test

export async function fetchMxePublicKey(c: Client): Promise<Uint8Array> {
  for (let i = 0; i < 10; i++) {
    try {
      const k = await getMXEPublicKey(c.provider, PROGRAM_ID);
      if (k) return k;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Could not read the MXE public key. Is the program deployed and its MXE initialized on devnet?");
}

// Fresh x25519 key per ciphertext: the instruction carries its own pubkey, so nothing to keep.
function encrypt(mxePub: Uint8Array, vals: bigint[]) {
  const priv = rand(32);
  const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxePub));
  const nonce = rand(16);
  const ct = cipher.encrypt(vals, nonce);
  return {
    ct: ct.map((c) => Array.from(c)),
    pub: Array.from(x25519.getPublicKey(priv)),
    nonce: new BN(deserializeLE(nonce).toString()),
  };
}

function queueAccounts(circuit: string, offset: BN) {
  return {
    computationAccount: getComputationAccAddress(CLUSTER_OFFSET, offset),
    clusterAccount: getClusterAccAddress(CLUSTER_OFFSET),
    mxeAccount: getMXEAccAddress(PROGRAM_ID),
    mempoolAccount: getMempoolAccAddress(CLUSTER_OFFSET),
    executingPool: getExecutingPoolAccAddress(CLUSTER_OFFSET),
    compDefAccount: getCompDefAccAddress(PROGRAM_ID, Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE()),
  };
}

/** Sends the queue instruction for one step; returns its tx signature. */
export async function queueStep(c: Client, courtId: number, mxePub: Uint8Array, a: Action, offset: BN): Promise<string> {
  const m = c.program.methods;
  const court = { authority: c.authority, courtAcc: courtPda(c.authority, courtId) };
  let b;
  switch (a.kind) {
    case "create":
      b = m.createCourt(offset, courtId, MARKET);
      break;
    case "juror": {
      const e = encrypt(mxePub, [BigInt(a.id)]);
      b = m.addJuror(offset, courtId, e.ct[0], e.pub, e.nonce);
      break;
    }
    case "position": {
      const e = encrypt(mxePub, [BigInt(a.id)]);
      b = m.recordPosition(offset, courtId, e.ct[0], e.pub, e.nonce).accountsPartial(court);
      break;
    }
    case "cast": {
      const e = encrypt(mxePub, [BigInt(a.id), BigInt(a.yes)]);
      b = m.cast(offset, courtId, e.ct[0], e.ct[1], e.pub, e.nonce).accountsPartial(court);
      break;
    }
    case "resolve":
      b = m.resolve(offset, courtId);
      break;
  }
  return b.accountsPartial(queueAccounts(CIRCUIT[a.kind], offset)).rpc({ skipPreflight: true, commitment: "confirmed" });
}

/** Waits for the MPC callback; returns the finalize tx signature. */
export function awaitStep(c: Client, offset: BN): Promise<string> {
  return awaitComputationFinalization(c.provider, offset, PROGRAM_ID, "confirmed", FINALIZE_TIMEOUT_MS);
}

export async function readVerdict(c: Client, courtId: number) {
  const acc = await c.program.account.courtAccount.fetch(courtPda(c.authority, courtId));
  return { resolved: acc.resolved, yes: acc.yes, no: acc.no, excluded: acc.excluded };
}
export type Verdict = Awaited<ReturnType<typeof readVerdict>>;
