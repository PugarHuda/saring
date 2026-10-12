/**
 * Browser port of sdk/src/panta.ts: turns a Saring verdict into Panta's own settlement
 * instruction (`resolve_event`, or `resolve_event_usdc` for USDC markets) and simulates
 * it on Solana mainnet. Nothing is signed or sent: sigVerify is off and the blockhash
 * is replaced, so the run shows how far Panta's program gets with this exact instruction.
 *
 * Instruction, args and seeded PDAs come from Panta's IDL (src/idl/panta.json, trimmed
 * from research/38-panta-balr-market-idl.json). The IDL gives no seeds for `vault` /
 * `vault_authority`, so they are read from the market's own past Panta instructions.
 */
import { BorshAccountsCoder, BorshInstructionCoder, Program, type Idl } from "@anchor-lang/core";
import { Connection, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import pantaIdl from "./idl/panta.json";
import { MAINNET_RPC_URL, type Verdict } from "./court";

const IDL = pantaIdl as unknown as Idl;
export const PANTA_PROGRAM_ID = new PublicKey(pantaIdl.address);
const accountsCoder = new BorshAccountsCoder(IDL);
const ixCoder = new BorshInstructionCoder(IDL);
const camel = (s: string) => s.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());

/** Same rule as the court's `claim` and sdk `verdictToYesWins`: only a clear majority settles. */
export function verdictToYesWins(v: Verdict): { yesWins: boolean } | { refuse: string } {
  if (!v.resolved) return { refuse: "The court is not resolved yet." };
  if (v.incomplete) return { refuse: "The verdict is incomplete (the conflict check overflowed): Panta should void the market, not settle it." };
  if (v.yes === v.no) return { refuse: `The verdict is a tie (${v.yes}–${v.no}): there is no majority to settle on.` };
  return { yesWins: v.yes > v.no };
}

export interface SettleAccount {
  name: string;
  address: string;
  writable: boolean;
  signer: boolean;
  /** Where the address came from. */
  source: string;
}

export interface PantaSettle {
  instruction: TransactionInstruction;
  name: string;
  yesWins: boolean;
  dataHex: string;
  accounts: SettleAccount[];
  /** Pays the (simulated) fee: Panta's treasury, since the oracle key holds no mainnet SOL. */
  feePayer: PublicKey;
  vaultSource: string;
}

/** Finds the market's seedless vault by decoding its recent Panta instructions with the IDL. */
async function discoverVault(conn: Connection, event: PublicKey, scan = 15) {
  const sigs = await conn.getSignaturesForAddress(event, { limit: scan }, "confirmed");
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) continue;
    const msg = tx.transaction.message;
    const keys = [...msg.staticAccountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
    for (const ix of msg.compiledInstructions) {
      if (!keys[ix.programIdIndex].equals(PANTA_PROGRAM_ID)) continue;
      const d = ixCoder.decode(Buffer.from(ix.data));
      const def = d && IDL.instructions.find((i) => i.name === d.name);
      if (!def) continue;
      const named = new Map(def.accounts.map((a, i) => [a.name, keys[ix.accountKeyIndexes[i]]] as const));
      if (!named.get("event")?.equals(event)) continue;
      if (named.has("vault_authority")) return { usdc: true, vault: named.get("vault_authority")!, from: s.signature };
      if (named.has("vault")) return { usdc: false, vault: named.get("vault")!, from: s.signature };
    }
  }
  throw new Error(`None of this market's last ${scan} transactions names its vault, so the vault account can't be resolved.`);
}

/**
 * Builds Panta's settlement instruction for `market` from the verdict. `oracle` is the key
 * that would sign it: here the visitor's court authority, which Panta does not accept.
 */
export async function buildPantaSettle(market: string, yesWins: boolean, oracle: PublicKey): Promise<PantaSettle> {
  const conn = new Connection(MAINNET_RPC_URL, "confirmed");
  const event = new PublicKey(market);
  const configAddr = PublicKey.findProgramAddressSync([Buffer.from("market_config")], PANTA_PROGRAM_ID)[0];
  const [vault, configInfo] = await Promise.all([discoverVault(conn, event), conn.getAccountInfo(configAddr, "confirmed")]);
  if (!configInfo) throw new Error("Panta's MarketConfig account was not found on mainnet.");
  const config = accountsCoder.decode("MarketConfig", configInfo.data);
  const name = "resolve_event" + (vault.usdc ? "_usdc" : "");
  const given: Record<string, PublicKey> = { oracle, event, [vault.usdc ? "vaultAuthority" : "vault"]: vault.vault };
  if (vault.usdc) given.usdcMint = config.usdc_mint;
  const program = new Program(IDL, { connection: conn } as never);
  const instruction: TransactionInstruction = await (program.methods as any)[camel(name)](yesWins).accountsPartial(given).instruction();
  const def = IDL.instructions.find((i) => i.name === name)!;
  const source = (a: (typeof def.accounts)[number]): string => {
    if (a.name === "oracle") return "Signer: your court authority key (not Panta's oracle)";
    if (a.name === "event") return "The Panta market";
    if (a.name === "vault" || a.name === "vault_authority") return `No seeds in the IDL: read from tx ${vault.from.slice(0, 8)}…`;
    if (a.name === "usdc_mint") return "Read from Panta's MarketConfig";
    if ("address" in a && a.address) return "Fixed program address (IDL)";
    if ("pda" in a && a.pda) return "PDA derived from IDL seeds";
    return "";
  };
  return {
    instruction,
    name,
    yesWins,
    dataHex: Buffer.from(instruction.data).toString("hex"),
    accounts: def.accounts.map((a, i) => ({
      name: a.name,
      address: instruction.keys[i].pubkey.toBase58(),
      writable: instruction.keys[i].isWritable,
      signer: instruction.keys[i].isSigner,
      source: source(a as never),
    })),
    feePayer: config.treasury,
    vaultSource: vault.from,
  };
}

export interface SimResult {
  err: unknown;
  logs: string[];
  unitsConsumed: number | null;
  anchorError: { name: string; code: number; msg: string } | null;
}

/** simulateTransaction on mainnet with sigVerify off and the blockhash replaced. Nothing lands. */
export async function simulatePantaSettle(s: PantaSettle): Promise<SimResult> {
  const conn = new Connection(MAINNET_RPC_URL, "confirmed");
  const msg = new TransactionMessage({ payerKey: s.feePayer, recentBlockhash: PublicKey.default.toBase58(), instructions: [s.instruction] }).compileToV0Message();
  const { value } = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  const m = value.logs?.map((l) => l.match(/Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.+?)\.?$/)).find(Boolean);
  return {
    err: value.err,
    logs: value.logs ?? [],
    unitsConsumed: value.unitsConsumed ?? null,
    anchorError: m ? { name: m[1], code: Number(m[2]), msg: m[3] } : null,
  };
}
