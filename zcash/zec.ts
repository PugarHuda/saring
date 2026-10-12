/**
 * Shared Zcash plumbing for the Saring scripts: drive zcash-devtool (librustzcash
 * light wallet, Orchard + Sapling, talks to a testnet lightwalletd) and read the
 * notes a wallet decrypted with its viewing key straight from its SQLite db.
 *
 * Wallet data (seeds encrypted to an age identity) lives in ~/.saring-zcash,
 * never in this repo. Nothing here prints a seed or a spending key.
 */
import { execFileSync, spawnSync } from "child_process";
import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const HOME = process.env.SARING_ZEC_HOME ?? path.join(os.homedir(), ".saring-zcash");
export const DEVTOOL = process.env.ZCASH_DEVTOOL ?? path.join(os.homedir(), "tools/zcash-devtool/target/release/zcash-devtool");
export const OUT = path.join(__dirname, "out");
export const ZAT = 100_000_000;
/** Bond a juror posts before seating, and the reward a counted juror earns (zatoshis). */
export const BOND_ZAT = Number(process.env.BOND_ZAT ?? 1_000_000); // 0.01 TAZ
export const REWARD_ZAT = Number(process.env.REWARD_ZAT ?? 500_000); // 0.005 TAZ

// ponytail: ZecBlock follows the NU7 testnet; testnet.zcashexplorer.app was stuck on the pre-NU7 fork (Oct 2026).
export const explorer = (txid: string) => `https://testnet.zecblock.com/tx/${txid}`;
export const taz = (zat: number) => `${(zat / ZAT).toFixed(8)} TAZ`;

const walletDir = (w: string) => path.join(HOME, w);

/** Runs `zcash-devtool wallet -w ~/.saring-zcash/<w> ...`. stdin is closed so nothing can prompt. */
export function devtool(w: string, args: string[]): string {
  return execFileSync(DEVTOOL, ["wallet", "-w", walletDir(w), ...args], {
    encoding: "utf8",
    input: "",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 << 20,
    env: { ...process.env, RUST_LOG: "warn" },
  });
}

// sync scans compact blocks (no memos); enhance fetches full txs so memos get decrypted.
export const sync = (w: string) => devtool(w, ["sync"]) + devtool(w, ["enhance"]);

/** The account's default Unified Address (Orchard + Sapling receivers). */
export function defaultUA(w: string): string {
  const m = /Default Address: (\S+)/.exec(devtool(w, ["list-addresses"]));
  if (!m) throw new Error(`no address in wallet ${w}`);
  return m[1];
}

/** The account's Unified Full Viewing Key (view-only: can decrypt, cannot spend). */
export function ufvk(w: string): string {
  const m = /UFVK: (uview\S+)/.exec(devtool(w, ["list-accounts"]));
  if (!m) throw new Error(`no UFVK in wallet ${w}`);
  return m[1];
}

/**
 * The Orchard-family receiver of a UA, as a receiver-only UA. This is the address a
 * shielded payment actually lands on and the form a view-only wallet recovers for an
 * outgoing note (via the OVK), so jurors commit to it and get paid at it.
 */
export function orchardReceiver(ua: string): string {
  const r = spawnSync(DEVTOOL, ["inspect", ua], { encoding: "utf8", input: "" }); // prints to stderr
  const m = /Orchard \((utest1\w+)\)/.exec(r.stdout + r.stderr);
  if (!m) throw new Error(`no Orchard receiver in ${ua.slice(0, 16)}...`);
  return m[1];
}

export function birthday(w: string): number {
  const m = /birthday height (\d+)/.exec(devtool(w, ["list-accounts"]));
  if (!m) throw new Error(`no birthday in wallet ${w}`);
  return Number(m[1]);
}

/**
 * A separate, spend-incapable wallet that holds only a UFVK, synced to the chain tip.
 * Created on first use from `ufvkStr`, with the source wallet's birthday so it sees
 * every note from the start.
 */
export function viewWallet(name: string, ufvkStr: string, fromHeight: number): void {
  if (!fs.existsSync(path.join(walletDir(name), "data.sqlite")))
    devtool(name, ["init-fvk", "--name", name, "--fvk", ufvkStr, "--birthday", String(fromHeight)]);
  if (!/Purpose: view-only/.test(devtool(name, ["list-accounts"]))) throw new Error(`${name} is not a view-only wallet`);
  sync(name);
}

/**
 * One payment through ZIP-321: every output is shielded to the recipient's UA
 * (Orchard preferred) with a memo encrypted to that recipient. Returns the txid.
 */
