/**
 * Shared Zcash plumbing for the Saring scripts: drive zcash-devtool (librustzcash
 * light wallet, Orchard + Sapling, talks to a testnet lightwalletd) and read the
 * notes a wallet decrypted with its viewing key straight from its SQLite db.
 *
 * Wallet data (seeds encrypted to an age identity) lives in ~/.saring-zcash,
 * never in this repo. Nothing here prints a seed or a spending key.
 */
import { execFileSync } from "child_process";
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
        `SELECT t.txid, t.mined_height, o.output_pool, o.value, o.is_change, o.to_address, o.memo,
                o.from_account_uuid, o.to_account_uuid
         FROM v_tx_outputs o JOIN v_transactions t ON t.txid = o.txid -- ponytail: one account per wallet dir
         ORDER BY COALESCE(t.mined_height, 1e12), o.output_index`
      )
      .all() as any[];
    const pools: Record<number, string> = { 0: "transparent", 2: "sapling", 3: "orchard", 4: "ironwood" };
    return rows.map((r) => ({
      txid: Buffer.from(r.txid).reverse().toString("hex"),
      height: r.mined_height ?? null,
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
  /** Random salt the juror chose; commitment = sha256(jurorId_le32 || salt). */
  salt: string;
  /** Where the juror wants refunds and rewards. */
  ua: string;
}

export function commitment(jurorId: number, saltHex: string): string {
  const id = Buffer.alloc(4);
  id.writeUInt32LE(jurorId);
  return createHash("sha256").update(Buffer.concat([id, Buffer.from(saltHex, "hex")])).digest("hex");
}

export const newSalt = () => randomBytes(16).toString("hex");

export const bondMemo = (court: string, c: string) => `saring-bond:${court}:${c}`;
export const parseBondMemo = (m: string | null) => {
  const x = /^saring-bond:([1-9A-HJ-NP-Za-km-z]{32,44}):([0-9a-f]{64})$/.exec(m ?? "");
  return x ? { court: x[1], commitment: x[2] } : null;
};

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
  const c = commitment(7, "00ff");
  assert.equal(c, createHash("sha256").update(Buffer.from("07000000" + "00ff", "hex")).digest("hex"));
  const court = "3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy";
  assert.deepEqual(parseBondMemo(bondMemo(court, c)), { court, commitment: c });
  assert.equal(parseBondMemo("saring-bond:bad:00"), null);
  console.log("zec.ts self-check ok");
}
