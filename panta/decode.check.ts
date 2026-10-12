// Self-check for decodeLogs: a MarketDisputed event built byte-by-byte per Panta's IDL
// (no real dispute exists on mainnet yet, so the positive path is proven here).
import { Keypair } from "@solana/web3.js";
import * as assert from "assert";
import { decodeLogs, IDL } from "./disputes";
import { PANTA_PROGRAM } from "./panta";

const market = Keypair.generate().publicKey, disputer = Keypair.generate().publicKey;
const bond = Buffer.alloc(8);
bond.writeBigUInt64LE(250_000_000n);
const disc = Buffer.from(IDL.events.find((e: any) => e.name === "MarketDisputed").discriminator);
const data = Buffer.concat([disc, market.toBuffer(), disputer.toBuffer(), Buffer.from([1, 0]), bond]).toString("base64");
const P = PANTA_PROGRAM.toBase58();
const { ixs, events } = decodeLogs([
  `Program ${P} invoke [1]`,
  "Program log: Instruction: DisputeResolvedEvent",
  `Program data: ${data}`,
  `Program ${P} success`,
  `Program data: ${data}`, // outside Panta's frame: must be ignored
]);
assert.deepStrictEqual(ixs, ["DisputeResolvedEvent"]);
assert.strictEqual(events.length, 1);
assert.deepStrictEqual(events[0], {
  name: "MarketDisputed",
  data: { event: market.toBase58(), disputer: disputer.toBase58(), oracle_proposed_yes_wins: true, disputer_proposed_yes_wins: false, bond_lamports: "250000000" },
});
console.log("decodeLogs ok:", events[0].name, events[0].data.bond_lamports);
