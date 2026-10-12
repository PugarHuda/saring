/** Shared bits for Saring EVM adapters (identical copy of arbitrum/lib.ts): keys, clients, verdict relay. */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { bytesToHex, createPublicClient, createWalletClient, http, parseSignature, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readCourtVerdict } from "../sdk/src/venue";

// ---------- keys: ~/.saring-evm/keys.json (0600), never printed ----------
export type Role = "deployer" | "disputer" | "relayer";
const KEY_FILE = path.join(os.homedir(), ".saring-evm", "keys.json");
export function account(role: Role) {
  const keys: Record<string, Hex> = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
  if (!keys[role]) throw new Error(`no ${role} key in ${KEY_FILE}`);
  return privateKeyToAccount(keys[role]);
}

/** RPC_URL_EVM overrides the public RPC (e.g. an anvil fork for a dry run). */
export function clients(chain: Chain, role: Role) {
  const transport = http(process.env.RPC_URL_EVM ?? chain.rpcUrls.default.http[0]);
  return {
    pub: createPublicClient({ chain, transport }),
    wallet: createWalletClient({ chain, transport, account: account(role) }),
  };
}

/** Foundry artifact (abi + creation bytecode) from <dir>/contracts/out. */
export function artifact(dir: string, name: string) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, "contracts", "out", `${name}.sol`, `${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
}

// ---------- Solana devnet ----------
export function solana(): Connection {
  const env = path.join(os.homedir(), "blindcourt", ".env.local");
  if (!process.env.RPC_URL && fs.existsSync(env)) process.loadEnvFile(env);
  return new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
}
export const courtToBytes32 = (court: string): Hex => bytesToHex(new PublicKey(court).toBytes());

export const verdictTypes = {
  Verdict: [
    { name: "court", type: "bytes32" },
    { name: "yes", type: "uint8" },
    { name: "no", type: "uint8" },
    { name: "excluded", type: "uint8" },
    { name: "incomplete", type: "bool" },
    { name: "resolvedSlot", type: "uint64" },
  ],
} as const;

/** Reads a resolved Saring court on Solana devnet and signs the EIP-712 Verdict for `verifyingContract`. Refuses unresolved courts. */
export async function signCourtVerdict(court: string, domainName: string, chainId: number, verifyingContract: Address, log: (s: string) => void) {
  const sol = solana();
  const v = await readCourtVerdict(sol, court); // refuses accounts not owned by the Saring program
  if (!v.resolved) throw new Error(`court ${court} is not resolved yet; nothing to relay`);
  const resolvedSlot = BigInt(await sol.getSlot("confirmed"));
  log(`court ${court}: ${v.outcome} (yes ${v.yes}, no ${v.no}, excluded ${v.excluded}, incomplete ${v.incomplete}) observed at slot ${resolvedSlot}`);
  const message = { court: courtToBytes32(court), yes: v.yes, no: v.no, excluded: v.excluded, incomplete: v.incomplete, resolvedSlot };
  const domain = { name: domainName, version: "1", chainId, verifyingContract } as const;
  const signature = await account("relayer").signTypedData({ domain, types: verdictTypes, primaryType: "Verdict", message });
  const { r, s, yParity } = parseSignature(signature);
  return { message, sigV: (yParity ?? 0) + 27, r, s };
}

// ---------- logs / state in <dir>/out ----------
export function logger(dir: string, name: string) {
  const out = path.join(dir, "out");
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `${name}${process.env.RPC_URL_EVM ? ".fork" : ""}.log`);
  fs.appendFileSync(file, `\n=== ${new Date().toISOString()} ${process.env.RPC_URL_EVM ? "(fork " + process.env.RPC_URL_EVM + ")" : ""} ===\n`);
  return (s: string) => {
    console.log(s);
    fs.appendFileSync(file, s + "\n");
  };
}
/** Explorer link, or a plain "(fork)" hash on a local fork where the explorer has nothing. */
export const txLink = (explorer: string, h: string) => (process.env.RPC_URL_EVM ? `(fork) ${h}` : `${explorer}/tx/${h}`);

export function saveState(dir: string, patch: Record<string, any>) {
  const f = path.join(dir, "out", process.env.RPC_URL_EVM ? "state.fork.json" : "state.json");
  const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  fs.writeFileSync(f, JSON.stringify({ ...cur, ...patch }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}