export function pay(w: string, outs: { address: string; zat: number; memo: string }[]): string {
  const p = (i: number) => (i === 0 ? "" : `.${i}`);
  const q = outs
    .map((o, i) => `address${p(i)}=${o.address}&amount${p(i)}=${(o.zat / ZAT).toFixed(8).replace(/\.?0+$/, "")}&memo${p(i)}=${Buffer.from(o.memo).toString("base64url")}`)
    .join("&");
  const stdout = devtool(w, ["pay", "-i", path.join(HOME, `${w}.age`), "--disable-confirmation", "--payment-uri", `zcash:?${q}`]);
  const m = /([0-9a-f]{64})\s*$/.exec(stdout.trim());
  if (!m) throw new Error(`pay from ${w} returned no txid:\n${stdout}`);
  return m[1];
}

export interface Note {
  txid: string;
  height: number | null;
  /** Never mined and past its expiry height: its inputs are spendable again. */
  expired: boolean;
  /** Block time (unix seconds) once mined. */
  time: number | null;
  pool: "transparent" | "sapling" | "orchard" | "ironwood" | string;
  zat: number;
  /** true: this wallet received it; false: this wallet sent it to someone else. */
  incoming: boolean;
  change: boolean;
  to: string | null;
  memo: string | null;
}

/** Text memo per ZIP-302 (first byte ≤ 0xF4 is UTF-8, zero-padded); anything else is null. */
export function memoText(b: Uint8Array | null): string | null {
  if (!b || b.length === 0 || b[0] > 0xf4) return null;
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;
  return Buffer.from(b.subarray(0, end)).toString("utf8");
}

/**
 * Every output the wallet's viewing key decrypted: received notes (incoming viewing
 * key) and, for a full viewing key, what this account sent (outgoing viewing key).
 */
