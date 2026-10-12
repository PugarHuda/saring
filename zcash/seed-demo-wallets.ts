/**
 * One-off demo setup: the testnet faucet paid juror1 (Valar faucet, 0.125 TAZ/IP/day),
 * so juror1 seeds the other demo wallets in one shielded transaction. In a real court
 * each juror funds their own wallet and the operator funds its own reward pool.
 */
import { ZAT, defaultUA, explorer, pay, sync, writeOut } from "./zec";

sync("juror1");
const outs = [
  { address: defaultUA("juror2"), zat: 0.02 * ZAT, memo: "saring demo: seed juror2" },
  { address: defaultUA("juror3"), zat: 0.02 * ZAT, memo: "saring demo: seed juror3" },
  { address: defaultUA("operator"), zat: 0.03 * ZAT, memo: "saring demo: seed operator reward pool" },
];
const txid = pay("juror1", outs);
const rec = { from: "juror1", outputs: outs.map((o) => ({ to: o.address, zat: o.zat, memo: o.memo })), txid, explorer: explorer(txid) };
writeOut("seed-demo-wallets.json", rec);
console.log(JSON.stringify(rec, null, 2));
