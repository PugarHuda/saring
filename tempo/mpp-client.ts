/**
 * A venue bot opens a Saring court by paying per request over MPP on Tempo Moderato.
 * mppx handles 402 -> sign TIP-20 payment -> retry automatically.
 *
 *   npx tsx mpp-client.ts "Did @debar win the NectarFi competition?"
 */
import { privateKeyToAccount } from "viem/accounts";
import { Receipt } from "mppx";
import { Mppx, tempo } from "mppx/client";
import { ensureFunded, key, logger, tempoClient, txLink } from "./lib";

const URL_ = process.env.COURTS_URL ?? "http://localhost:8787/courts";

async function main() {
  const log = logger("mpp-client");
  const question = process.argv[2] ?? "mpp demo: did the market resolve YES?";
  await ensureFunded(tempoClient("venue"), log);

  // First, show the raw challenge a payment-unaware client gets.
  const raw = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
  log(`unpaid request -> HTTP ${raw.status}; WWW-Authenticate: ${raw.headers.get("www-authenticate")?.slice(0, 160)}...`);

  const mppx = Mppx.create({ methods: [tempo({ account: privateKeyToAccount(key("venue")), expectedChainId: 42431 })], polyfill: false });
  const t0 = Date.now();
  const res = await mppx.fetch(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
  const body = await res.json();
  log(`paid request -> HTTP ${res.status} after ${((Date.now() - t0) / 1000).toFixed(0)}s: ${JSON.stringify(body)}`);
  if (!res.ok) process.exit(1);
  const receipt = Receipt.fromResponse(res);
  log(`Payment-Receipt: status=${receipt.status} method=${receipt.method} reference=${receipt.reference}`);
  if (/^0x[0-9a-f]{64}$/i.test(receipt.reference)) log(`  ${txLink(receipt.reference)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
