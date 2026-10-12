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
/** Stake the visitor puts on the court's own market when they choose to bet. */
export const BET_LAMPORTS = 10_000_000; // 0.01 SOL

export type Action =
  | { kind: "create"; question: string }
  | { kind: "market" }
  | { kind: "juror"; wallet: string; id: number; key: number; you?: boolean }
  | { kind: "bet"; yes: boolean; lamports: number }
  | { kind: "positions"; ids: number[] }
  | { kind: "cast"; wallet: string; id: number; key: number; newKey: number; yes: boolean; counts: boolean }
  | { kind: "resolve" }
  | { kind: "claim" };

/** Steps that queue an Arcium computation (the rest are plain transactions). */
export const isMpc = (a: Action) => a.kind in CIRCUIT;

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
  you?: boolean;
}

/** What the visitor decides before running: their own ballot, and whether they also bet. */
export interface Choice {
  vote: boolean;
  /** null = no bet; true/false = 0.01 SOL on YES/NO in the court's market. */
  bet: boolean | null;
}
export const DEFAULT_CHOICE: Choice = { vote: false, bet: null };

export interface Scenario {
  market: string;
  question: string;
  holderCount: number;
  openHolderCount: number;
  otherTraderCount: number;
  /** Scripted jurors (real Panta wallets) followed by the visitor. */
  jurors: Juror[];
  holderIds: number[];
  steps: ScriptStep[];
}

const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
const rand = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
/** Secret ballot key: 31-bit, never 0. */
export const newKey = () => new DataView(rand(4).buffer).getUint32(0) >>> 1 || 1;

/**
 * Reads the disputed Panta market from mainnet. 3 scripted jurors are real holders
 * of this market, 2 are real Panta traders who are not; the 6th juror is the
 * visitor (their burner), who picks their own key and ballot.
 */
export async function loadScenario(you: PublicKey, choice: Choice = DEFAULT_CHOICE): Promise<Scenario> {
  const mainnet = new Connection(MAINNET_RPC_URL, "confirmed");
  const [question, holders, traders] = await Promise.all([
    marketQuestion(mainnet, DEMO_MARKET),
    marketHolders(mainnet, DEMO_MARKET),
    allTraders(mainnet),
  ]);
  const outsiders = [...traders.keys()].filter((w) => !traders.get(w)!.has(DEMO_MARKET));
  const conflictedWallets = holders.filter((h) => h.yes + h.no > 0n).slice(0, 3).map((h) => h.owner);
  const scripted: Juror[] = await Promise.all(
    [...conflictedWallets.map((w) => [w, true] as const), ...outsiders.slice(0, 2).map((w) => [w, false] as const)].map(
      async ([wallet, conflicted]) => ({ wallet, id: await identityId(wallet), conflicted })
    )
  );
  const me = you.toBase58();
  const sc: Scenario = {
    market: DEMO_MARKET,
    question,
    holderCount: holders.length,
    openHolderCount: holders.filter((h) => h.yes + h.no > 0n).length,
    otherTraderCount: outsiders.length,
    jurors: [...scripted, { wallet: me, id: await identityId(me), conflicted: choice.bet !== null, you: true }],
    holderIds: await Promise.all(holders.map((h) => identityId(h.owner))),
    steps: [],
  };
  sc.steps = buildSteps(sc, choice);
  return sc;
}

