/**
 * @saring/sdk: run a conflict-blind jury (Saring on Solana + Arcium MPC) from a venue.
 *
 * Same instructions and accounts as tests/blindcourt.ts, packaged as a client.
 * Every MPC step sends the queue transaction, then waits for the Arcium callback and
 * returns both signatures.
 */
import { AnchorProvider, BN, EventParser, Program, type Wallet } from "@anchor-lang/core";
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
import { SARING_PROGRAM_ID, readCourtVerdict, type Verdict } from "./venue";

export * from "./venue";
export type { Blindcourt };

/** Arcium devnet cluster the deployed program uses. */
export const DEFAULT_CLUSTER_OFFSET = 456;
/** Position ids per record_positions call (fixed by the circuit). */
export const POSITIONS_PER_BATCH = 6;
const FINALIZE_TIMEOUT_MS = 300_000;

/** A Keypair, or anything wallet-adapter shaped. */
export type SaringSigner =
  | Keypair
  | { publicKey: PublicKey; signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> };

export interface MpcResult {
  /** The transaction that queued the computation. */
  queueSig: string;
  /** The Arcium callback transaction that succeeded and wrote the result. */
  callbackSig: string;
}

export interface Ballot {
  jurorId: number;
  /** The seat's current secret ballot key. A wrong key is silently ignored inside MPC. */
  key: number;
  /** Non-zero rotates the seat's key (anti-bribery: the old key stops counting). */
  newKey?: number;
  yes: boolean;
}

export class MpcAbortedError extends Error {}

const rand = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** Fresh secret ballot key: 31-bit, never 0. */
export const newBallotKey = (): number => new DataView(rand(4).buffer).getUint32(0) >>> 1 || 1;

/**
 * Court identity for a wallet: first 4 bytes (LE) of SHA-256(pubkey), never 0.
 * Same function as panta/panta.ts, used for both jurors and position holders, so a
 * juror who traded collides with their own position inside MPC and nowhere else.
 */
export async function identityId(wallet: PublicKey | string): Promise<number> {
  const h = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(new PublicKey(wallet).toBytes())));
  const id = new DataView(h.buffer).getUint32(0, true);
  return id === 0 ? 1 : id;
}

export function courtAddress(authority: PublicKey, courtId: number, programId = SARING_PROGRAM_ID): PublicKey {
  const idBuf = Buffer.alloc(4);
  idBuf.writeUInt32LE(courtId);
  return PublicKey.findProgramAddressSync([Buffer.from("court"), authority.toBuffer(), idBuf], programId)[0];
}
export const marketAddress = (court: PublicKey, programId = SARING_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from("market"), court.toBuffer()], programId)[0];
export const vaultAddress = (market: PublicKey, programId = SARING_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], programId)[0];

function toWallet(s: SaringSigner): Wallet {
  if (s instanceof Keypair) {
    const sign = <T extends Transaction | VersionedTransaction>(tx: T): T => {
      if (tx instanceof VersionedTransaction) tx.sign([s]);
      else tx.partialSign(s);
      return tx;
    };
    return { publicKey: s.publicKey, payer: s, signTransaction: async (tx) => sign(tx), signAllTransactions: async (txs) => txs.map(sign) };
  }
  return {
    publicKey: s.publicKey,
    signTransaction: (tx) => s.signTransaction(tx),
    signAllTransactions: (txs) => Promise.all(txs.map((t) => s.signTransaction(t))),
  } as Wallet;
}

export class SaringClient {
  readonly provider: AnchorProvider;
  readonly program: Program<Blindcourt>;
  readonly clusterOffset: number;
  private mxePub?: Uint8Array;

  constructor(readonly connection: Connection, signer: SaringSigner, clusterOffset = DEFAULT_CLUSTER_OFFSET) {
    this.provider = new AnchorProvider(connection, toWallet(signer), { commitment: "confirmed" });
    this.program = new Program<Blindcourt>(idl as Blindcourt, this.provider);
    this.clusterOffset = clusterOffset;
  }

  get publicKey(): PublicKey {
    return this.provider.wallet.publicKey;
  }

  courtAddress(courtId: number, authority = this.publicKey): PublicKey {
    return courtAddress(authority, courtId, this.program.programId);
  }

  // ---------- court (MPC steps) ----------

  /** Opens a court for `question` (≤ 64 UTF-8 bytes). The caller becomes its authority. */
  async openCourt(question: string, courtId = newCourtId()): Promise<MpcResult & { courtId: number; court: PublicKey }> {
    if (Buffer.byteLength(question) > 64) throw new Error("question must be at most 64 UTF-8 bytes");
    const r = await this.mpc("init_court_v3", (o) => this.program.methods.createCourt(o, courtId, question));
    return { ...r, courtId, court: this.courtAddress(courtId) };
  }

