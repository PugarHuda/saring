// Reads the pre-v3.2 courts and the fresh v3.2 court after the upgrade.
import { Connection, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder, Idl } from "@anchor-lang/core";
import { readCourtVerdict } from "../src/venue";
import appIdl from "../../app/src/idl/blindcourt.json";
const base = require("../../base/out/state.json");
const courts: Record<string, string> = {
  tempo_arbitrum: "24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb",
  zcash: "HRA5oPAf4HPqKUu4sj3FpWDzuhvSJPDRD2xajSgLh7FM",
  hyperliquid: "FoRHmrnMrhHieiCCW51GwuQHGpXzvbNzDbRR6inzPQBv",
  base: base.court,
  v3_2_fresh: "3W2eB4oTgGYhpyUq5NuoeHqFhmTbhGdcK2Tb1gfs81FR",
};
(async () => {
  const c = new Connection("https://api.devnet.solana.com", "confirmed");
  for (const [k, a] of Object.entries(courts)) {
    const info = (await c.getAccountInfo(new PublicKey(a)))!;
    const v = await readCourtVerdict(c, new PublicKey(a));
    const app = new BorshAccountsCoder(appIdl as Idl).decode("CourtAccount", Buffer.concat([info.data, Buffer.alloc(32)]));
    console.log(k, a, `len=${info.data.length} market=${v.court.market.length}`, `sdk: resolved=${v.resolved} yes=${v.yes} no=${v.no} excl=${v.excluded} inc=${v.incomplete}`,
      `app: yes=${app.yes} no=${app.no} excl=${app.excluded}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
