/**
 * A juror posts a shielded bond to sit on a Saring court.
 *
 *   ts-node zcash/bond.ts <juror wallet> <court address> [--register-only]
 *
 * Registration (first run): the juror gets a Saring identity (a Solana keypair kept
 * in ~/.saring-zcash; jurorId = identityId(pubkey), same rule the court uses), a
 * random salt, and names its payout address (the Orchard receiver of its own UA).
 * The operator learns {jurorId, salt, address} privately.
 *
 * Per court the juror also makes a fresh "seat key" (a Solana keypair, unlinkable to
 * its identity). Bond: BOND_ZAT from the juror's own shielded wallet to the operator's
 * UA, memo "saring-bond:<court>:<commitment>:<seat key>" encrypted to the operator.
 * commitment = sha256(jurorId_le32 || salt || court). Because the juror wrote the memo,
 * only that seat key can later commit the payout address and cast for this commitment.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { identityId } from "../sdk/src/index";
import { BOND_ZAT, HOME, type JurorRecord, bondMemo, commitment, defaultUA, explorer, jurorsFile, newSalt, orchardReceiver, pay, readJurors, sync, taz, writeOut } from "./zec";

function keyFile(file: string): Keypair {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

/** The juror's per-court seat key (juror-held secret; the demo keeps it in ~/.saring-zcash). */
export const seatKey = (name: string, court: string) => keyFile(path.join(HOME, `${name}.seat-${court}.json`));

async function register(name: string): Promise<JurorRecord> {
  const jurors = readJurors();
  const have = jurors.find((j) => j.name === name);
  if (have) return have;
  const pub = keyFile(path.join(HOME, `${name}.solana.json`)).publicKey;
  const j: JurorRecord = { name, jurorId: await identityId(pub), salt: newSalt(), ua: orchardReceiver(defaultUA(name)) };
  fs.writeFileSync(jurorsFile, JSON.stringify([...jurors, j], null, 2), { mode: 0o600 });
  return j;
}

async function main() {
  const [name, court, flag] = process.argv.slice(2);
  if (!name || !court) throw new Error("usage: bond.ts <juror wallet> <court address> [--register-only]");
  new PublicKey(court); // must be a Solana address
  const j = await register(name);
  const c = commitment(j.jurorId, j.salt, court);
  if (flag === "--register-only") return console.log(`registered ${name}, commitment ${c}, no bond posted`);
  const seat = seatKey(name, court).publicKey.toBase58();
  const opUA = defaultUA("operator");
  sync(name);
  const txid = pay(name, [{ address: opUA, zat: BOND_ZAT, memo: bondMemo(court, c, seat) }]);
  const rec = { juror: name, court, commitment: c, seatKey: seat, bond: taz(BOND_ZAT), txid, explorer: explorer(txid), at: new Date().toISOString() };
  console.log(JSON.stringify(rec, null, 2));
  writeOut(`bond-${name}.json`, rec);
}

if (require.main === module)
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