  /** Seats a juror. (id, key) are encrypted client-side to the MXE; the chain never sees them. */
  async seatJuror(courtId: number, jurorId: number, key: number): Promise<MpcResult> {
    const e = await this.encrypt([jurorId, key]);
    return this.mpc("add_juror_v3", (o) => this.program.methods.addJuror(o, courtId, e.ct[0], e.ct[1], e.pub, e.nonce));
  }

  /** Records identities that hold a position in the disputed market, 6 per MPC call (padded with 0). */
  async mirrorPositions(courtId: number, ids: number[]): Promise<MpcResult[]> {
    const out: MpcResult[] = [];
    for (let i = 0; i < ids.length; i += POSITIONS_PER_BATCH) {
      const batch = ids.slice(i, i + POSITIONS_PER_BATCH);
      while (batch.length < POSITIONS_PER_BATCH) batch.push(0);
      const e = await this.encrypt(batch);
      out.push(
        await this.mpc("record_positions_v3", (o) =>
          this.program.methods
            .recordPositions(o, courtId, e.ct, e.pub, e.nonce)
            .accountsPartial({ authority: this.publicKey, courtAcc: this.courtAddress(courtId) })
        )
      );
    }
    return out;
  }

  /**
   * Casts or overwrites a ballot. Anyone can relay it: the payer reveals nothing about
   * the juror. `authority` is the court's authority (defaults to this signer).
   */
  async cast(courtId: number, b: Ballot, authority = this.publicKey): Promise<MpcResult> {
    const e = await this.encrypt([b.jurorId, b.key, b.newKey ?? 0, b.yes ? 1 : 0]);
    return this.mpc("cast_v3", (o) =>
      this.program.methods
        .cast(o, courtId, e.ct[0], e.ct[1], e.ct[2], e.ct[3], e.pub, e.nonce)
        .accountsPartial({ authority, courtAcc: this.courtAddress(courtId, authority) })
    );
  }

  /** Tallies conflict-free ballots inside MPC and publishes (yes, no, excluded, incomplete). */
  async resolve(courtId: number): Promise<MpcResult & Verdict> {
    const r = await this.mpc("resolve_v3", (o) => this.program.methods.resolve(o, courtId));
    const v = await this.readVerdict(this.courtAddress(courtId));
    if (!v.resolved) throw new MpcAbortedError(`resolve callback ${r.callbackSig} landed but the court is not resolved`);
    return { ...r, ...v };
  }

  /** Releases a stuck computation lock (~300 slots after it was taken). Authority only. */
  async resetPending(courtId: number): Promise<string> {
    return this.send(await this.program.methods.resetPending(courtId).accountsPartial({ courtAcc: this.courtAddress(courtId) }).transaction());
  }

  // ---------- verdict ----------

  async readVerdict(court: PublicKey): Promise<Verdict> {
    return readCourtVerdict(this.connection, court, this.program.programId);
  }

