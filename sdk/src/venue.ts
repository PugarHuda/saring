/**
 * What a venue needs to consume a Saring verdict, with no Saring client and no wallet:
 * read the CourtAccount straight from chain, decode it with the program's IDL, and
 * turn it into a settlement outcome.
 */
import { BorshAccountsCoder, type IdlAccounts } from "@anchor-lang/core";
import { Connection, PublicKey } from "@solana/web3.js";
import idl from "./idl/blindcourt.json";
import type { Blindcourt } from "./idl/blindcourt";

export const SARING_PROGRAM_ID = new PublicKey(idl.address);
export type CourtAccount = IdlAccounts<Blindcourt>["courtAccount"];
export type Outcome = "YES" | "NO" | "TIE" | "INCOMPLETE";

export interface Verdict {
  resolved: boolean;
  yes: number;
  no: number;
  /** Ballots dropped inside MPC because the juror holds a position. */
  excluded: number;
  /** A slot overflowed, so the conflict check may be incomplete: settle as void/refund. */
  incomplete: boolean;
  /** null until the court is resolved. */
  outcome: Outcome | null;
}

/** Same rule as the program's own `claim`: incomplete or tie refunds, otherwise majority wins. */
export function toVerdict(c: Pick<CourtAccount, "resolved" | "yes" | "no" | "excluded" | "incomplete">): Verdict {
  const outcome: Outcome | null = !c.resolved
    ? null
    : c.incomplete
      ? "INCOMPLETE"
      : c.yes === c.no
        ? "TIE"
        : c.yes > c.no
          ? "YES"
          : "NO";
  return { resolved: c.resolved, yes: c.yes, no: c.no, excluded: c.excluded, incomplete: c.incomplete, outcome };
}

const coder = new BorshAccountsCoder(idl as any);

/** Decodes a CourtAccount from raw account data (checks the Anchor discriminator). */
export function decodeCourt(data: Buffer): CourtAccount {
  return coder.decode("CourtAccount", data);
}

/**
 * Reads a court's verdict directly from chain. Refuses accounts not owned by the
 * Saring program, so a look-alike account can't spoof a verdict.
 */
export async function readCourtVerdict(
  connection: Connection,
  courtAddress: PublicKey | string,
  programId: PublicKey = SARING_PROGRAM_ID
): Promise<Verdict & { court: CourtAccount }> {
  const addr = new PublicKey(courtAddress);
  const info = await connection.getAccountInfo(addr, "confirmed");
  if (!info) throw new Error(`Court ${addr.toBase58()} not found`);
  if (!info.owner.equals(programId))
    throw new Error(`Court ${addr.toBase58()} is owned by ${info.owner.toBase58()}, not the Saring program ${programId.toBase58()}`);
  const court = decodeCourt(info.data);
  return { ...toVerdict(court), court };
}

/** The `yes_wins` a venue settles with. Throws unless the court resolved to a clear majority. */
export function verdictToYesWins(v: Verdict): boolean {
  if (!v.resolved || v.outcome === null) throw new Error("Court is not resolved yet");
  if (v.outcome === "INCOMPLETE") throw new Error("Verdict is incomplete (conflict check overflowed): void the market instead");
  if (v.outcome === "TIE") throw new Error(`Verdict is a tie (${v.yes}-${v.no}): no majority to settle on`);
  return v.outcome === "YES";
}