/** Rebuilds the run for the visitor's choice (fresh secret keys every time). */
export function buildSteps(sc: Scenario, choice: Choice): ScriptStep[] {
  const jurors = sc.jurors.map((j) => (j.you ? { ...j, conflicted: choice.bet !== null } : j));
  sc.jurors = jurors;
  const keys = new Map(jurors.map((j) => [j.wallet, newKey()]));
  const [c1, c2, c3, bribed, honest, me] = jurors;
  const positionIds = [...sc.holderIds, ...(choice.bet !== null ? [me.id] : [])];
  const batches: number[][] = [];
  for (let i = 0; i < positionIds.length; i += BATCH) {
    const b = positionIds.slice(i, i + BATCH);
    while (b.length < BATCH) b.push(0);
    batches.push(b);
  }
  const k = (j: Juror) => keys.get(j.wallet)!;
  const cast = (j: Juror, key: number, yes: boolean, counts: boolean, title: string, note: string, newK = 0): ScriptStep => ({
    action: { kind: "cast", wallet: j.wallet, id: j.id, key, newKey: newK, yes, counts },
    title,
    note,
  });
  const rotated = newKey();
  const forged = newKey();
  return [
    { action: { kind: "create", question: utf8Slice(sc.question, 64) }, title: "Open the court", note: `Panta market: “${sc.question}”` },
    { action: { kind: "market" }, title: "Open a market that settles on this court", note: "Pari-mutuel YES/NO pool, paid out by the verdict" },
    ...jurors.map((j) => ({
      action: { kind: "juror", wallet: j.wallet, id: j.id, key: k(j), you: j.you } as Action,
      title: j.you ? "Seat you as a juror" : `Seat juror ${short(j.wallet)}`,
      note: j.you
        ? "Your id and your secret ballot key, encrypted in this browser"
        : j.conflicted
          ? "Real holder of this market, with a secret ballot key. Nobody on chain can tell"
          : "Real Panta trader with no position here, with a secret ballot key",
    })),
    ...(choice.bet !== null
      ? [{ action: { kind: "bet", yes: choice.bet, lamports: BET_LAMPORTS } as Action, title: `You bet 0.01 SOL on ${choice.bet ? "YES" : "NO"}`, note: "Public on chain, so it gets mirrored into the court" }]
      : []),
    ...batches.map((ids, i) => ({
      action: { kind: "positions", ids } as Action,
      title: `Mirror positions ${i * BATCH + 1}–${Math.min((i + 1) * BATCH, positionIds.length)} of ${positionIds.length}`,
      note: i * BATCH + BATCH > sc.holderIds.length && choice.bet !== null ? "Panta holders from mainnet, plus your bet" : "Panta holders read from mainnet, sent as ciphertext",
    })),
    ...[c1, c2, c3].map((j) => cast(j, k(j), true, true, `Juror ${short(j.wallet)} votes YES`, "Conflicted: holds a position")),
    cast(bribed, k(bribed), true, true, `Juror ${short(bribed.wallet)} votes YES`, "Bribed: shows the briber this ballot and hands over the key"),
    cast(bribed, k(bribed), false, true, `Juror ${short(bribed.wallet)} re-votes NO and rotates the key`, "Silently overwrites the bribed ballot", rotated),
    cast(bribed, k(bribed), true, false, "The briber re-sends YES with the handed-over key", "Stale key: ignored inside MPC, and the briber can't tell"),
    cast(honest, k(honest), false, true, `Juror ${short(honest.wallet)} votes NO`, "Clean juror"),
    cast(honest, forged, true, false, `An attacker forges a YES for ${short(honest.wallet)}`, "Guessed key: ignored inside MPC"),
    cast(me, k(me), choice.vote, true, `You vote ${choice.vote ? "YES" : "NO"}`, choice.bet !== null ? "You hold a position, so MPC will drop your ballot" : "Your ballot, encrypted in this browser"),
    { action: { kind: "resolve" }, title: "Resolve", note: "MPC drops conflicted jurors, tallies the rest" },
    ...(choice.bet !== null ? [{ action: { kind: "claim" } as Action, title: "Claim your bet", note: "The market pays out on the verdict" }] : []),
  ];
}

/** Final ballot per juror as scripted (ignored ballots excluded), for the "normal jury" tally. */
export function finalBallots(steps: ScriptStep[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const s of steps) if (s.action.kind === "cast" && s.action.counts) out.set(s.action.wallet, s.action.yes);
  return out;
}

/** Truncates to at most `max` UTF-8 bytes without splitting a character. */
function utf8Slice(s: string, max: number) {
  let out = "";
  for (const ch of s) {
    if (new TextEncoder().encode(out + ch).length > max) break;
    out += ch;
  }
  return out;
}

const CIRCUIT: Partial<Record<Action["kind"], string>> = {
  create: "init_court_v3",
  juror: "add_juror_v3",
  positions: "record_positions_v3",
  cast: "cast_v3",
  resolve: "resolve_v3",
};

// ---------- chain calls ----------

