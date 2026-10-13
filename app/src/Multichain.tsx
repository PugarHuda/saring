// Multichain: one card per chain Saring touches, each filled by a live read when the section opens.
// EVM chains and Hyperliquid are read straight from the browser (their RPCs allow CORS); Zcash goes
// through /api/chains because ZecBlock's API doesn't. Solana devnet goes through the existing /api/rpc.
import { useCallback, useEffect, useRef, useState, type AnchorHTMLAttributes, type ReactNode } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder, type Idl } from "@anchor-lang/core";
import idl from "./idl/blindcourt.json";
import { RPC_URL, explorerTx } from "./court";
import fixture from "../../ethereum/conflict-registry/data/fixture.json";

const Ext = (p: AnchorHTMLAttributes<HTMLAnchorElement>) => <a target="_blank" rel="noreferrer" {...p} />;
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// ---------- JSON-RPC ----------

async function rpc<T>(urls: string[], method: string, params: unknown[]): Promise<T> {
  let last: unknown;
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message ?? "RPC error");
      return j.result as T;
    } catch (e) {
      last = e; // next RPC
    }
  }
  throw last instanceof Error ? last : new Error("RPC unreachable");
}
const pad = (h: string) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
/** eth_call; returns the 32-byte words of the result. */
async function call(urls: string[], to: string, data: string): Promise<bigint[]> {
  const hex = (await rpc<string>(urls, "eth_call", [{ to, data }, "latest"])).slice(2);
  return Array.from({ length: hex.length / 64 }, (_, i) => BigInt("0x" + hex.slice(i * 64, i * 64 + 64)));
}
const block = async (urls: string[]) => Number(BigInt(await rpc<string>(urls, "eth_blockNumber", [])));
const hex32 = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
const b58 = (n: bigint) => new PublicKey(Uint8Array.from(Buffer.from(n.toString(16).padStart(64, "0"), "hex"))).toBase58();

// Function selectors (keccak256 of the signature, first 4 bytes).
const SEL = {
  markets: "0x7564912b", // markets(bytes32)
  getCurrentRoundId: "0x5727e25d",
  getVotePhase: "0x74dd278c",
  getNumberOfPriceRequests: "0xef994010",
  isConflicted: "0xedc5b3b8", // isConflicted(bytes32,address,bytes32[])
  leafCount: "0x30e69fc3",
  courtOf: "0x8e3246cc", // courtOf(bytes32)
  getAssertionResult: "0xe39dfd7f",
  getAssertionPolicy: "0xa6b011a7",
  ruled: "0x2a7ff9c1",
  isFinalized: "0x7f8d429e",
  resultFor: "0xd09cc57e",
  currentRuling: "0x1c3db16d", // currentRuling(uint256), Kleros IArbitratorV2
};
const courtHex = (c: string) => "0x" + Buffer.from(new PublicKey(c).toBytes()).toString("hex");

// The Solana devnet court the Tempo market, Arbitrum EM and Base arbitrator were all settled on (resolved NO).
const COURT_24G = "24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb";
const COURT_24G_HEX = courtHex(COURT_24G);