export function notes(w: string): Note[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(walletDir(w), "data.sqlite"), { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT t.txid, t.mined_height, t.block_time, t.expired_unmined, o.output_pool, o.value, o.is_change, o.to_address, o.memo,
                o.from_account_uuid, o.to_account_uuid
         FROM v_tx_outputs o JOIN v_transactions t ON t.txid = o.txid -- ponytail: one account per wallet dir
         ORDER BY COALESCE(t.mined_height, 1e12), o.output_index`
      )
      .all() as any[];
    const pools: Record<number, string> = { 0: "transparent", 2: "sapling", 3: "orchard", 4: "ironwood" };
    return rows.map((r) => ({
      txid: Buffer.from(r.txid).reverse().toString("hex"),
      height: r.mined_height ?? null,
      time: r.block_time == null ? null : Number(r.block_time),
      expired: !!r.expired_unmined,
      pool: pools[r.output_pool] ?? String(r.output_pool),
      zat: Number(r.value),
      incoming: r.to_account_uuid != null && r.from_account_uuid == null,
      change: !!r.is_change,
      to: r.to_address ?? null,
      memo: memoText(r.memo ?? null),
    }));
  } finally {
    db.close();
  }
}

// ---------- jurors ----------

/** What the operator learns from a juror at registration (held off-chain, outside the repo). */
export interface JurorRecord {
  name: string;
  /** Saring identity: identityId(juror's Solana wallet). Never goes on Zcash. */
  jurorId: number;
  /** Random salt the juror chose; commitment = sha256(jurorId_le32 || salt || court). */
  salt: string;
  /** Where the juror wants refunds and rewards. */
  ua: string;
}

/** Per-court juror commitment: unlinkable across courts, opens only with the juror's salt. */
export function commitment(jurorId: number, saltHex: string, court: string): string {
  const id = Buffer.alloc(4);
  id.writeUInt32LE(jurorId);
  return createHash("sha256").update(Buffer.concat([id, Buffer.from(saltHex, "hex"), Buffer.from(court)])).digest("hex");
}

/**
 * Payout-address commitment the juror posts on Solana when seated. A UA is
 * high-entropy (diversified keys), so no salt: anyone holding the recipient address
 * (the juror, or a UFVK auditor who recovered it from the payout) can recheck it.
 */
export const uaCommit = (court: string, c: string, receiver: string) =>
  createHash("sha256").update(`saring-ua:${court}:${c}:${receiver}`).digest("hex");

export const newSalt = () => randomBytes(16).toString("hex");

/** Bond memo. `seatKey` is the per-court Solana key that alone may seat/cast for this commitment. */
export const bondMemo = (court: string, c: string, seatKey: string) => `saring-bond:${court}:${c}:${seatKey}`;
const B58 = "[1-9A-HJ-NP-Za-km-z]{32,44}";
export const parseBondMemo = (m: string | null) => {
  const x = new RegExp(`^saring-bond:(${B58}):([0-9a-f]{64})(?::(${B58}))?$`).exec(m ?? "");
  return x ? { court: x[1], commitment: x[2], seatKey: x[3] ?? null } : null;
};
// Solana memos, signed by the seat key inside the add_juror / cast transaction itself.
export const seatMemo = (c: string, u: string) => `saring-seat:${c}:${u}`;
export const castMemo = (c: string) => `saring-cast:${c}`;
export const refundMemo = (court: string, c: string) => `saring-refund:${court}:${c}`;
export const rewardMemo = (court: string, verdict: string, c: string) => `saring-reward:${court}:${verdict}:${c}`;
export const parsePayoutMemo = (m: string | null) => {
  const x = new RegExp(`^saring-(refund|reward):(${B58})(?::([A-Z]+))?(?::([0-9a-f]{64}))?$`).exec(m ?? "");
  return x ? { kind: x[1] as "refund" | "reward", court: x[2], verdict: x[3] ?? null, commitment: x[4] ?? null } : null;
};

/**
 * Who gets what, from public facts only: bonds (UFVK), seats and casts (Solana memos),
 * plus which voters were conflicted (only the operator knows; the verifier checks the
 * count against the on-chain `excluded`). Seated jurors who never cast are no-shows:
 * their bond is slashed and split equally into the counted jurors' rewards.
 */
export function payoutPolicy(bonds: { commitment: string; zat: number }[], seated: Set<string>, voted: Set<string>, conflicted: Set<string>) {
  const noShows = bonds.filter((b) => seated.has(b.commitment) && !voted.has(b.commitment));
  const counted = bonds.filter((b) => voted.has(b.commitment) && !conflicted.has(b.commitment));
  const slashed = noShows.reduce((s, b) => s + b.zat, 0);
  if (slashed > 0 && counted.length === 0) throw new Error("slashed bonds but no counted juror to redistribute to");
  const share = counted.length ? Math.floor(slashed / counted.length) : 0; // ponytail: dust (< counted zat) stays with the operator
  const pays: { kind: "refund" | "reward"; commitment: string; zat: number }[] = [];
  for (const b of bonds) if (!noShows.includes(b)) pays.push({ kind: "refund", commitment: b.commitment, zat: b.zat }); // voted, or bonded but never seated
  for (const b of counted) pays.push({ kind: "reward", commitment: b.commitment, zat: REWARD_ZAT + share });
  return { pays, noShows: noShows.map((b) => b.commitment), counted: counted.map((b) => b.commitment), slashed, share };
}

export const jurorsFile = path.join(HOME, "jurors.json");
export const readJurors = (): JurorRecord[] => (fs.existsSync(jurorsFile) ? JSON.parse(fs.readFileSync(jurorsFile, "utf8")) : []);

export function writeOut(name: string, data: unknown) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n");
}

if (require.main === module) {
  // ponytail: self-check of the pure parts (memo decoding, commitment, bond memo format).
  const assert = require("assert");
  const pad = new Uint8Array(512);
  pad.set(Buffer.from("saring-bond:x"));
  assert.equal(memoText(pad), "saring-bond:x");
  assert.equal(memoText(Uint8Array.from([0xf6, ...new Uint8Array(511)])), null);
  const court = "3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy";
  const c = commitment(7, "00ff", court);
  assert.equal(c, createHash("sha256").update(Buffer.concat([Buffer.from("07000000" + "00ff", "hex"), Buffer.from(court)])).digest("hex"));
  assert.notEqual(c, commitment(7, "00ff", "11111111111111111111111111111111"));
  assert.deepEqual(parseBondMemo(bondMemo(court, c, court)), { court, commitment: c, seatKey: court });
  assert.deepEqual(parseBondMemo(`saring-bond:${court}:${c}`), { court, commitment: c, seatKey: null });
  assert.equal(parseBondMemo("saring-bond:bad:00"), null);
  assert.deepEqual(parsePayoutMemo(rewardMemo(court, "NO", c)), { kind: "reward", court, verdict: "NO", commitment: c });
  assert.deepEqual(parsePayoutMemo(refundMemo(court, c)), { kind: "refund", court, verdict: null, commitment: c });
  assert.equal(parsePayoutMemo(`saring-refund:${court}`)!.commitment, null); // pre-v2 payouts
  // policy: 3 bonded+seated, #3 never cast -> slashed into #1/#2 rewards; #4 bonded, never seated -> refund
  const b = (n: number) => ({ commitment: String(n).repeat(64), zat: BOND_ZAT });
  const bs = [b(1), b(2), b(3), b(4)];
  const p = payoutPolicy(bs, new Set(bs.slice(0, 3).map((x) => x.commitment)), new Set(bs.slice(0, 2).map((x) => x.commitment)), new Set());
  assert.deepEqual(p.noShows, [b(3).commitment]);
  assert.equal(p.slashed, BOND_ZAT);
  const half = REWARD_ZAT + BOND_ZAT / 2;
  assert.deepEqual(p.pays.map((x) => `${x.kind}${x.commitment[0]}:${x.zat}`), [`refund1:${BOND_ZAT}`, `refund2:${BOND_ZAT}`, `refund4:${BOND_ZAT}`, `reward1:${half}`, `reward2:${half}`]);
  assert.throws(() => payoutPolicy(bs.slice(0, 1), new Set([b(1).commitment]), new Set(), new Set()));
  assert.equal(uaCommit(court, c, "utest1x").length, 64);
  console.log("zec.ts self-check ok");
}