  /** Polls until the court is resolved. */
  async waitForVerdict(court: PublicKey, timeoutMs = FINALIZE_TIMEOUT_MS, pollMs = 3000): Promise<Verdict> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = await this.readVerdict(court);
      if (v.resolved) return v;
      if (Date.now() > end) throw new Error(`Court ${court.toBase58()} not resolved after ${timeoutMs} ms`);
      await sleep(pollMs);
    }
  }

  // ---------- built-in pari-mutuel market (settles on the verdict) ----------

  private marketAccs(court: PublicKey) {
    const market = marketAddress(court, this.program.programId);
    return { courtAcc: court, market, vault: vaultAddress(market, this.program.programId) };
  }

  async createMarket(court: PublicKey): Promise<{ sig: string; market: PublicKey; vault: PublicKey }> {
    const accs = this.marketAccs(court);
    const sig = await this.send(await this.program.methods.createMarket().accountsPartial(accs).transaction());
    return { sig, market: accs.market, vault: accs.vault };
  }

  /** Stakes `lamports` (≥ 0.001 SOL) on YES or NO from this signer. */
  async bet(court: PublicKey, yes: boolean, lamports: number): Promise<string> {
    return this.send(
      await this.program.methods.bet(yes, new BN(lamports)).accountsPartial({ bettor: this.publicKey, ...this.marketAccs(court) }).transaction()
    );
  }

  /** Pays this signer's bet after the verdict (winners pro rata; tie/incomplete refunds). */
  async claim(court: PublicKey): Promise<string> {
    return this.send(await this.program.methods.claim().accountsPartial({ bettor: this.publicKey, ...this.marketAccs(court) }).transaction());
  }

  // ---------- plumbing ----------

  async mxePublicKey(): Promise<Uint8Array> {
    if (this.mxePub) return this.mxePub;
    for (let i = 0; i < 10; i++) {
      try {
        const k = await getMXEPublicKey(this.provider, this.program.programId);
        if (k) return (this.mxePub = k);
      } catch {
        /* retry */
      }
      await sleep(1000);
    }
    throw new Error("Could not read the MXE public key (program deployed and MXE initialized on this cluster?)");
  }

  /** Fresh x25519 key per ciphertext; the instruction carries its pubkey, so nothing to keep. */
  private async encrypt(vals: number[]) {
    const priv = rand(32);
    const cipher = new RescueCipher(x25519.getSharedSecret(priv, await this.mxePublicKey()));
    const nonce = rand(16);
    return {
      ct: cipher.encrypt(vals.map(BigInt), nonce).map((c) => Array.from(c)),
      pub: Array.from(x25519.getPublicKey(priv)),
      nonce: new BN(deserializeLE(nonce).toString()),
    };
  }

  private queueAccounts(circuit: string, offset: BN) {
    const c = this.clusterOffset;
    return {
      computationAccount: getComputationAccAddress(c, offset),
      clusterAccount: getClusterAccAddress(c),
      mxeAccount: getMXEAccAddress(this.program.programId),
      mempoolAccount: getMempoolAccAddress(c),
      executingPool: getExecutingPoolAccAddress(c),
      compDefAccount: getCompDefAccAddress(this.program.programId, Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE()),
    };
  }

  /** Queues one computation, waits for its callback, and fails loudly if MPC aborted. */
  private async mpc(circuit: string, build: (offset: BN) => { accountsPartial(a: any): { transaction(): Promise<Transaction> } }): Promise<MpcResult> {
    const offset = new BN(rand(8), "hex");
    const queueSig = await this.send(await build(offset).accountsPartial(this.queueAccounts(circuit, offset)).transaction());
    const reported = await awaitComputationFinalization(this.provider, offset, this.program.programId, "confirmed", FINALIZE_TIMEOUT_MS);
    const callbackSig = await this.successfulCallback(offset, queueSig, reported);
    const tx = await this.connection.getTransaction(callbackSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const logs = tx?.meta?.logMessages ?? [];
    for (const ev of new EventParser(this.program.programId, this.program.coder).parseLogs(logs)) {
      if (ev.name === "computationAbortedEvent" || ev.name === "ComputationAbortedEvent")
        throw new MpcAbortedError(`${circuit}: MPC computation aborted (callback ${callbackSig}); court state unchanged`);
    }
    return { queueSig, callbackSig };
  }

  /**
   * Arx nodes race to deliver the callback; late duplicates fail with
   * AlreadyCallbackedComputation and the Arcium helper may report one of those.
   * The callback is the oldest successful transaction on the computation account
   * other than the queue transaction.
   */
  private async successfulCallback(offset: BN, queueSig: string, reported: string): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const sigs = await this.connection.getSignaturesForAddress(getComputationAccAddress(this.clusterOffset, offset), { limit: 20 }, "confirmed");
      const ok = sigs.filter((s) => s.err === null && s.signature !== queueSig).sort((a, b) => a.slot - b.slot);
      if (ok.length) return ok[0].signature;
      await sleep(1500);
    }
    return reported;
  }

  /**
   * Signs, sends and confirms by polling getSignatureStatuses over HTTP. Anchor's
   * `.rpc()` confirms over a websocket, which hangs on some RPC providers.
   */
  async send(tx: Transaction): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.publicKey;
    const raw = (await this.provider.wallet.signTransaction(tx)).serialize();
    const sig = await this.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 });
    while ((await this.connection.getBlockHeight("confirmed")) <= lastValidBlockHeight) {
      const s = (await this.connection.getSignatureStatuses([sig])).value[0];
      if (s?.err) throw new Error(`Transaction ${sig} failed: ${JSON.stringify(s.err)}`);
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return sig;
      await this.connection.sendRawTransaction(raw, { skipPreflight: true }).catch(() => {});
      await sleep(1500);
    }
    throw new Error(`Transaction ${sig} expired before confirmation`);
  }
}

/** Random court id that fits i32 (like the tests). */
export const newCourtId = (): number => new DataView(rand(4).buffer).getUint32(0) >>> 1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
