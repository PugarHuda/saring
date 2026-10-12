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
import { DEMO_MARKET, allTraders, identityId, marketHolders, marketQuestion } from "../../panta/panta";
import idl from "./idl/blindcourt.json";
import type { Blindcourt } from "./idl/blindcourt";

export const CLUSTER_OFFSET = 456; // Arcium devnet cluster
// RPC goes through the same-origin proxy (app/api/rpc.js) so the provider key
// stays server-side. VITE_RPC_URL overrides it for local dev.
const proxy = (net: string) => `${globalThis.location?.origin ?? ""}/api/rpc?net=${net}`;
export const RPC_URL: string = import.meta.env.VITE_RPC_URL || proxy("devnet");
export const PROGRAM_ID = new PublicKey(idl.address);
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

// ---------- scenario (built from real Panta data on Solana mainnet) ----------

export const MAINNET_RPC_URL: string = import.meta.env.VITE_MAINNET_RPC_URL || proxy("mainnet");
export { DEMO_MARKET as PANTA_MARKET };
export const pantaMarketUrl = (m: string) => `https://explorer.solana.com/address/${m}`;
export const explorerMainnetAddr = (a: string) => `https://explorer.solana.com/address/${a}`;
const BATCH = 6;

export type Action =
  | { kind: "create"; question: string }
  | { kind: "juror"; wallet: string; id: number }
  | { kind: "positions"; ids: number[] }
  | { kind: "cast"; wallet: string; id: number; yes: boolean }
  | { kind: "resolve" };

export interface ScriptStep {
  action: Action;
  title: string;
  note: string;
}

export interface Juror {
  wallet: string;
  id: number;
  /** Holds a position in the disputed market (read from mainnet). */
  conflicted: boolean;
}

export interface Scenario {
  market: string;
  question: string;
  holderCount: number;
  otherTraderCount: number;
  jurors: Juror[];
  steps: ScriptStep[];
}

const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

/**
 * Reads the disputed Panta market from mainnet and builds the run:
 * 3 jurors are real holders of this market, 2 are real Panta traders who are not.
 * Ballots are scripted (we don't hold those wallets' keys); positions are real.
 */
export async function loadScenario(): Promise<Scenario> {
  const mainnet = new Connection(MAINNET_RPC_URL, "confirmed");
  const [question, holders, traders] = await Promise.all([
    marketQuestion(mainnet, DEMO_MARKET),
    marketHolders(mainnet, DEMO_MARKET),
    allTraders(mainnet),
  ]);
  const outsiders = [...traders.keys()].filter((w) => !traders.get(w)!.has(DEMO_MARKET));
  const conflictedWallets = holders.filter((h) => h.yes + h.no > 0n).slice(0, 3).map((h) => h.owner);
  const jurors: Juror[] = await Promise.all(
    [...conflictedWallets.map((w) => [w, true] as const), ...outsiders.slice(0, 2).map((w) => [w, false] as const)].map(
      async ([wallet, conflicted]) => ({ wallet, id: await identityId(wallet), conflicted })
    )
  );
  const holderIds = await Promise.all(holders.map((h) => identityId(h.owner)));
  const batches: number[][] = [];
  for (let i = 0; i < holderIds.length; i += BATCH) {
    const b = holderIds.slice(i, i + BATCH);
    while (b.length < BATCH) b.push(0);
    batches.push(b);
  }
  const [c1, c2, c3, bribed, honest] = jurors;
  const steps: ScriptStep[] = [
    { action: { kind: "create", question: question.slice(0, 64) }, title: "Open the court", note: `Panta market: “${question}”` },
    ...jurors.map((j) => ({
      action: { kind: "juror", wallet: j.wallet, id: j.id } as Action,
      title: `Seat juror ${short(j.wallet)}`,
      note: j.conflicted ? "Real holder of this market. Nobody on chain can tell" : "Real Panta trader, no position here",
    })),
    ...batches.map((ids, i) => ({
      action: { kind: "positions", ids } as Action,
      title: `Mirror Panta positions ${i * BATCH + 1}–${Math.min((i + 1) * BATCH, holderIds.length)} of ${holderIds.length}`,
      note: "Read from mainnet, sent as ciphertext",
    })),
    ...[c1, c2, c3].map((j) => ({
      action: { kind: "cast", wallet: j.wallet, id: j.id, yes: true } as Action,
      title: `Juror ${short(j.wallet)} votes YES`,
      note: "Conflicted: holds a position",
    })),
    { action: { kind: "cast", wallet: bribed.wallet, id: bribed.id, yes: true }, title: `Juror ${short(bribed.wallet)} votes YES`, note: "Bribed: this is the receipt shown to the briber" },
    { action: { kind: "cast", wallet: bribed.wallet, id: bribed.id, yes: false }, title: `Juror ${short(bribed.wallet)} re-votes NO`, note: "Silently overwrites the bribed ballot" },
    { action: { kind: "cast", wallet: honest.wallet, id: honest.id, yes: false }, title: `Juror ${short(honest.wallet)} votes NO`, note: "Clean juror" },
    { action: { kind: "resolve" }, title: "Resolve", note: "MPC drops conflicted jurors, tallies the rest" },
  ];
  return {
    market: DEMO_MARKET,
    question,
    holderCount: holders.length,
    otherTraderCount: outsiders.length,
    jurors,
    steps,
  };
}

const CIRCUIT: Record<Action["kind"], string> = {
  create: "init_court",
  juror: "add_juror",
  positions: "record_positions",
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
      b = m.createCourt(offset, courtId, a.question);
      break;
    case "juror": {
      const e = encrypt(mxePub, [BigInt(a.id)]);
      b = m.addJuror(offset, courtId, e.ct[0], e.pub, e.nonce);
      break;
    }
    case "positions": {
      const e = encrypt(mxePub, a.ids.map(BigInt));
      b = m.recordPositions(offset, courtId, e.ct, e.pub, e.nonce).accountsPartial(court);
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
  const tx = await b.accountsPartial(queueAccounts(CIRCUIT[a.kind], offset)).transaction();
  return sendAndPoll(c, tx);
}

/**
 * Signs, sends and confirms by polling getSignatureStatuses over HTTP. Anchor's
 * `.rpc()` confirms over a websocket, which the serverless RPC proxy can't carry.
 */
async function sendAndPoll(c: Client, tx: Transaction): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await c.connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = c.authority;
  const signed = await c.provider.wallet.signTransaction(tx);
  const raw = signed.serialize();
  const sig = await c.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 });
  while ((await c.connection.getBlockHeight("confirmed")) <= lastValidBlockHeight) {
    const { value } = await c.connection.getSignatureStatuses([sig]);
    const s = value[0];
    if (s?.err) throw new Error(`Transaction ${sig} failed: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return sig;
    await c.connection.sendRawTransaction(raw, { skipPreflight: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Transaction ${sig} expired before confirmation`);
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
