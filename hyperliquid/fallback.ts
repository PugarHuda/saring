/**
 * Permissionless fallback: Saring verdict -> SaringHyperCourt on HyperEVM testnet (chain 998) -> HyperCore action.
 * Needs no Hyperliquid grant and no 100 HYPE stake, only a few cents of faucet HYPE on 0x71Ea… (HyperEVM).
 *
 *   npx tsx hyperliquid/fallback.ts status   balances (HyperEVM + HyperCore) of our two addresses
 *   npx tsx hyperliquid/fallback.ts wait     poll every 60 s until 0x71Ea… holds NEED HYPE, then run
 *   npx tsx hyperliquid/fallback.ts run      every step below; idempotent, resumes from hyperevm/deployments/testnet.json
 *
 * 1. fund a separate disputer address on HyperEVM; it bridges a little HYPE to HyperCore (0x2222…2222) so its
 *    Core account exists (verified via spotClearinghouseState and the coreUserExists precompile)
 * 2. deploy SaringHyperCourt (relayer = 0x71Ea…, Wormhole core 0xBB73…00dd), open HIP-4 outcome 8659 -> court FoRH…
 * 3. the disputer posts a 0.01 HYPE bond claiming NO; the contract bridges it to ITS HyperCore account
 * 4. read court FoRH… on Solana devnet (sdk/src/venue.ts), sign the EIP-712 Verdict, settle on HyperEVM
 * 5. the contract spotSends the bond back on HyperCore via CoreWriter; confirmed via info spotClearinghouseState
 * 6. Wormhole path: settle demo outcome 0 from the guardian-signed VAA of court 24gQ… (no Saring key)
 *
 * Keys: ~/.saring-hl/key (owner + relayer), ~/.saring-hl/disputer (created 0600). Never printed.
 */
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseEther, formatEther, type Hex, type Address } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { hyperliquidEvmTestnet } from "viem/chains";
import bs58 from "bs58";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { info } from "./settle";

const RPC = process.env.HYPEREVM_RPC ?? "https://rpc.hyperliquid-testnet.xyz/evm";
const COURT = process.env.COURT ?? "FoRHmrnMrhHieiCCW51GwuQHGpXzvbNzDbRR6inzPQBv"; // resolved NO, 0-2, 1 excluded
const OUTCOME = 8659; // HIP-4 outcome the court judged (Lamine Yamal wins the Ballon d'Or 2026), standalone
const WH_OUTCOME = 0; // demo outcome bound to court 24gQ… so its recorded VAA can settle it
const WH_COURT = "24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb";
const WORMHOLE = "0xBB73cB66C26740F31d1FabDC6b7A46a038A300dd"; // Wormhole core on HyperEVM testnet (guardian set 0)
const EMITTER = "0x54c231cefc5bd0966f82594e4333d6211f9a1ab4740be61271fdcb2d5ceb6238"; // saring_wormhole PDA
const HYPE_TOKEN = 1105n, HYPE_PERP = 135; // testnet spotMeta / meta
const BOND = parseEther("0.01"), ACTIVATE = parseEther("0.001"), DISPUTER_FUND = parseEther("0.015");
export const NEED = parseEther("0.02");

const HERE = __dirname;
const STATE = path.join(HERE, "hyperevm", "deployments", "testnet.json");
const ART = path.join(HERE, "hyperevm", "out", "SaringHyperCourt.sol", "SaringHyperCourt.json");
const evmTx = (h: string) => `https://testnet.purrsec.com/tx/${h}`;
const coreAddr = (a: string) => `https://app.hyperliquid-testnet.xyz/explorer/address/${a}`;

function key(name: string, create = false): Hex {
  const f = path.join(os.homedir(), ".saring-hl", name);
  if (!fs.existsSync(f)) {
    if (!create) throw new Error(`no key at ${f}`);
    fs.writeFileSync(f, generatePrivateKey() + "\n", { mode: 0o600 });
  }
  return fs.readFileSync(f, "utf8").trim() as Hex;
}
const owner = privateKeyToAccount(key("key"));
const disputer = privateKeyToAccount(key("disputer", true));
const pub = createPublicClient({ chain: hyperliquidEvmTestnet, transport: http(RPC) });
const wallet = (account: typeof owner) => createWalletClient({ account, chain: hyperliquidEvmTestnet, transport: http(RPC) });

