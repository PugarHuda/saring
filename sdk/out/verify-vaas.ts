// Live check of verifySaringVaa: every Saring VAA on Wormholescan must verify (guardian sigs,
// emitter, court tally), and a one-byte tamper of the payload or signature must be rejected.
//   npx ts-node --transpile-only -P sdk/tsconfig.json sdk/out/verify-vaas.ts
import { Connection } from "@solana/web3.js";
import { fetchSaringVaas, verifySaringVaa } from "../src/wormhole";

async function main() {
  const conn = new Connection(process.env.SOLANA_RPC ?? "https://api.devnet.solana.com", "confirmed");
  const vaas = await fetchSaringVaas();
  for (const { sequence, vaa } of vaas) {
    const v = await verifySaringVaa(conn, vaa);
    console.log(`seq ${sequence}: OK court ${v.court.toBase58()} ${v.yes}/${v.no}/${v.excluded} gs ${v.guardianSetIndex} sigs ${v.signatures}`);
  }
  const vaa = vaas[0].vaa;
  for (const [what, at] of [["payload byte", vaa.length - 9], ["signature byte", 10]] as const) {
    const bad = Uint8Array.from(vaa);
    bad[at] ^= 1;
    const err = await verifySaringVaa(conn, bad).then(() => null, (e) => e.message);
    if (!err) throw new Error(`tampered ${what} was accepted`);
    console.log(`tampered ${what}: rejected (${err})`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