// ---------- Wormhole VAA proof ----------
// The saring_wormhole program (devnet DdNYVoQV…WdPq) read COURT_24G on-chain and posted its verdict as a Wormhole
// message; every adapter below was settled by delivering that one guardian-signed VAA.
const SOL_EMITTER_TX = "5WtYWwEuDrMmkyaQt7hfX8bdcGrqom19AbLUXnGMX43kHjcoVRTqAzXeXj3vheF2vFg9SPgvySj9H7aQJRiREy7Z";
const EMITTER = "54c231cefc5bd0966f82594e4333d6211f9a1ab4740be61271fdcb2d5ceb6238"; // PDA ["emitter"]
const VAA_SEL = { resolveWithVaa: "0xb0559194", ruleWithVaa: "0x8bffc0fb", settleWithVaa: "0x34ac5905", wormhole: "0x84acd1bb", saringEmitter: "0x31038d8d" };
interface EvmTx { to?: string; input?: string; calls?: { to: string; input: string }[] }
interface Vaa {
  solanaTx: string; guardianSet: number; signatures: number; emitterChain: number; emitterAddress: string; sequence: number; vaaHex: string;
  verdict: { court: string; yes: number; no: number; excluded: number; incomplete: boolean };
}
/** The VAA as Wormholescan holds it, decoded by /api/chains (Wormholescan sends no CORS headers). */
async function chainsApi() {
  const r = await fetch("/api/chains", { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`/api/chains ${r.status}`);
  return (await r.json()) as { at: number; zcash: Record<"payout" | "bond1" | "bond2" | "bond3", ZecTx> | null; zcashError?: string; wormhole: Vaa | null; wormholeError?: string };
}

/** Reads the contract's Wormhole core + emitter and the settling tx itself; "verified" only if every check holds. */
async function vaaProof(urls: string[], contract: string, core: string, txHash: string, sel: string): Promise<Row[]> {
  const [[wh], [em], tx, rc, api] = await Promise.all([
    call(urls, contract, VAA_SEL.wormhole),
    call(urls, contract, VAA_SEL.saringEmitter),
    rpc<EvmTx>(urls, "eth_getTransactionByHash", [txHash]),
    rpc<{ status: string }>(urls, "eth_getTransactionReceipt", [txHash]),
    chainsApi().then((j) => j.wormhole ?? j.wormholeError ?? "unavailable", (e) => String(e?.message ?? e)),
  ]);
  // Tempo batches calls (type 0x76); other chains carry a single to/input.
  const c = (tx.calls ?? [{ to: tx.to ?? "", input: tx.input ?? "" }]).find((x) => x.to?.toLowerCase() === contract.toLowerCase());
  const checks = {
    core: hex32(wh).endsWith(core.slice(2).toLowerCase()),
    emitter: hex32(em).slice(2) === EMITTER,
    call: !!c?.input.startsWith(sel),
    vaa: !!c?.input.includes(EMITTER), // the VAA body names the emitter
    ok: rc?.status === "0x1",
  };
  const pass = Object.values(checks).every(Boolean);
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(", ");
  const w = typeof api === "string" ? null : api;
  const same = w && !!c?.input.includes(w.vaaHex) && w.emitterChain === 1 && w.emitterAddress === EMITTER && w.verdict.court === COURT_24G_HEX.slice(2);
  return [
    ["Verdict delivery", pass
      ? <><strong className="ok">verified via Wormhole VAA</strong> <span className="muted">(tx calls {Object.entries(VAA_SEL).find(([, s]) => s === sel)?.[0]}, succeeded)</span></>
      : <strong className="bad">check failed: {failed}</strong>],
    ["Wormhole core / emitter", <><code>{short("0x" + hex32(wh).slice(26))}</code> · <code>0x{EMITTER.slice(0, 8)}…</code> <span className="muted">(read from contract)</span></>],
    ["Same bytes as Wormholescan VAA", w
      ? <><strong className={same ? "ok" : "bad"}>{same ? "yes" : "no"}</strong> <span className="muted">(guardian set {w.guardianSet}, {w.signatures} signature{w.signatures === 1 ? "" : "s"}, seq {w.sequence}; payload yes {w.verdict.yes} · no {w.verdict.no} · excluded {w.verdict.excluded})</span></>
      : <span className="muted">Wormholescan unreachable ({String(api)})</span>],
    ["Solana emitter tx", <Ext href={explorerTx(SOL_EMITTER_TX)}>{short(SOL_EMITTER_TX)}</Ext>],
  ];
}

// ---------- card shell ----------

type Row = [string, ReactNode];
interface Read { rows: Row[]; at: string; extra?: ReactNode }
type Links = [string, string][];

function ChainCard(p: { chain: string; net: string; what: ReactNode; load: () => Promise<Read>; links: Links; active: boolean }) {
  const [res, setRes] = useState<Read | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { load, active } = p;
  const run = useCallback(() => {
    setBusy(true);
    setErr(null);
    load().then(setRes, (e) => setErr(String(e?.message ?? e))).finally(() => setBusy(false));
  }, [load]);
  useEffect(() => {
    if (active) run();
  }, [active, run]);
  const phase = err ? "offline" : res && !busy ? "live" : "connecting";
  return (
    <article className="glass chain-card">
      <header>
        <h3>{p.chain}</h3>
        <span className="tag">{p.net}</span>
      </header>
      <p className="chain-what">{p.what}</p>
      <p className={`live-status ${phase}`} role="status">
        <span className="dot" aria-hidden="true" />
        {err ? "Read failed" : res && !busy ? "Live read" : "Reading the chain…"}
        {res && !err && <span className="muted">· {res.at}</span>}
        {(err || res) && (
          <button type="button" className="chain-retry" onClick={run} disabled={busy}>
            {err ? "Retry" : "Refresh"}
          </button>
        )}
      </p>
      {err && <p className="fine bad">{err}</p>}
      {res && (
        <dl className="chain-rows">
          {res.rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {res?.extra}
      <ul className="chain-links">
        {p.links.map(([label, href]) => (
          <li key={href}>
            <Ext href={href}>{label}</Ext>
          </li>
        ))}
      </ul>
    </article>
  );
}

// ---------- Tempo ----------

const TEMPO_RPC = ["https://rpc.moderato.tempo.xyz"];
const TEMPO_X = "https://explore.testnet.tempo.xyz";
const TEMPO_MARKET = "0xab3a24e55b84eafd0767c71797b7aa75e16ec639"; // VAA only (relayer 0) + betting deadline, redeployed after the security review
const TEMPO_CORE = "0xa29E8c21924834E6249bCE1FD733f24eC492018c";
const TEMPO_VAA_TX = "0x4ef420f2ffcf25d29921dbe56d8b0f31e1c9ca840bd547609918af8bee73d0c1";
const OUTCOME = ["Open", "Yes", "No", "Refund"];
// One paid dispute end to end (tempo/mpp-e2e.ts): MPP 402 -> court H7Bd -> VAA -> fee-sponsored settleWithVaa -> memo receipt.
const PAID_MARKET = "0x4df7a5af22bb31c5f33cf6d5a0e28859faa45eae";
const PAID_COURT = "H7BdJraNzvNQBS6WaYxiaSK9jGrAFqVKfVVaNHSvNKU1";
const PAID_SETTLE_TX = "0xb9a99298e7bf68b572617cf12ecc9ea1169f14bcae537341cf00da6e3ca97893";
const PAID_RECEIPT_TX = "0x67475ad666ffe37fd5811dcf27c152cd12c6c0476774797f5dffcfbb0461add6";
const pathUsd = (n: bigint) => `${(Number(n) / 1e6).toFixed(2)} pathUSD`; // TIP-20, 6 decimals

async function loadTempo(): Promise<Read> {
  const [b, [yes, no, outcome], v, proof, [, , paidOutcome], settle, receipt] = await Promise.all([
    block(TEMPO_RPC),
    call(TEMPO_RPC, TEMPO_MARKET, SEL.markets + pad(COURT_24G_HEX)),
    readCourt(COURT_24G),
    vaaProof(TEMPO_RPC, TEMPO_MARKET, TEMPO_CORE, TEMPO_VAA_TX, VAA_SEL.settleWithVaa),
    call(TEMPO_RPC, PAID_MARKET, SEL.markets + pad(courtHex(PAID_COURT))),
    rpc<{ from: string; feePayerSignature?: unknown }>(TEMPO_RPC, "eth_getTransactionByHash", [PAID_SETTLE_TX]),
    rpc<{ status: string; logs: { topics: string[] }[] }>(TEMPO_RPC, "eth_getTransactionReceipt", [PAID_RECEIPT_TX]),
  ]);
  // The receipt is a TIP-20 TransferWithMemo whose memo (topic 3) is the paid court's pubkey.
  const memoOk = receipt?.status === "0x1" && receipt.logs.some((l) => l.topics[3] === courtHex(PAID_COURT));
  return {
    at: `block ${b.toLocaleString()}`,
    rows: [
      ["Call", <code>markets(court {short(COURT_24G)})</code>],
      ["YES pool", pathUsd(yes)],
      ["NO pool", pathUsd(no)],
      ["Outcome", <strong className={outcome === 2n ? "ok" : ""}>{OUTCOME[Number(outcome)] ?? String(outcome)}</strong>],
      ["Court on Solana devnet", `yes ${v.yes} · no ${v.no} · excluded ${v.excluded}`],
      ...proof,
      ["Paid dispute (MPP 402)", <>market <Ext href={`${TEMPO_X}/address/${PAID_MARKET}`}>{short(PAID_MARKET)}</Ext> outcome{" "}
        <strong className={paidOutcome === 2n ? "ok" : ""}>{OUTCOME[Number(paidOutcome)] ?? String(paidOutcome)}</strong>; settled by{" "}
        {short(settle.from)}{settle.feePayerSignature ? " (fee sponsored)" : ""}; memo receipt{" "}
        <strong className={memoOk ? "ok" : "bad"}>{memoOk ? "names court" : "check failed"}</strong> {short(PAID_COURT)}</>],
    ],
  };
}

// ---------- Zcash ----------

interface ZecTx {
  txid: string; block: number; confirmations: number; status: string; version: number; ironwoodActions: number;
  orchardActions: number; saplingOutputs: number; transparentInputs: number; transparentOutputs: number; valueBalance: number; fee: number;
}
const ZEC_X = (t: string) => `https://testnet.zecblock.com/tx/${t}`;

const ZEC_COURT = "8bX2MwDZof48jfgfGGE1T7sMJwa6aojWvbazzpTfGNFm";

async function loadZcash(): Promise<Read> {
  const [{ zcash: z, zcashError, at }, v] = await Promise.all([chainsApi(), readCourt(ZEC_COURT)]);
  if (!z) throw new Error(`ZecBlock: ${zcashError ?? "unavailable"}`);
  const p = z.payout;
  const bonds = [z.bond1, z.bond2, z.bond3];
  const shielded = (t: ZecTx) => t.transparentInputs === 0 && t.transparentOutputs === 0;
  return {
    at: `ZecBlock, ${time(at)}`,
    rows: [
      ["Payout tx", <Ext href={ZEC_X(p.txid)}>{short(p.txid)}</Ext>],
      ["Confirmations", `${p.confirmations.toLocaleString()} (block ${p.block.toLocaleString()}, ${p.status})`],
      ["Transparent in / out", <strong className={shielded(p) ? "ok" : "bad"}>{p.transparentInputs} / {p.transparentOutputs}</strong>],
      ["Shielded actions", `${p.ironwoodActions} Ironwood (tx v${p.version})`],
      ["Net value balance", `${p.valueBalance} TAZ (= fee, amounts hidden)`],
      ["Juror bonds", `${bonds.filter(shielded).length}/3 fully shielded, ${Math.min(...bonds.map((b) => b.confirmations)).toLocaleString()}+ confirmations`],
      ["Slashed", <><strong>{bonds.length - (v.yes + v.no + v.excluded)} no-show</strong> <span className="muted">(3 bonds on Zcash − {v.yes + v.no + v.excluded} counted ballots in court {short(ZEC_COURT)})</span></>],
    ],
  };
}

// ---------- Hyperliquid ----------

const HL = "https://api.hyperliquid.xyz/info";
const HL_Q = 391;
const HL_TARGET = 8659; // Lamine Yamal
const HL_COURT = "FoRHmrnMrhHieiCCW51GwuQHGpXzvbNzDbRR6inzPQBv";
const HL_RESOLVE = "5vskW3KgJ9WYKgkzy8773i3tF7aFpUwqvviLNYodNyAjm8oCkNCVwKz7wF5nfNSw3BN31t8uCjTU6xZCHNFgGfNX";
const hlAddr = (a: string) => `https://app.hyperliquid.xyz/explorer/address/${a}`;

async function hl<T>(body: object): Promise<T> {
  for (let i = 0; ; i++) {
    const r = await fetch(HL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) return r.json();
    if (r.status !== 429 || i >= 3) throw new Error(`Hyperliquid info ${r.status}`);
    await new Promise((s) => setTimeout(s, 1000 * (i + 1)));
  }
}
/** Runs f over xs, n at a time (stays well under HL's per-IP weight limit). */
async function pool<A, B>(xs: A[], n: number, f: (x: A) => Promise<B>): Promise<B[]> {
  const out: B[] = [];
  for (let i = 0; i < xs.length; i += n) out.push(...(await Promise.all(xs.slice(i, i + n).map(f))));
  return out;
}

interface Outcome { outcome: number; name: string; description: string }
interface Question { question: number; description: string; fallbackOutcome: number; namedOutcomes: number[]; settledNamedOutcomes: number[] }

/** The Saring court on Solana devnet, read through the app's RPC proxy. */
async function readCourt(addr: string) {
  const info = await new Connection(RPC_URL, "confirmed").getAccountInfo(new PublicKey(addr));
  if (!info) throw new Error("court account not found on devnet");
  // Pad: courts created before v3.2 may end before the appended 32-byte pendingComputation.
  const c = new BorshAccountsCoder(idl as Idl).decode("CourtAccount", Buffer.concat([info.data, Buffer.alloc(32)]));
  return { resolved: !!c.resolved, yes: Number(c.yes), no: Number(c.no), excluded: Number(c.excluded), incomplete: !!c.incomplete };
}

async function loadHyperliquid(): Promise<Read> {
  const meta = await hl<{ outcomes: Outcome[]; questions: Question[] }>({ type: "outcomeMeta" });
  const q = meta.questions.find((x) => x.question === HL_Q);
  if (!q) throw new Error(`question #${HL_Q} not in outcomeMeta`);
  const outs = [q.fallbackOutcome, ...q.namedOutcomes];
  const name = (o: number) => {
    const x = meta.outcomes.find((y) => y.outcome === o);
    return x?.description.match(/candidate:([^|]+)/)?.[1]?.trim() ?? (o === q.fallbackOutcome ? "Other" : `#${o} ${x?.name.replace("template:", "") ?? ""}`.trim());
  };
  const encs = outs.flatMap((o) => [10 * o, 10 * o + 1]); // enc = 10*outcome + side (0 Yes, 1 No)
  // Holders = recent-trade counterparties whose live spot state shows a non-zero "+<enc>" (same as hyperliquid/hl.ts).
  const trades = await pool(encs, 6, (e) => hl<{ users?: string[] }[]>({ type: "recentTrades", coin: `#${e}` }));
  const users = [...new Set(trades.flat().flatMap((t) => t.users ?? []).map((u) => u.toLowerCase()))];
  const want = new Set(encs.map((e) => `+${e}`));
  const states = await pool(users, 8, (u) => hl<{ balances: { coin: string; total: string }[] }>({ type: "spotClearinghouseState", user: u }));
  const holders = users
    .map((u, i) => ({ u, b: states[i].balances.filter((x) => want.has(x.coin) && Number(x.total) !== 0) }))
    .filter((h) => h.b.length)
    .map((h) => ({ ...h, total: h.b.reduce((s, x) => s + Number(x.total), 0) }))
    .sort((a, b) => b.total - a.total);
  const side = (coin: string) => { const e = Number(coin.slice(1)); return `${name(Math.floor(e / 10))} ${e % 10 ? "No" : "Yes"}`; };
  const v = await readCourt(HL_COURT);
  const verdict = !v.resolved ? "OPEN" : v.incomplete ? "INCOMPLETE" : v.yes > v.no ? "YES" : v.no > v.yes ? "NO" : "TIE";
  const fraction = verdict === "YES" ? '"1"' : verdict === "NO" ? '"0"' : "none (question outcome)";
  return {
    at: `api.hyperliquid.xyz, ${time(Date.now())}`,
    rows: [
      ["Question", `#${HL_Q} ${q.description.match(/award:([^|]+)/)?.[1] ?? ""} ${q.description.match(/period:(\d+)/)?.[1] ?? ""}, ${outs.length} outcomes, ${q.settledNamedOutcomes.length} settled`],
      ["Recent trades read", `${trades.flat().length} across ${encs.length} sides, ${users.length} counterparties`],
      ["Holders now", <strong>{holders.length} hold an outcome token</strong>],
      ["Devnet court verdict", <>yes {v.yes} · no {v.no} · excluded {v.excluded} → <strong>{verdict}</strong></>],
      ["settleOutcome", <>outcome {HL_TARGET} ({name(HL_TARGET)}), settleFraction {fraction} · <span className="tag sealed">not submitted</span></>],
    ],
    extra: (
      <details className="chain-more">
        <summary>Top holders, live balances</summary>
        <ol>
          {holders.slice(0, 8).map((h) => (
            <li key={h.u}>
              <Ext href={hlAddr(h.u)}>{short(h.u)}</Ext>{" "}
              <span className="muted">{h.b.map((x) => `${side(x.coin)} ${Number(x.total).toLocaleString()}`).join(" · ")}</span>
            </li>
          ))}
        </ol>
      </details>
    ),
  };
}

// ---------- Ethereum L1 + Sepolia ----------

const GH = "https://github.com/PugarHuda/saring/blob/main";
const ETH_RPC = ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"];
const SEP_RPC = ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.drpc.org"];
const VOTING_V2 = "0x004395edb43EFca9885CEdad51EC9fAf93Bd34ac";
const REGISTRY = "0x4e87CC9fD0791bC8cF85d9f49772E193BCD5be55";
const WHALE = "0xb524735356985d2f267fa010d681f061dff03715"; // largest non-conflicted voter in the same dispute
const THAI = fixture.cases[0];
const conflictedCall = (voter: string) =>
  SEL.isConflicted + pad(THAI.disputeId) + pad(voter) + pad("60") + pad(THAI.proof.length.toString(16)) + THAI.proof.map(pad).join("");
const yesNo = (b: bigint) => <strong className={b ? "bad" : "ok"}>{b ? "true" : "false"}</strong>;

const SEP_EM = "0x41014a50d7582ae90b50d0b1da0c1ccbaac0115c"; // VAA only (relayer 0), redeployed after the security review
const SEP_OOV3 = "0xFd9e2642a170aDD10F53Ee14a93FcF2F31924944";
const SEP_CORE = "0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78";
const SEP_ASSERTION = "0xc903d00365c35bd1c768b37b3fc0fa1f101a4f41cecf62765332e4ddd7feb9d0";
const SEP_VAA_TX = "0x46ee84adb1ac62fb692fffdc8b58d06232e11c89dc47df2cdf0604dd6fe7aeec";

async function loadEthereum(): Promise<Read> {
  const [b, [round], [phase], [pending, resolved], sb, [leaves], [c1], [c2], [sepResult], proof] = await Promise.all([
    block(ETH_RPC),
    call(ETH_RPC, VOTING_V2, SEL.getCurrentRoundId),
    call(ETH_RPC, VOTING_V2, SEL.getVotePhase),
    call(ETH_RPC, VOTING_V2, SEL.getNumberOfPriceRequests),
    block(SEP_RPC),
    call(SEP_RPC, REGISTRY, SEL.leafCount),
    call(SEP_RPC, REGISTRY, conflictedCall(THAI.voter)),
    call(SEP_RPC, REGISTRY, conflictedCall(WHALE)),
    call(SEP_RPC, SEP_OOV3, SEL.getAssertionResult + pad(SEP_ASSERTION)), // reverts unless settled
    vaaProof(SEP_RPC, SEP_EM, SEP_CORE, SEP_VAA_TX, VAA_SEL.resolveWithVaa),
  ]);
  return {
    at: `mainnet ${b.toLocaleString()} · Sepolia ${sb.toLocaleString()}`,
    rows: [
      ["UMA VotingV2 round", <><strong>{round.toString()}</strong> ({phase === 0n ? "commit" : "reveal"} phase)</>],
      ["Price requests", `${pending} pending, ${resolved.toLocaleString()} resolved`],
      ["Registry leaves", `${leaves.toLocaleString()} (dispute, voter) pairs`],
      ["isConflicted(Thailand, 0xacb1…6272)", yesNo(c1)],
      ["isConflicted(same dispute, whale 0xb524…3715)", yesNo(c2)],
      ["Vote proofs (proof bundle, not a live read)", <><strong>70/70 votes proven against headers</strong>{" "}
        <Ext href={`${GH}/ethereum/out/vote-proofs.json`}>vote-proofs.json</Ext> · <code>npx tsx prove-votes.ts --verify --offline</code></>],
      ["Sepolia OOv3.getAssertionResult", <>{yesNo(sepResult)} <span className="muted">(assertion {short(SEP_ASSERTION)}, Saring EM said NO)</span></>],
      ...proof,
    ],
  };
}

// ---------- Arbitrum Sepolia ----------

const ARB_RPC = ["https://sepolia-rollup.arbitrum.io/rpc", "https://arbitrum-sepolia-rpc.publicnode.com"];
const ARB_X = "https://sepolia.arbiscan.io";
const EM = "0xc36dd39a3fc1831a2813e20316f998c08fb74b58"; // VAA only (relayer 0), redeployed after the security review
const OOV3 = "0x1037A21a30aEfF90c269b01c3933eB9a5285d9b8";
const ARB_CORE = "0x6b9C8671cdDC8dEab9c719bB87cBd3e782bA6a35";
const ASSERTION = "0xa7e8d7ae26bf30b8c4179a53d259bdfb11bf14959ca3f8ba2fe0a38317f473d4";
const ARB_VAA_TX = "0x89ebcbca147f046ceb8df1adc30d4436f1fdd3a8d25f16ff7a75754c6d249617";
const KLEROS_V2 = "0xc2b4805da6899d788b179f12eb19136bd73f5ba5"; // SaringArbitratorV2 (IArbitratorV2)
const KLEROS_RULE_TX = "0x4a9da88971511f607a2d45a18866e6dd7dd5ceb2cbab5f78d65226352e18eeea";

async function loadArbitrum(): Promise<Read> {
  const [b, [court], [result], [, viaEm], proof, [ruling, tied]] = await Promise.all([
    block(ARB_RPC),
    call(ARB_RPC, EM, SEL.courtOf + pad(ASSERTION)),
    call(ARB_RPC, OOV3, SEL.getAssertionResult + pad(ASSERTION)), // reverts unless settled
    call(ARB_RPC, EM, SEL.getAssertionPolicy + pad(ASSERTION)), // (block, arbitrateViaEM, discardOracle, validateDisputers)
    vaaProof(ARB_RPC, EM, ARB_CORE, ARB_VAA_TX, VAA_SEL.resolveWithVaa),
    call(ARB_RPC, KLEROS_V2, SEL.currentRuling + pad("0")),
  ]);
  return {
    at: `block ${b.toLocaleString()}`,
    rows: [
      ["Assertion", <code>{short(ASSERTION)}</code>],
      ["EM.courtOf", <>{b58(court)} <span className="muted">(Saring court)</span></>],
      ["OOv3.getAssertionResult", <>{yesNo(result)} <span className="muted">(settled; Saring said NO, disputer won)</span></>],
      ["Kleros V2 currentRuling(0)", <><strong className={ruling === 2n ? "ok" : ""}>{ruling.toString()} ({["refused", "YES", "NO"][Number(ruling)] ?? "?"})</strong>{tied ? ", tied" : ""}{" "}
        <span className="muted">(SaringArbitratorV2 {short(KLEROS_V2)}; escrow payer refunded by VAA)</span></>],
      ["EM.getAssertionPolicy", <>arbitrateViaEscalationManager = {viaEm ? "true" : "false"} <span className="muted">({viaEm ? "UMA DVM bypassed" : "DVM used"})</span></>],
      ...proof,
    ],
  };
}

// ---------- Base Sepolia ----------

const BASE_RPC = ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"];
const BASE_X = "https://sepolia.basescan.org";
const ARBITRATOR = "0xad38eb68f9912f39e201960f22e584d650f2f8c5"; // VAA only (relayer 0), redeployed after the security review
const LIMITLESS_ARB = "0x384822075dc735ea7de0b8417c9b4403bb9d682a"; // pre-review arbitrator that ruled the Limitless question
const REALITY = "0x86b653Dc9aa6d7311109276925927087573f91CB";
const BASE_CORE = "0x79A1027a6A159502049F10906D333EC57E95F083";
const QID = "0xc121dfd42e6320863f693b2a9b3933980eba051323ad67e3ad34ae0148408421";
const BASE_VAA_TX = "0x7595811eceb6825878bce3ff5f64ce5c6e6ae2be375026107023e8e14ebe532e";
// Base-native loop (base/limitless-court.ts): 12 real Limitless holders -> court BT7f (top holder seated, excluded) -> VAA -> Reality.eth.
const LIMITLESS_COURT = "BT7fCq2tCffGCB8M64gj5o2P4aXLtdG4FjdWgPsqkZhr";
const LIMITLESS_QID = "0x9c1fd757056eba950758ca3ba4b92222ee333a0198dfe6999e12027956c6baaf";
const LIMITLESS_VAA_TX = "0x8147296f09df926865aeba6eb35215995d896c6ebbae26482fe09737033b44d2";
const answer = (h: bigint) => (h === 1n ? "YES" : h === 0n ? "NO" : h === 2n ** 256n - 1n ? "INVALID" : hex32(h));

async function loadBase(): Promise<Read> {
  const [b, [court], [ruled], [fin], [res], proof, lc, [lCourt], [lFin], [lRes]] = await Promise.all([
    block(BASE_RPC),
    call(BASE_RPC, ARBITRATOR, SEL.courtOf + pad(QID)),
    call(BASE_RPC, ARBITRATOR, SEL.ruled + pad(QID)),
    call(BASE_RPC, REALITY, SEL.isFinalized + pad(QID)),
    call(BASE_RPC, REALITY, SEL.resultFor + pad(QID)),
    vaaProof(BASE_RPC, ARBITRATOR, BASE_CORE, BASE_VAA_TX, VAA_SEL.ruleWithVaa),
    readCourt(LIMITLESS_COURT),
    call(BASE_RPC, LIMITLESS_ARB, SEL.courtOf + pad(LIMITLESS_QID)),
    call(BASE_RPC, REALITY, SEL.isFinalized + pad(LIMITLESS_QID)),
    call(BASE_RPC, REALITY, SEL.resultFor + pad(LIMITLESS_QID)),
  ]);
  return {
    at: `block ${b.toLocaleString()}`,
    rows: [
      ["Question", <code>{short(QID)}</code>],
      ["Arbitrator.courtOf", <>{b58(court)} <span className="muted">(Saring court)</span></>],
      ["Arbitrator.ruled", ruled ? "true" : "false"],
      ["Reality.eth isFinalized", fin ? "true" : "false"],
      ["Reality.eth resultFor", <><strong>{answer(res)}</strong> <span className="muted">(answerer said YES; Saring overruled)</span></>],
      ...proof,
      ["Limitless court (Base mainnet holders)", <>court {short(LIMITLESS_COURT)}: yes {lc.yes} · no {lc.no} · excluded {lc.excluded}
        {b58(lCourt) === LIMITLESS_COURT ? "" : " (court mismatch!)"}; Reality question {short(LIMITLESS_QID)}{" "}
        <strong className={lFin && lRes === 0n ? "ok" : ""}>{lFin ? answer(lRes) : "not final"}</strong>{" "}
        <span className="muted">("Atalanta vs Venezia", 12 holders, top holder seated)</span></>],
    ],
  };
}

// ---------- section ----------

const CARDS: { chain: string; net: string; what: ReactNode; load: () => Promise<Read>; links: Links }[] = [
  {
    chain: "Tempo",
    net: "Moderato testnet",
    what: <>A pathUSD YES/NO market settled by a bettor delivering the Wormhole VAA of a Saring verdict (deployed with relayer = 0: no Saring key can settle it; bets close at a deadline); fees paid by TIP-20 memo and MPP.</>,
    load: loadTempo,
    links: [
      ["SaringMarket", `${TEMPO_X}/address/${TEMPO_MARKET}`],
      ["settleWithVaa tx", `${TEMPO_X}/tx/${TEMPO_VAA_TX}`],
      ["claim tx", `${TEMPO_X}/tx/0x855ab9a0f3d3b20ec26584c706de8a1bb1463897a75dc1a29e24044b4a272a5f`],
      ["Solana emitter tx (Wormhole)", `https://explorer.solana.com/tx/${SOL_EMITTER_TX}?cluster=devnet`],
      ["VAA on Wormholescan", `https://wormholescan.io/#/tx/${SOL_EMITTER_TX}?network=Testnet`],
      ["Fee with memo", `${TEMPO_X}/tx/0xfd2ecd44cbd7f47565e4cec1451ab74660303f752c6c4cb37ff9a3e698e37846`],
      ["Paid dispute: sponsored settleWithVaa", `${TEMPO_X}/tx/${PAID_SETTLE_TX}`],
      ["Paid dispute: memo receipt", `${TEMPO_X}/tx/${PAID_RECEIPT_TX}`],
    ],
  },
  {
    chain: "Zcash",
    net: "testnet (NU7)",
    what: <>Juror bonds, refunds and rewards move as shielded ZEC with encrypted memos; a no-show's bond is slashed to the voters, and anyone can recheck the payout with the published viewing key.</>,
    load: loadZcash,
    links: [
      ["Payout tx", ZEC_X("9a7d57aee89f19209d32b48c7e5dc54168904b0f7d4520b7efa769156d0b755b")],
      ["Bond 1", ZEC_X("d1148bfd1f69c7f4450959c5d4fcb09e0e3589b1a812bfe6dfe14375a880d233")],
      ["Bond 2", ZEC_X("7ef24c11ae595f88ce1ba084dd8183057eca43bd03703fbece3cfa58f8475de8")],
      ["Bond 3 (slashed)", ZEC_X("b3adcffe4650c690b85f75ff31558aeeee9a9f8ddf76cf075baf8f5c35ab21f8")],
      ["Public verifier report (12/12)", `${GH}/zcash/out/verify-8bX2MwDZof48jfgfGGE1T7sMJwa6aojWvbazzpTfGNFm.md`],
    ],
  },
  {
    chain: "Hyperliquid",
    net: "mainnet HIP-4",
    what: <>Holders of a live HIP-4 question are mirrored into a Saring court; the verdict becomes a <code>settleOutcome</code> action.</>,
    load: loadHyperliquid,
    links: [
      ["Court on Solana devnet", `https://explorer.solana.com/address/${HL_COURT}?cluster=devnet`],
      ["Resolve tx", explorerTx(HL_RESOLVE)],
      ["Juror A (real holder)", hlAddr("0x27343233ae52bc46d85138bdaf566d6a1960f947")],
    ],
  },
  {
    chain: "Ethereum L1",
    net: "mainnet + Sepolia",
    what: <>UMA DVM votes are rebuilt from mainnet logs into a Merkle conflict registry; on Sepolia a UMA OOv3 escalation manager takes its verdict from a Wormhole VAA.</>,
    load: loadEthereum,
    links: [
      ["UMA VotingV2", `https://etherscan.io/address/${VOTING_V2}#readContract`],
      ["UmaConflictRegistry", `https://sepolia.etherscan.io/address/${REGISTRY}`],
      ["Vote proof bundle", `${GH}/ethereum/out/vote-proofs.json`],
      ["Registry deploy tx", "https://sepolia.etherscan.io/tx/0xc7c0a7b18cc73aea684c66a6eb280b1f6d15b0bd660ae77a9c276c0dc50fff4f"],
      ["Sepolia SaringEscalationManager", `https://sepolia.etherscan.io/address/${SEP_EM}`],
      ["resolveWithVaa tx", `https://sepolia.etherscan.io/tx/${SEP_VAA_TX}`],
      ["Solana emitter tx (Wormhole)", `https://explorer.solana.com/tx/${SOL_EMITTER_TX}?cluster=devnet`],
      ["VAA on Wormholescan", `https://wormholescan.io/#/tx/${SOL_EMITTER_TX}?network=Testnet`],
    ],
  },
  {
    chain: "Arbitrum",
    net: "Sepolia",
    what: <>A UMA OOv3 escalation manager and a Kleros v2 <code>IArbitratorV2</code>: disputes go to a Saring court, and the verdict arrives as a Wormhole VAA.</>,
    load: loadArbitrum,
    links: [
      ["SaringEscalationManager", `${ARB_X}/address/${EM}`],
      ["resolveWithVaa tx", `${ARB_X}/tx/${ARB_VAA_TX}`],
      ["settleAssertion tx", `${ARB_X}/tx/0xaaae5ed3e9edf4ab4995f034ceb79687a4c83dd79a3217f81ac17cd320c3c3df`],
      ["SaringArbitratorV2 (Kleros)", `${ARB_X}/address/${KLEROS_V2}`],
      ["Kleros ruleWithVaa tx", `${ARB_X}/tx/${KLEROS_RULE_TX}`],
      ["Solana emitter tx (Wormhole)", `https://explorer.solana.com/tx/${SOL_EMITTER_TX}?cluster=devnet`],
      ["VAA on Wormholescan", `https://wormholescan.io/#/tx/${SOL_EMITTER_TX}?network=Testnet`],
    ],
  },
  {
    chain: "Base",
    net: "Sepolia + mainnet reads",
    what: <>A Reality.eth v3 arbitrator (the slot Kleros fills for Seer and Precog) ruled by a Wormhole VAA, plus a court seated from real Limitless holders on Base mainnet.</>,
    load: loadBase,
    links: [
      ["SaringArbitrator", `${BASE_X}/address/${ARBITRATOR}`],
      ["ruleWithVaa tx", `${BASE_X}/tx/${BASE_VAA_TX}`],
      ["Reality.eth v3", `${BASE_X}/address/${REALITY}`],
      ["Limitless court on devnet", `https://explorer.solana.com/address/${LIMITLESS_COURT}?cluster=devnet`],
      ["Limitless ruleWithVaa tx", `${BASE_X}/tx/${LIMITLESS_VAA_TX}`],
      ["Solana emitter tx (Wormhole)", `https://explorer.solana.com/tx/${SOL_EMITTER_TX}?cluster=devnet`],
      ["VAA on Wormholescan", `https://wormholescan.io/#/tx/${SOL_EMITTER_TX}?network=Testnet`],
    ],
  },
];

export default function Multichain() {
  const ref = useRef<HTMLElement>(null);
  const [active, setActive] = useState(false);
  // Read only once the section is (nearly) on screen; stays loaded after.
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setActive(true), { rootMargin: "300px" });
    if (ref.current) io.observe(ref.current);
    // The browser jumps to #multichain before React renders the section; jump again now that it exists.
    if (location.hash === "#multichain") ref.current?.scrollIntoView();
    return () => io.disconnect();
  }, []);
  return (
    <section id="multichain" className="block" aria-labelledby="multichain-h" ref={ref}>
      <div className="block-head">
        <h2 id="multichain-h">Multichain: every integration, read live</h2>
        <p>
          The court runs on Solana devnet with Arcium MPC. Each card below is filled by a <strong>live read</strong> of its
          chain from your browser (Zcash and the Wormholescan VAA through our <code>/api/chains</code> proxy), not by stored
          results. Tempo, Arbitrum, Base and Ethereum Sepolia now take the court's verdict as a <strong>Wormhole VAA</strong>{" "}
          posted by the <code>saring_wormhole</code> program after it read the resolved court on Solana; each card checks
          the settling tx and the contract's Wormhole core and emitter. These contracts were redeployed after our security
          review with <code>relayer = 0</code>, so no Saring-held key can settle them. Testnet limits: one guardian signs, and our programs are still upgradeable. Refresh to read again.
        </p>
      </div>
      <div className="chain-grid">
        {CARDS.map((c) => (
          <ChainCard key={c.chain} {...c} active={active} />
        ))}
      </div>
    </section>
  );
}