type State = Record<string, any>;
const load = (): State => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {});
function save(s: State) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n");
}
const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

async function coreHype(user: string): Promise<number> {
  const s = await info<{ balances: { coin: string; token: number; total: string }[] }>({ type: "spotClearinghouseState", user });
  return Number(s.balances.find((b) => b.token === Number(HYPE_TOKEN))?.total ?? 0);
}
async function until<T>(what: string, f: () => Promise<T | undefined | false>, ms = 120_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 3000))) {
    const v = await f();
    if (v) return v;
  }
  throw new Error(`timeout waiting for ${what}`);
}
async function send(s: State, label: string, account: typeof owner, req: any): Promise<string> {
  if (s.tx?.[label]) return s.tx[label];
  const hash = await wallet(account).sendTransaction(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted: ${evmTx(hash)}`);
  s.tx = { ...s.tx, [label]: hash };
  save(s);
  log(`${label}: ${evmTx(hash)}`);
  return hash;
}

async function status() {
  for (const [n, a] of [["owner/relayer", owner.address], ["disputer", disputer.address]] as const) {
    log(`${n} ${a}: HyperEVM ${formatEther(await pub.getBalance({ address: a }))} HYPE, HyperCore ${await coreHype(a)} HYPE`);
  }
  const s = load();
  if (s.court) log(`SaringHyperCourt ${s.court}: HyperCore ${await coreHype(s.court)} HYPE`);
}

async function run() {
  const { abi, bytecode } = JSON.parse(fs.readFileSync(ART, "utf8")); // `forge build` in hyperliquid/hyperevm first
  const s = load();
  const have = await pub.getBalance({ address: owner.address });
  if (!s.tx?.fundDisputer && have < NEED) throw new Error(`0x71Ea… holds ${formatEther(have)} HYPE on HyperEVM, need ${formatEther(NEED)}: claim from the faucet first`);

  // 1. disputer gets gas + bond, and an account on HyperCore (native HYPE -> 0x2222…2222 credits the sender)
  await send(s, "fundDisputer", owner, { to: disputer.address, value: DISPUTER_FUND });
  await send(s, "disputerToCore", disputer, { to: "0x2222222222222222222222222222222222222222", value: ACTIVATE });
  await until("disputer HYPE on HyperCore", async () => (await coreHype(disputer.address)) > 0);
  log(`HyperEVM -> HyperCore bridge verified: disputer holds ${await coreHype(disputer.address)} HYPE on Core`);

  // 2. deploy + bind outcomes
  if (!s.court) {
    const hash = await (wallet(owner) as any).deployContract({ abi, bytecode: bytecode.object, args: [owner.address, WORMHOLE, EMITTER, HYPE_TOKEN, HYPE_PERP] });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy failed ${evmTx(hash)}`);
    Object.assign(s, { court: r.contractAddress, chainId: 998, tx: { ...s.tx, deploy: hash } });
    save(s);
    log(`SaringHyperCourt deployed ${r.contractAddress}: ${evmTx(hash)}`);
  }
  const c = s.court as Address;
  const call = (fn: string, args: any[], account = owner, value?: bigint) =>
    send(s, fn + ":" + args[0], account, { to: c, data: encode(abi, fn, args), value });
  const read = (fn: string, args: any[] = []) => (pub as any).readContract({ address: c, abi, functionName: fn, args }) as Promise<any>;
  const courtHex = (b58: string) => ("0x" + Buffer.from(bs58.decode(b58)).toString("hex")) as Hex;
  log(`precompile reads via contract: coreUserExists(disputer)=${await read("coreUserExists", [disputer.address])}, l1Block=${await read("l1BlockNumber")}, HYPE oracle=${await read("hypeOraclePx")}`);
  await call("open", [OUTCOME, courtHex(COURT), false]);
  await call("open", [WH_OUTCOME, courtHex(WH_COURT), false]);

  // 3. bond -> contract's HyperCore account
  await call("dispute", [OUTCOME, false], disputer, BOND);
  await until("bond on the contract's HyperCore account", async () => (await coreHype(c)) >= 0.01);
  log(`contract HyperCore HYPE: info ${await coreHype(c)}, precompile ${await read("coreSpotBalance", [c, HYPE_TOKEN])} wei`);

  // 4. verdict from Solana devnet, EIP-712 by the relayer
  const { Connection } = await import("@solana/web3.js");
  const { readCourtVerdict } = await import("../sdk/src/venue");
  const conn = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
  const v = await readCourtVerdict(conn, COURT);
  if (!v.resolved) throw new Error(`court ${COURT} not resolved`);
  const verdict = { court: courtHex(COURT), yes: v.yes, no: v.no, excluded: v.excluded, incomplete: v.incomplete, resolvedSlot: BigInt(await conn.getSlot()) };
  log(`court ${COURT}: yes ${v.yes} no ${v.no} excluded ${v.excluded} incomplete ${v.incomplete} -> ${v.outcome}`);
  if (!s.tx?.["settle:" + OUTCOME]) {
    s.disputerCoreBefore = await coreHype(disputer.address);
    save(s);
    const sig = await owner.signTypedData({
      domain: { name: "SaringHyperCourt", version: "1", chainId: 998, verifyingContract: c },
      types: { Verdict: [
        { name: "court", type: "bytes32" }, { name: "yes", type: "uint8" }, { name: "no", type: "uint8" },
        { name: "excluded", type: "uint8" }, { name: "incomplete", type: "bool" }, { name: "resolvedSlot", type: "uint64" }] },
      primaryType: "Verdict", message: verdict,
    });
    const sv = Number("0x" + sig.slice(130, 132));
    await call("settle", [OUTCOME, verdict, sv, ("0x" + sig.slice(2, 66)) as Hex, ("0x" + sig.slice(66, 130)) as Hex]);
  }

  // 5. CoreWriter spotSend effect on HyperCore
  const before: number = s.disputerCoreBefore;
  const after = await until("bond back on the disputer's HyperCore account", async () => {
    const x = await coreHype(disputer.address);
    return x >= before + 0.01 - 1e-9 && x;
  });
  const m = await read("markets", [OUTCOME]);
  const frac = await read("settleFraction", [OUTCOME]);
  Object.assign(s, {
    verdict: { court: COURT, yes: v.yes, no: v.no, excluded: v.excluded, incomplete: v.incomplete, outcome: v.outcome },
    stamp: { l1Block: String(m[6]), hypeOraclePx: String(m[7]) },
    settleFraction: String(frac),
    keeperAction: { type: "outcomeDeploy", operation: { settleOutcome: { outcome: OUTCOME, settleFraction: frac === 10n ** 18n ? "1" : frac === 0n ? "0" : "0.5" } } },
    core: { disputerBefore: before, disputerAfter: after, disputer: coreAddr(disputer.address), contract: coreAddr(c) },
  });
  save(s);
  log(`HyperCore effect: disputer HYPE ${before} -> ${after} (${coreAddr(disputer.address)})`);
  log(`stamped HyperCore L1 block ${m[6]}, HYPE oracle ${m[7]}; settleFraction(${OUTCOME}) = ${frac} -> keeper action ${JSON.stringify(s.keeperAction)}`);

  // 6. Wormhole path, no Saring key
  const vaaFile = path.join(HERE, "..", "wormhole", "out", `vaa-${WH_COURT}.json`);
  if (fs.existsSync(vaaFile)) {
    await call("settleWithVaa", [WH_OUTCOME, JSON.parse(fs.readFileSync(vaaFile, "utf8")).vaa]);
    log(`Wormhole VAA path: outcome ${WH_OUTCOME} (court ${WH_COURT}) settleFraction ${await read("settleFraction", [WH_OUTCOME])}`);
  }
  log(`done; state in ${STATE}`);
}

const encode = (abi: any, functionName: string, args: any[]) => encodeFunctionData({ abi, functionName, args });

async function main() {
  const cmd = process.argv[2];
  if (cmd === "status") return status();
  if (cmd === "run") return run();
  if (cmd === "wait") {
    while ((await pub.getBalance({ address: owner.address })) < NEED && !load().tx?.fundDisputer) {
      log(`0x71Ea… HyperEVM balance ${formatEther(await pub.getBalance({ address: owner.address }))} HYPE < ${formatEther(NEED)}, waiting`);
      if (Date.now() > Date.parse("2026-10-13T06:30:00Z")) throw new Error("13 Oct 13:30 WIB reached, no HYPE arrived"); // 30 min before the deadline
      await new Promise((r) => setTimeout(r, 60_000));
    }
    return run();
  }
  throw new Error("usage: fallback.ts status | wait | run");
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
