/**
 * A juror posts a shielded bond to sit on a Saring court.
 *
 *   ts-node zcash/bond.ts <juror wallet> <court address> [--register-only]
 *
 * Registration (first run): the juror gets a Saring identity (a Solana keypair kept
 * in ~/.saring-zcash; jurorId = identityId(pubkey), same rule the court uses) and a
 * random salt. The operator learns {jurorId, salt, UA} privately; the chain only ever
 * sees commitment = sha256(jurorId_le32 || salt).
 *
 * Bond: BOND_ZAT from the juror's own shielded wallet to the operator's Unified
 * Address, memo "saring-bond:<court>:<commitment>" encrypted to the operator.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { identityId } from "../sdk/src/index";
import { BOND_ZAT, HOME, type JurorRecord, bondMemo, commitment, defaultUA, explorer, jurorsFile, newSalt, pay, readJurors, sync, taz, writeOut } from "./zec";

async function register(name: string): Promise<JurorRecord> {
  const jurors = readJurors();
  const have = jurors.find((j) => j.name === name);
  if (have) return have;
  const kpFile = path.join(HOME, `${name}.solana.json`);
  if (!fs.existsSync(kpFile)) fs.writeFileSync(kpFile, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  const pub = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpFile, "utf8")))).publicKey;
  const j: JurorRecord = { name, jurorId: await identityId(pub), salt: newSalt(), ua: defaultUA(name) };
  fs.writeFileSync(jurorsFile, JSON.stringify([...jurors, j], null, 2), { mode: 0o600 });
  return j;
}

async function main() {
  const [name, court, flag] = process.argv.slice(2);
  if (!name || !court) throw new Error("usage: bond.ts <juror wallet> <court address> [--register-only]");
  new PublicKey(court); // must be a Solana address
  const j = await register(name);
  const c = commitment(j.jurorId, j.salt);
  if (flag === "--register-only") return console.log(`registered ${name}, commitment ${c}, no bond posted`);
  const opUA = defaultUA("operator");
  sync(name);
  const txid = pay(name, [{ address: opUA, zat: BOND_ZAT, memo: bondMemo(court, c) }]);
  const rec = { juror: name, court, commitment: c, bond: taz(BOND_ZAT), txid, explorer: explorer(txid), at: new Date().toISOString() };
  console.log(JSON.stringify(rec, null, 2));
  writeOut(`bond-${name}.json`, rec);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
