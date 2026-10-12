// Smoke check against mainnet: question, holder count, non-holder traders, identity ids.
import { Connection } from "@solana/web3.js";
import { DEMO_MARKET, marketHolders, marketQuestion, allTraders, holdsPosition, identityId } from "./panta";

(async () => {
  const mainnet = new Connection(process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
  console.log("question:", await marketQuestion(mainnet, DEMO_MARKET));
  const holders = await marketHolders(mainnet, DEMO_MARKET);
  console.log("holders:", holders.length, "non-zero:", holders.filter((h) => h.yes + h.no > 0n).length);
  const traders = await allTraders(mainnet);
  const outsiders = [...traders.keys()].filter((w) => !traders.get(w)!.has(DEMO_MARKET));
  console.log("panta traders:", traders.size, "not in this market:", outsiders.length);
  console.log("holdsPosition(holder0):", await holdsPosition(mainnet, DEMO_MARKET, holders[0].owner));
  console.log("holdsPosition(outsider0):", await holdsPosition(mainnet, DEMO_MARKET, outsiders[0]));
  const ids = await Promise.all(holders.map((h) => identityId(h.owner)));
  console.log("unique ids:", new Set(ids).size, "of", ids.length);
})();
