/** Shared bits for the Saring x Tempo scripts: keys (outside the repo), Tempo client, Solana devnet. */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { Account, createClient, http } from "viem/tempo";
import { tempoModerato } from "viem/chains";

export const PATH_USD = "0x20c0000000000000000000000000000000000000" as const;
export const ALPHA_USD = "0x20c0000000000000000000000000000000000001" as const;
export const EXPLORER = "https://explore.testnet.tempo.xyz";
export const txLink = (h: string) => `${EXPLORER}/tx/${h}`;
export const addrLink = (a: string) => `${EXPLORER}/address/${a}`;
export const OUT = path.join(__dirname, "out");

// ---------- keys: ~/.saring-tempo/keys.json (0600), never printed ----------
const KEY_DIR = path.join(os.homedir(), ".saring-tempo");
const KEY_FILE = path.join(KEY_DIR, "keys.json");
export type Role = "venue" | "operator" | "relayer" | "bettorA" | "bettorB";

export function key(role: Role): Hex {
  fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  const keys: Record<string, Hex> = fs.existsSync(KEY_FILE) ? JSON.parse(fs.readFileSync(KEY_FILE, "utf8")) : {};
  if (!keys[role]) {
    keys[role] = generatePrivateKey();
    fs.writeFileSync(KEY_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
  }
  return keys[role];
}

/** A Tempo client for `role`, paying gas in AlphaUSD (no native gas token on Tempo). */
export function tempoClient(role: Role) {
  return createClient({
    account: Account.fromSecp256k1(key(role)),
    chain: tempoModerato,
    feeToken: ALPHA_USD,
    transport: http("https://rpc.moderato.tempo.xyz"),
  });
}

/** Faucet-funds the account (programmatic testnet faucet) unless it already holds AlphaUSD. */
export async function ensureFunded(c: ReturnType<typeof tempoClient>, log: (s: string) => void) {
  const bal = (await c.token.getBalance({ token: ALPHA_USD, account: c.account.address })).amount;
  if (bal >= 10_000_000n) return log(`  ${c.account.address} already funded (${Number(bal) / 1e6} AlphaUSD)`);
  const receipts = await c.faucet.fundSync({ account: c.account.address });
  log(`  faucet funded ${c.account.address}: ${receipts.map((r) => r.transactionHash).join(", ")}`);
}

// ---------- Solana devnet ----------
export function solana(): Connection {
  const env = path.join(os.homedir(), "blindcourt", ".env.local");
  if (!process.env.RPC_URL && fs.existsSync(env)) process.loadEnvFile(env);
  return new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
}

/** 32-byte memo / market id = the raw Saring court pubkey. */
export const courtToBytes32 = (court: string): Hex => bytesToHex(new PublicKey(court).toBytes());
export const bytes32ToCourt = (b: Hex): string => new PublicKey(hexToBytes(b)).toBase58();

/** console.log + append to tempo/out/<name>.log */
export function logger(name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.log`);
  fs.appendFileSync(file, `\n=== ${new Date().toISOString()} ===\n`);
  return (s: string) => {
    console.log(s);
    fs.appendFileSync(file, s + "\n");
  };
}

/** Records named facts (tx hashes, addresses) across runs in tempo/out/state.json. */
export function state(): Record<string, any> {
  const f = path.join(OUT, "state.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
}
export function saveState(patch: Record<string, any>) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "state.json"), JSON.stringify({ ...state(), ...patch }, null, 2));
}