export function courtPda(authority: PublicKey, id: number): PublicKey {
  const idBuf = Buffer.alloc(4);
  idBuf.writeUInt32LE(id);
  return PublicKey.findProgramAddressSync([Buffer.from("court"), authority.toBuffer(), idBuf], PROGRAM_ID)[0];
}
const marketPda = (court: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("market"), court.toBuffer()], PROGRAM_ID)[0];
const vaultPda = (market: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM_ID)[0];

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

/** Sends one step's transaction (queueing an MPC computation when it is one); returns its signature. */
export async function queueStep(c: Client, courtId: number, mxePub: Uint8Array, a: Action, offset: BN): Promise<string> {
  const m = c.program.methods;
  const courtAcc = courtPda(c.authority, courtId);
  const market = marketPda(courtAcc);
  const marketAccs = { courtAcc, market, vault: vaultPda(market) };
  const court = { authority: c.authority, courtAcc };
  let b;
  switch (a.kind) {
    case "create":
      b = m.createCourt(offset, courtId, a.question);
      break;
    case "market":
      return sendAndPoll(c, await m.createMarket().accountsPartial(marketAccs).transaction());
    case "bet":
      return sendAndPoll(c, await m.bet(a.yes, new BN(a.lamports)).accountsPartial({ bettor: c.authority, ...marketAccs }).transaction());
    case "claim":
      return sendAndPoll(c, await m.claim().accountsPartial({ bettor: c.authority, ...marketAccs }).transaction());
    case "juror": {
      const e = encrypt(mxePub, [BigInt(a.id), BigInt(a.key)]);
      b = m.addJuror(offset, courtId, e.ct[0], e.ct[1], e.pub, e.nonce);
      break;
    }
    case "positions": {
      const e = encrypt(mxePub, a.ids.map(BigInt));
      b = m.recordPositions(offset, courtId, e.ct, e.pub, e.nonce).accountsPartial(court);
      break;
    }
    case "cast": {
      const e = encrypt(mxePub, [BigInt(a.id), BigInt(a.key), BigInt(a.newKey), BigInt(a.yes)]);
      b = m.cast(offset, courtId, e.ct[0], e.ct[1], e.ct[2], e.ct[3], e.pub, e.nonce).accountsPartial(court);
      break;
    }
    case "resolve":
      b = m.resolve(offset, courtId);
      break;
  }
  const tx = await b.accountsPartial(queueAccounts(CIRCUIT[a.kind]!, offset)).transaction();
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

/**
 * Waits for the MPC callback and returns the signature of the callback that
 * succeeded. Arx nodes race to deliver it, so the computation account also carries
 * late duplicates that fail with AlreadyCallbackedComputation; the SDK helper can
 * return one of those, so pick the one with no error.
 */
export async function awaitStep(c: Client, offset: BN): Promise<string> {
  const reported = await awaitComputationFinalization(c.provider, offset, PROGRAM_ID, "confirmed", FINALIZE_TIMEOUT_MS);
  try {
    const sigs = await c.connection.getSignaturesForAddress(getComputationAccAddress(CLUSTER_OFFSET, offset), { limit: 10 }, "confirmed");
    const ok = sigs.filter((s) => s.err === null).map((s) => s.signature);
    // Newest first; the oldest successful one after the queue tx is the callback.
    return ok.length >= 2 ? ok[ok.length - 2] : ok[0] ?? reported;
  } catch {
    return reported;
  }
}

export async function readVerdict(c: Client, courtId: number) {
  const acc = await c.program.account.courtAccount.fetch(courtPda(c.authority, courtId));
  return { resolved: acc.resolved, yes: acc.yes, no: acc.no, excluded: acc.excluded, incomplete: acc.incomplete };
}
export type Verdict = Awaited<ReturnType<typeof readVerdict>>;

/** The visitor's bet and payout, if they bet in this court's market. */
export async function readBet(c: Client, courtId: number) {
  const market = marketPda(courtPda(c.authority, courtId));
  const bet = PublicKey.findProgramAddressSync([Buffer.from("bet"), market.toBuffer(), c.authority.toBuffer()], PROGRAM_ID)[0];
  try {
    const [m, b] = await Promise.all([c.program.account.marketAccount.fetch(market), c.program.account.betAccount.fetch(bet)]);
    return { yesPool: m.yesPool.toNumber(), noPool: m.noPool.toNumber(), yes: b.yes, amount: b.amount.toNumber(), claimed: b.claimed };
  } catch {
    return null;
  }
}
