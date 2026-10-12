/**
 * Panta adapter: turns a Saring verdict into Panta's own settlement instruction.
 *
 * Panta (`balr_market`, mainnet) settles a market with `resolve_event(yes_wins)` (or
 * `resolve_event_usdc` for USDC markets), signed by its `oracle` (relayer/admin; an
 * admin on the dispute path). `submit_oracle_result(yes_wins)` is the earlier step that
 * proposes an outcome and opens the dispute window; a Saring court answers a dispute,
 * so `resolve_event` is the default here.
 *
 * Everything is built from Panta's published IDL: instruction + arg encoding, PDAs
 * with seeds (market_config, creator_fee_vault_usdc, the vault ATA), fixed program
 * addresses. Two accounts have no seeds in the IDL (`vault` for SOL markets,
 * `vault_authority` for USDC markets, a per-market `TokenVault`), so they are read
 * from the market's own transaction history, decoded with the same IDL.
 *
 * We don't hold Panta's oracle key: the operator who does signs the returned instruction.
 */
import { BorshAccountsCoder, BorshInstructionCoder, Program, type Idl } from "@anchor-lang/core";
import { Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import pantaIdl from "./idl/balr_market.json";
import { verdictToYesWins, type Verdict } from "./venue";

export const PANTA_IDL = pantaIdl as Idl;
export const PANTA_PROGRAM_ID = new PublicKey(pantaIdl.address);
export type PantaSettlement = "resolve_event" | "submit_oracle_result";

const accounts = new BorshAccountsCoder(PANTA_IDL);
const ixCoder = new BorshInstructionCoder(PANTA_IDL);
const camel = (s: string) => s.replace(/_(\w)/g, (_, c) => c.toUpperCase());
const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, PANTA_PROGRAM_ID)[0];

export const pantaMarketConfig = () => pda([Buffer.from("market_config")]);
export const pantaReviewRequest = (event: PublicKey) => pda([Buffer.from("review_request"), event.toBuffer()]);

export async function readPantaEvent(connection: Connection, event: PublicKey) {
  const info = await connection.getAccountInfo(event, "confirmed");
  if (!info) throw new Error(`Panta market ${event.toBase58()} not found`);
  if (!info.owner.equals(PANTA_PROGRAM_ID)) throw new Error(`${event.toBase58()} is not a Panta account`);
  return accounts.decode("Event", info.data);
}

export async function readPantaConfig(connection: Connection) {
  const info = await connection.getAccountInfo(pantaMarketConfig(), "confirmed");
  if (!info) throw new Error("Panta MarketConfig not found");
  return accounts.decode("MarketConfig", info.data);
}

/**
 * Finds the market's seedless vault accounts by decoding its past Panta instructions
 * with the IDL. Returns whether it is a USDC market and the named accounts seen.
 */
export async function discoverPantaVaults(connection: Connection, event: PublicKey, scan = 50) {
  const sigs = await connection.getSignaturesForAddress(event, { limit: scan }, "confirmed");
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) continue;
    const msg = tx.transaction.message;
    const keys = [...msg.staticAccountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
    for (const ix of msg.compiledInstructions) {
      if (!keys[ix.programIdIndex].equals(PANTA_PROGRAM_ID)) continue;
      const d = ixCoder.decode(Buffer.from(ix.data));
      const def = d && PANTA_IDL.instructions.find((i) => i.name === d.name);
      if (!def) continue;
      const named = new Map(def.accounts.map((a, i) => [a.name, keys[ix.accountKeyIndexes[i]]] as const));
      if (!named.get("event")?.equals(event)) continue;
      if (named.has("vault_authority")) return { usdc: true, vaultAuthority: named.get("vault_authority")!, from: s.signature };
      if (named.has("vault")) return { usdc: false, vault: named.get("vault")!, from: s.signature };
    }
  }
  throw new Error(`No Panta instruction on ${event.toBase58()} in the last ${scan} transactions names its vault`);
}

export interface PantaSettleIx {
  instruction: TransactionInstruction;
  /** e.g. "resolve_event_usdc" */
  name: string;
  yesWins: boolean;
  /** Account metas by IDL name, for review before signing. */
  accounts: Record<string, string>;
  vaultSource: string;
}

/**
 * Builds Panta's settlement instruction from a Saring verdict (throws on a tie,
 * an incomplete verdict or an unresolved court). `oracle` must be a key Panta
 * accepts as its oracle; it signs and pays.
 */
export async function buildPantaSettleIx(
  connection: Connection,
  opts: { event: PublicKey; oracle: PublicKey; verdict: Verdict; instruction?: PantaSettlement }
): Promise<PantaSettleIx> {
  const yesWins = verdictToYesWins(opts.verdict);
  const vaults = await discoverPantaVaults(connection, opts.event);
  const name = (opts.instruction ?? "resolve_event") + (vaults.usdc ? "_usdc" : "");
  const program = new Program(PANTA_IDL, { connection } as any);
  const given: Record<string, PublicKey> = { oracle: opts.oracle, event: opts.event };
  if (vaults.usdc) {
    given.vaultAuthority = vaults.vaultAuthority!;
    given.usdcMint = (await readPantaConfig(connection)).usdc_mint;
  } else given.vault = vaults.vault!;
  const instruction = await (program.methods as any)[camel(name)](yesWins).accountsPartial(given).instruction();
  const def = PANTA_IDL.instructions.find((i) => i.name === name)!;
  return {
    instruction,
    name,
    yesWins,
    accounts: Object.fromEntries(def.accounts.map((a, i) => [a.name, instruction.keys[i].pubkey.toBase58()])),
    vaultSource: vaults.from,
  };
}

/**
 * Simulates the instruction on the venue's cluster without signatures
 * (sigVerify false, blockhash replaced). Nothing lands on chain.
 */
export async function simulatePantaIx(connection: Connection, ix: TransactionInstruction, feePayer: PublicKey) {
  const msg = new TransactionMessage({ payerKey: feePayer, recentBlockhash: PublicKey.default.toBase58(), instructions: [ix] }).compileToV0Message();
  const { value } = await connection.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  const errorCode = value.logs?.map((l) => l.match(/Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.+?)\.?$/)).find(Boolean);
  return {
    err: value.err,
    logs: value.logs ?? [],
    unitsConsumed: value.unitsConsumed,
    anchorError: errorCode ? { name: errorCode[1], code: Number(errorCode[2]), msg: errorCode[3] } : null,
  };
}
