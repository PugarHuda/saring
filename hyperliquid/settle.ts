/**
 * Saring verdict -> real HIP-4 settlement on Hyperliquid TESTNET.
 *
 *   npx tsx hyperliquid/settle.ts key        create ~/.saring-hl/key (0600) once, print the address only
 *   npx tsx hyperliquid/settle.ts status     balances, stake, deployer state of our address
 *   npx tsx hyperliquid/settle.ts dryrun [live]  sign all actions, recover signer; `live` posts them while unfunded
 *   npx tsx hyperliquid/settle.ts watch      poll until WATCH_UNTIL (12:30 WIB) for a sub-deployer grant or funds,
 *                                            then setup (funds only) -> deploy -> settle $COURT
 *   Paths: (a) another deployer grants us setSubDeployers [registerStandaloneOutcomeFromTemplate, settleOutcome]
 *          -> we deploy/settle in THEIR venue; (b) 100 HYPE staked -> activateOutcomeDeployer -> our venue "srng".
 *   npx tsx hyperliquid/settle.ts setup     spot USDC -> buy HYPE -> cDeposit -> activateOutcomeDeployer
 *   npx tsx hyperliquid/settle.ts deploy     register the standalone outcome (mirror of mainnet #391 / Yamal)
 *   npx tsx hyperliquid/settle.ts settle <court> [outcome]
 *        read the Saring court verdict on Solana devnet, submit settleOutcome, confirm via info API
 *
 * Signing: L1 actions = EIP-712 "Agent" phantom agent over keccak(msgpack(action) | nonce | vault flag),
 * source "b" on testnet (python SDK sign_l1_action); done by @nktkas/hyperliquid signL1Action.
 * User-signed actions (cDeposit) use HyperliquidSignTransaction domain, hyperliquidChain "Testnet".
 * TESTNET ONLY: every request goes to api.hyperliquid-testnet.xyz; the key never touches mainnet.
 */
import { signL1Action, signUserSignedAction } from "@nktkas/hyperliquid/signing";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const API = "https://api.hyperliquid-testnet.xyz";
const KEY = path.join(os.homedir(), ".saring-hl", "key");
const OUT = path.join(__dirname, "out");
export let VENUE = process.env.HL_VENUE ?? "srng"; // our own venue; replaced by the grantor's venue on the grant path
const OPS = ["registerStandaloneOutcomeFromTemplate", "settleOutcome"];

/** Which path is open for `addr`: own deployer (100 HYPE staked + activated), or a sub-deployer grant
 *  (`setSubDeployers` by another deployer, listed in outcomeMeta.deployers[].subDeployers). */
export function access(meta: any, addr: string): { mode: "own" | "grant"; venue: string; ops: string[] } | null {
  const me = addr.toLowerCase();
  const own = meta.deployers.find((d: any) => d.deployer.toLowerCase() === me);
  if (own) return { mode: "own", venue: own.venue, ops: OPS };
  for (const d of meta.deployers) {
    const ops = (d.subDeployers ?? []).filter(([, l]: [string, string[]]) => l.some((a) => a.toLowerCase() === me)).map(([op]: [string]) => op);
    if (ops.length) return { mode: "grant", venue: d.venue, ops };
  }
  return null;
}

async function useAccess(need: string) {
  const a = access(await info({ type: "outcomeMeta" }), wallet().address);
  if (!a) throw new Error(`${wallet().address} is neither a deployer nor a sub-deployer; run setup (100 HYPE) or get a setSubDeployers grant`);
  if (!a.ops.includes(need)) throw new Error(`grant on venue ${a.venue} covers ${a.ops.join(",")}, not ${need}`);
  VENUE = a.venue;
  console.log(`path: ${a.mode} on venue ${VENUE}`);
  return a;
}

