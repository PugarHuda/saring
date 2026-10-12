/**
 * Live Panta metrics read through Solami's mainnet RPC (https://rpc.solami.dev/sol?api_key=KEY).
 *
 *   npx ts-node --transpile-only -P tsconfig.json panta/solami-stats.ts [window=24h]   (e.g. 90m, 24h, 7d)
 *
 * In the window: Panta transactions, positions created (the UserPosition PDA went from 0 to
 * rent lamports in that tx), position-changing trades, unique wallets, markets touched,
 * disputes (MarketDisputed) and dispute settlements. Right now: all UserPosition accounts,
 * holders, markets with holders, and open ReviewRequests. Writes panta/out/solami-stats.json.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import * as fs from "fs";
import * as path from "path";
import { decodeLogs, IDL } from "./disputes";
import { recentTxs } from "./sources";
import { PANTA_PROGRAM } from "./panta";

const key = process.env.SOLAMI_API_KEY;
if (!key) throw new Error("set SOLAMI_API_KEY (Solami dashboard -> API keys)");
const solami = new Connection(`https://rpc.solami.dev/sol?api_key=${key}`, "confirmed");
const disc = (name: string) => Buffer.from(IDL.accounts.find((a: any) => a.name === name).discriminator);
const TRADE_EVENTS: Record<string, string[]> = { SharesMinted: ["user"], SecondaryOrderPlaced: ["user"], OrderMatched: ["buyer", "seller"] };

function parseWindow(s: string): number {
  const m = s.match(/^(\d+)([mhd])$/);
  if (!m) throw new Error(`window like 90m, 24h, 7d; got ${s}`);
  return Number(m[1]) * { m: 60, h: 3600, d: 86400 }[m[2] as "m" | "h" | "d"];
}

async function main() {
  const windowArg = process.argv[2] ?? "24h";
  const since = Math.floor(Date.now() / 1000) - parseWindow(windowArg);

  // 1. every successful Panta tx in the window, decoded
  const created: { market: string; wallet: string; signature: string; time: string }[] = [];
  const wallets = new Set<string>(), markets = new Set<string>();
  const disputes: any[] = [], settlements: any[] = [];
  let trades = 0, txCount = 0;
  for await (const tx of recentTxs(solami, since)) {
    txCount++;
    const sig = tx.signature, time = new Date(tx.blockTime * 1000).toISOString();
    for (const e of decodeLogs(tx.logs).events) {
      if (e.name === "MarketDisputed") disputes.push({ signature: sig, time, ...e.data });
      if (e.name === "ResolutionDisputeSettled") settlements.push({ signature: sig, time, ...e.data });
      for (const f of TRADE_EVENTS[e.name] ?? []) {
        const market = e.data.event, wallet = e.data[f];
        trades++;
        wallets.add(wallet);
        markets.add(market);
        // created = the UserPosition PDA went from 0 lamports to rent in this tx
        const [pda] = PublicKey.findProgramAddressSync([Buffer.from("position"), new PublicKey(market).toBuffer(), new PublicKey(wallet).toBuffer()], PANTA_PROGRAM);
        const ix = tx.keys.indexOf(pda.toBase58());
        if (ix >= 0 && tx.preBalances[ix] === 0 && tx.postBalances[ix] > 0 && !created.some((c) => c.signature === sig && c.wallet === wallet))
          created.push({ market, wallet, signature: sig, time });
      }
    }
  }

  // 3. state right now (market @9 + owner @41 only, via dataSlice)
  const positions = await solami.getProgramAccounts(PANTA_PROGRAM, {
    dataSlice: { offset: 9, length: 64 },
    filters: [{ dataSize: 202 }, { memcmp: { offset: 0, bytes: bs58.encode(disc("UserPosition")) } }],
  });
  const reviews = await solami.getProgramAccounts(PANTA_PROGRAM, {
    dataSlice: { offset: 8, length: 32 },
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc("ReviewRequest")) } }],
  });
  const holders = new Set(positions.map((p) => new PublicKey(p.account.data.subarray(32, 64)).toBase58()));
  const heldMarkets = new Set(positions.map((p) => new PublicKey(p.account.data.subarray(0, 32)).toBase58()));

  const out = {
    via: "Solami RPC https://rpc.solami.dev/sol",
    at: new Date().toISOString(),
    window: { arg: windowArg, from: new Date(since * 1000).toISOString() },
    inWindow: {
      succeededPantaTxs: txCount,
      positionsCreated: created.length,
      positionTrades: trades,
      uniqueWallets: wallets.size,
      marketsTouched: markets.size,
      disputes: disputes.length,
      disputeSettlements: settlements.length,
    },
    now: {
      userPositionAccounts: positions.length,
      uniqueHolders: holders.size,
      marketsWithHolders: heldMarkets.size,
      openReviewRequests: reviews.map((r) => ({ address: r.pubkey.toBase58(), event: new PublicKey(r.account.data).toBase58() })),
    },
    positionsCreated: created,
    disputes,
    settlements,
  };
  fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "out", "solami-stats.json"), JSON.stringify(out, null, 2));
  console.log(`Panta via Solami, last ${windowArg} (since ${out.window.from}):`);
  console.log(out.inWindow);
  console.log("now:", { ...out.now, openReviewRequests: out.now.openReviewRequests.length });
  console.log("wrote panta/out/solami-stats.json");
}

main().catch((e) => {
  console.error(String(e?.message ?? e).split(key).join("<KEY>"));
  process.exit(1);
});
