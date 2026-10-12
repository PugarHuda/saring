/**
 * Reads real Panta prediction-market positions from Solana mainnet.
 *
 * Panta (https://panta.market) stores each position as a `UserPosition` account
 * owned by its `balr_market` program (seeds ["position", market, owner], 202 bytes):
 * market @9, owner @41, yes_shares @74, no_shares @90, locked yes/no @170/@186.
 * Layout taken from Panta's on-chain IDL (research/38-panta-api.md).
 *
 * Blindcourt mirrors every holder of the disputed market into the encrypted court
 * state, so jurors who also traded that market are excluded inside MPC.
 */
import { Connection, PublicKey } from "@solana/web3.js";

export const PANTA_PROGRAM = new PublicKey("6gM5afTQBq5VZCfgpGqcsqzfWd5maLSCKWtGjbEobZMp");
/** Demo dispute market: the Panta market with the most holders on 2026-10-12. */
export const DEMO_MARKET = "3wdVRLDiMeuWRjGcFq2FZgAyCLhswTwNSKEHgNFRSZNB";

const POSITION_SIZE = 202;
const POSITION_DISC = "j9SjDYAWesU"; // base58 of the UserPosition discriminator
const QUESTION_OFFSET = 328; // Event.question (u32 length + utf8)

export interface Holder {
  owner: string;
  yes: bigint;
  no: bigint;
}

const u128 = (d: Uint8Array, o: number) => {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]);
  return v;
};

function decodePosition(d: Uint8Array): Holder & { market: string } {
  return {
    market: new PublicKey(d.subarray(9, 41)).toBase58(),
    owner: new PublicKey(d.subarray(41, 73)).toBase58(),
    yes: u128(d, 74) + u128(d, 170),
    no: u128(d, 90) + u128(d, 186),
  };
}

/**
 * Every wallet with a position account in `market`. A position account that exists
 * counts even if now empty: a trader who exited still had a stake in the outcome.
 */
export async function marketHolders(mainnet: Connection, market: string): Promise<Holder[]> {
  const accs = await mainnet.getProgramAccounts(PANTA_PROGRAM, {
    filters: [
      { dataSize: POSITION_SIZE },
      { memcmp: { offset: 0, bytes: POSITION_DISC } },
      { memcmp: { offset: 9, bytes: market } },
    ],
  });
  return accs.map(({ account }) => decodePosition(account.data));
}

/** Every Panta trader on mainnet, mapped to the markets they hold positions in. */
export async function allTraders(mainnet: Connection): Promise<Map<string, Set<string>>> {
  const accs = await mainnet.getProgramAccounts(PANTA_PROGRAM, {
    filters: [{ dataSize: POSITION_SIZE }, { memcmp: { offset: 0, bytes: POSITION_DISC } }],
  });
  const traders = new Map<string, Set<string>>();
  for (const { account } of accs) {
    const p = decodePosition(account.data);
    if (!traders.has(p.owner)) traders.set(p.owner, new Set());
    traders.get(p.owner)!.add(p.market);
  }
  return traders;
}

/** The market's question text, read from its on-chain Event account. */
export async function marketQuestion(mainnet: Connection, market: string): Promise<string> {
  const info = await mainnet.getAccountInfo(new PublicKey(market));
  if (!info) throw new Error(`Panta market ${market} not found on mainnet`);
  const d = info.data;
  const len = d.readUInt32LE(QUESTION_OFFSET);
  return new TextDecoder().decode(d.subarray(QUESTION_OFFSET + 4, QUESTION_OFFSET + 4 + len));
}

/** Exact single-wallet check: does `wallet` have a position account in `market`? */
export async function holdsPosition(mainnet: Connection, market: string, wallet: string) {
  const [pda] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("position"), new PublicKey(market).toBuffer(), new PublicKey(wallet).toBuffer()],
    PANTA_PROGRAM
  );
  return (await mainnet.getAccountInfo(pda)) !== null;
}

/**
 * Court identity for a wallet: first 4 bytes of SHA-256(pubkey), never 0.
 * The same function is used for jurors and traders, so a juror who traded collides
 * with their own position inside MPC and nowhere else.
 */
// ponytail: wallet-derived ids; one-person-one-id needs an identity attestation (SAS) on top.
export async function identityId(wallet: string): Promise<number> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new PublicKey(wallet).toBuffer()));
  const id = new DataView(h.buffer).getUint32(0, true);
  return id === 0 ? 1 : id;
}