export async function info<T = any>(body: object): Promise<T> {
  const r = await fetch(`${API}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`info ${JSON.stringify(body)}: HTTP ${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

function loadKey(create = false): `0x${string}` {
  if (!fs.existsSync(KEY)) {
    if (!create) throw new Error(`no key at ${KEY}; run: settle.ts key`);
    fs.mkdirSync(path.dirname(KEY), { recursive: true, mode: 0o700 });
    fs.writeFileSync(KEY, generatePrivateKey() + "\n", { mode: 0o600 });
  }
  return fs.readFileSync(KEY, "utf8").trim() as `0x${string}`;
}
const wallet = () => privateKeyToAccount(loadKey());

async function post(action: Record<string, unknown>, signature: unknown, nonce: number) {
  const r = await fetch(`${API}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, nonce, signature }) });
  const t = await r.text();
  let j: any;
  try { j = JSON.parse(t); } catch { throw new Error(`exchange HTTP ${r.status}: ${t}`); }
  return j;
}

/** L1 action (outcomeDeploy, activateOutcomeDeployer, order, ...). Key order matters for the hash. */
export async function l1(action: Record<string, unknown>) {
  const nonce = Date.now();
  const signature = await signL1Action({ wallet: wallet(), action, nonce, isTestnet: true });
  return post(action, signature, nonce);
}

/** User-signed action (EIP-712 HyperliquidTransaction:<Primary>). */
export async function userSigned(primary: string, fields: [string, string, unknown][]) {
  const nonce = Date.now();
  const action: Record<string, unknown> = { type: primary[0].toLowerCase() + primary.slice(1), signatureChainId: "0x66eee", hyperliquidChain: "Testnet" };
  const types = [{ name: "hyperliquidChain", type: "string" }];
  for (const [name, type, value] of fields) { action[name] = value; types.push({ name, type }); }
  action.nonce = nonce; types.push({ name: "nonce", type: "uint64" });
  const signature = await signUserSignedAction({ wallet: wallet(), action: action as any, types: { [`HyperliquidTransaction:${primary}`]: types } });
  return post(action, signature, nonce);
}

export async function status(addr: string) {
  const [spot, perp, stake, abstraction, meta] = await Promise.all([
    info<{ balances: { coin: string; total: string }[] }>({ type: "spotClearinghouseState", user: addr }),
    info<any>({ type: "clearinghouseState", user: addr }),
    info<any>({ type: "delegatorSummary", user: addr }),
    info<any>({ type: "userAbstraction", user: addr }).catch((e) => String(e.message ?? e)),
    info<any>({ type: "outcomeMeta" }),
  ]);
  const bal = (c: string) => Number(spot.balances.find((b) => b.coin === c)?.total ?? 0);
  return {
    address: addr, usdcSpot: bal("USDC"), hypeSpot: bal("HYPE"), usdcPerp: Number(perp.withdrawable ?? 0),
    staked: Number(stake.delegated) + Number(stake.undelegated), stake, abstraction,
    deployer: meta.deployers.find((d: any) => d.deployer.toLowerCase() === addr.toLowerCase()) ?? null,
  };
}

const STAKE = 100; // HYPE: min staking balance of every testnet outcome deployer (outcomeMeta + delegatorSummary, 2026-10-12)
const HYPE_USDC = 1035; // spot pair @1035, asset id 10000 + index
const sig5 = (x: number) => String(Number(x.toPrecision(5))); // price: <=5 significant figures

function must(r: any, what: string) {
  if (r?.status !== "ok") throw new Error(`${what}: ${JSON.stringify(r)}`);
  console.log(`${what}: ok ${JSON.stringify(r.response?.data ?? r.response ?? "")}`);
  return r;
}

async function setup() {
  const me = wallet().address;
  let s = await status(me);
  console.log(JSON.stringify({ usdcSpot: s.usdcSpot, usdcPerp: s.usdcPerp, hypeSpot: s.hypeSpot, staked: s.staked, abstraction: s.abstraction }));
  if (s.usdcPerp > 1) must(await userSigned("UsdClassTransfer", [["amount", "string", String(Math.floor(s.usdcPerp * 100) / 100)], ["toPerp", "bool", false]]), "perp->spot USDC");
  s = await status(me);
  const need = STAKE + 0.05 - s.staked - s.hypeSpot;
  if (need > 0) {
    const sz = Math.ceil((need + 0.15) * 100) / 100; // + fee buffer (spot buy fee is taken in HYPE)
    const book = await info<{ levels: { px: string; sz: string }[][] }>({ type: "l2Book", coin: `@${HYPE_USDC}` });
    let cum = 0, worst = 0;
    for (const l of book.levels[1]) { cum += Number(l.sz); worst = Number(l.px); if (cum >= sz) break; }
    if (cum < sz) throw new Error(`only ${cum} HYPE on the ask side, need ${sz}`);
    const px = sig5(worst * 1.01);
    if (sz * Number(px) > s.usdcSpot) throw new Error(`need ~${(sz * Number(px)).toFixed(0)} USDC for ${sz} HYPE at <=${px}, have ${s.usdcSpot} spot USDC`);
    must(await l1({ type: "order", orders: [{ a: 10000 + HYPE_USDC, b: true, p: px, s: String(sz), r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" }), `buy ${sz} HYPE <=${px}`);
    s = await status(me);
  }
  const deposit = Math.min(s.hypeSpot, Math.max(0, STAKE + 0.01 - s.staked));
  if (deposit > 0) must(await userSigned("CDeposit", [["wei", "uint64", Math.floor(deposit * 1e8)]]), `cDeposit ${deposit} HYPE`);
  s = await status(me);
  console.log(`staked ${s.staked} HYPE`);
  if (s.deployer) return console.log(`already deployer: ${JSON.stringify(s.deployer)}`);
  must(await l1({ type: "activateOutcomeDeployer", activate: { venueName: VENUE } }), `activateOutcomeDeployer ${VENUE}`);
}

// Testnet mirror of mainnet #391 outcome 8659 (Lamine Yamal), as a STANDALONE outcome so a tie/incomplete
// verdict can settle to "0.5" (question outcomes may only settle to 0/1).
export const TEMPLATE = {
  id: "awardEntryWins",
  keywordToValue: [ // lexicographically sorted (docs: sort all tuple lists before signing)
    ["award", "Ballon d'Or"],
    ["awardingBody", "France Football"],
    ["displayName", "Lamine Yamal"],
    ["entry", "Lamine Yamal (FC Barcelona, Spain)"],
    ["field", "football"],
    ["period", "2026"],
    ["resolutionDeadline", "20261105-2359"],
  ],
  deployerFeeScale: "0",
};
const DESCRIPTION = TEMPLATE.keywordToValue.map(([k, v]) => `${k}:${v}`).join("|");

const ours = async () => {
  const m = await info<any>({ type: "outcomeMeta" });
  return (m.outcomes as any[]).filter((o) => o.venue === VENUE);
};

async function deploy() {
  console.assert(JSON.stringify([...TEMPLATE.keywordToValue].sort()) === JSON.stringify(TEMPLATE.keywordToValue), "keywords sorted");
  await useAccess("registerStandaloneOutcomeFromTemplate");
  const existing = (await ours()).find((o) => o.description === DESCRIPTION);
  if (existing) return console.log(`already deployed: ${JSON.stringify(existing)}`);
  must(await l1({ type: "outcomeDeploy", venue: VENUE, operation: { registerStandaloneOutcomeFromTemplate: TEMPLATE } }), "registerStandaloneOutcomeFromTemplate");
  const o = (await ours()).find((x) => x.description === DESCRIPTION);
  console.log(`outcome: ${JSON.stringify(o)}`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "testnet-outcome.json"), JSON.stringify({ at: new Date().toISOString(), deployer: wallet().address, venue: VENUE, outcome: o }, null, 2) + "\n");
}

async function settle(court: string, outcomeArg?: string) {
  const { Connection } = await import("@solana/web3.js");
  const { readCourtVerdict } = await import("../sdk/src/venue");
  const { settleFraction } = await import("./court");
  const conn = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
  const v = await readCourtVerdict(conn, court);
  if (!v.resolved) throw new Error(`court ${court} not resolved; refusing to settle`);
  await useAccess("settleOutcome");
  const mine = await ours();
  const o = outcomeArg ? mine.find((x) => x.outcome === Number(outcomeArg)) : mine.find((x) => x.description === DESCRIPTION);
  if (!o) throw new Error(`outcome not found in venue ${VENUE}`);
  const frac = settleFraction(v, false)!; // standalone: tie/incomplete -> "0.5"
  console.log(`court ${court}: yes ${v.yes} no ${v.no} excluded ${v.excluded} incomplete ${v.incomplete} -> ${v.outcome} -> settleFraction ${frac}`);
  const action = settleAction(o, frac);
  must(await l1(action), `settleOutcome ${o.outcome}`);
  const settled = await info<any>({ type: "settledOutcome", outcome: o.outcome });
  console.log(`settledOutcome: ${JSON.stringify(settled)}`);
  const txs = (await fetch("https://rpc.hyperliquid-testnet.xyz/explorer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "userDetails", user: wallet().address }) }).then((r) => r.json()).catch(() => ({ txs: [] }))).txs ?? [];
  fs.writeFileSync(path.join(OUT, `testnet-settle-${o.outcome}.json`), JSON.stringify({
    at: new Date().toISOString(), deployer: wallet().address, venue: VENUE, court,
    verdict: { yes: v.yes, no: v.no, excluded: v.excluded, incomplete: v.incomplete, outcome: v.outcome },
    action, settled,
    txs: txs.map((t: any) => ({ time: t.time, type: t.action?.type, op: Object.keys(t.action?.operation ?? {})[0], hash: t.hash, error: t.error, link: `https://app.hyperliquid-testnet.xyz/explorer/tx/${t.hash}` })),
  }, null, 2) + "\n");
}

const settleAction = (o: any, frac: string) => ({
  type: "outcomeDeploy",
  venue: VENUE,
  operation: { settleOutcome: { outcome: o.outcome, settleFraction: frac, details: "", nameAndDescription: [o.name, o.description], sideNames: o.sideSpecs.map((s: any) => s.name) } },
});

/** Sign every action we will send, recover the signer from the EIP-712 Agent payload, and (with `live`)
 *  post them to testnet /exchange: while 0x71Ea… has no testnet account nothing can execute, and the
 *  "User or API Wallet <addr> does not exist" error echoes the address the node recovered from our
 *  msgpack+signature, i.e. it proves the action encoding byte-for-byte. */
async function dryrun(live: boolean) {
  const { createL1ActionHash } = await import("@nktkas/hyperliquid/signing");
  const { recoverTypedDataAddress } = await import("viem");
  const me = wallet().address;
  const s = await status(me);
  if (live && (s.usdcSpot || s.usdcPerp || s.hypeSpot || s.staked)) throw new Error("account is funded; live dry-run could execute, refusing");
  const sample = { outcome: 0, name: "Recurring", description: DESCRIPTION, sideSpecs: [{ name: "Yes" }, { name: "No" }] };
  const actions: Record<string, Record<string, unknown>> = {
    activateOutcomeDeployer: { type: "activateOutcomeDeployer", activate: { venueName: VENUE } },
    registerStandaloneOutcomeFromTemplate: { type: "outcomeDeploy", venue: VENUE, operation: { registerStandaloneOutcomeFromTemplate: TEMPLATE } },
    settleOutcome: settleAction(sample, "0"),
  };
  for (const [name, action] of Object.entries(actions)) {
    const nonce = Date.now();
    const sig = await signL1Action({ wallet: wallet(), action, nonce, isTestnet: true });
    const connectionId = createL1ActionHash({ action, nonce });
    const signer = await recoverTypedDataAddress({
      domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
      types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
      primaryType: "Agent", message: { source: "b", connectionId }, signature: sig as any,
    });
    console.assert(signer === me, `${name}: recovered ${signer} != ${me}`);
    const node = live ? JSON.stringify(await post(action, sig, nonce)) : "-";
    console.log(`${name}: connectionId ${connectionId} recovered ${signer} ${signer === me ? "OK" : "MISMATCH"} | node: ${node}`);
  }
}

const COURT = process.env.COURT ?? "FoRHmrnMrhHieiCCW51GwuQHGpXzvbNzDbRR6inzPQBv";
const UNTIL = Date.parse(process.env.WATCH_UNTIL ?? "2026-10-13T05:30:00Z"); // 12:30 WIB
const MIN_USDC = 3500; // buys ~100.5 HYPE on @1035 (README)

/** Poll until a grant or funds land, then run the open path once. */
async function watch() {
  const me = wallet().address;
  for (;;) {
    const [meta, s] = await Promise.all([info<any>({ type: "outcomeMeta" }), status(me)]).catch((e) => [null, String(e)] as any);
    const a = meta && access(meta, me);
    console.log(`${new Date().toISOString()} access=${JSON.stringify(a)} usdc=${s?.usdcSpot}+${s?.usdcPerp} hype=${s?.hypeSpot} staked=${s?.staked}`);
    try { // deploy/settle are idempotent per outcome, so a failed tick just retries on the next one
      if (meta && !a && (s.staked >= STAKE || s.hypeSpot + s.staked >= STAKE + 0.05 || s.usdcSpot + s.usdcPerp >= MIN_USDC)) await setup();
      if (meta && (a || access(await info({ type: "outcomeMeta" }), me))) { await deploy(); return await settle(COURT); }
    } catch (e: any) { console.log(`tick failed: ${e.message ?? e}`); }
    if (Date.now() > UNTIL) return console.log("deadline reached, nothing landed");
    await new Promise((r) => setTimeout(r, 5 * 60_000));
  }
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "dryrun") return dryrun(a === "live");
  if (cmd === "watch") return watch();
  if (cmd === "key") return console.log(privateKeyToAccount(loadKey(true)).address);
  const me = wallet().address;
  if (cmd === "status") return console.log(JSON.stringify(await status(me), null, 2));
  if (cmd === "setup") return setup();
  if (cmd === "deploy") return deploy();
  if (cmd === "settle" && a) return settle(a, b);
  throw new Error("usage: settle.ts key | status | dryrun [live] | watch | setup | deploy | settle <court> [outcome]");
}

if (require.main === module) main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
