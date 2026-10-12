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
};

// The Solana devnet court the Tempo market, Arbitrum EM and Base arbitrator were all settled on (resolved NO).
const COURT_24G = "24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb";
const COURT_24G_HEX = "0x" + Buffer.from(new PublicKey(COURT_24G).toBytes()).toString("hex");

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
const TEMPO_MARKET = "0x256EebAd0930Fe8e899B5E7C239130db50Af0446";
const OUTCOME = ["Open", "Yes", "No", "Refund"];
const pathUsd = (n: bigint) => `${(Number(n) / 1e6).toFixed(2)} pathUSD`; // TIP-20, 6 decimals

async function loadTempo(): Promise<Read> {
  const [b, [yes, no, outcome], v] = await Promise.all([
    block(TEMPO_RPC),
    call(TEMPO_RPC, TEMPO_MARKET, SEL.markets + pad(COURT_24G_HEX)),
    readCourt(COURT_24G),
  ]);
  return {
    at: `block ${b.toLocaleString()}`,
    rows: [
      ["Call", <code>markets(court {short(COURT_24G)})</code>],
      ["YES pool", pathUsd(yes)],
      ["NO pool", pathUsd(no)],
      ["Outcome", <strong className={outcome === 2n ? "ok" : ""}>{OUTCOME[Number(outcome)] ?? String(outcome)}</strong>],
      ["Court on Solana devnet", `yes ${v.yes} · no ${v.no} · excluded ${v.excluded} (relayed as an EIP-712 verdict)`],
    ],
  };
}

// ---------- Zcash ----------

interface ZecTx {
  txid: string; block: number; confirmations: number; status: string; version: number; ironwoodActions: number;
  orchardActions: number; saplingOutputs: number; transparentInputs: number; transparentOutputs: number; valueBalance: number; fee: number;
}
const ZEC_X = (t: string) => `https://testnet.zecblock.com/tx/${t}`;

async function loadZcash(): Promise<Read> {
  const r = await fetch("/api/chains", { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`/api/chains ${r.status}`);
  const { zcash: z, at } = (await r.json()) as { at: number; zcash: Record<"payout" | "bond1" | "bond2" | "bond3", ZecTx> };
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
  const c = new BorshAccountsCoder(idl as Idl).decode("CourtAccount", info.data);
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

const ETH_RPC = ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"];
const SEP_RPC = ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.drpc.org"];
const VOTING_V2 = "0x004395edb43EFca9885CEdad51EC9fAf93Bd34ac";
const REGISTRY = "0x4e87CC9fD0791bC8cF85d9f49772E193BCD5be55";
const WHALE = "0xb524735356985d2f267fa010d681f061dff03715"; // largest non-conflicted voter in the same dispute
const THAI = fixture.cases[0];
const conflictedCall = (voter: string) =>
  SEL.isConflicted + pad(THAI.disputeId) + pad(voter) + pad("60") + pad(THAI.proof.length.toString(16)) + THAI.proof.map(pad).join("");
const yesNo = (b: bigint) => <strong className={b ? "bad" : "ok"}>{b ? "true" : "false"}</strong>;

async function loadEthereum(): Promise<Read> {
  const [b, [round], [phase], [pending, resolved], sb, [leaves], [c1], [c2]] = await Promise.all([
    block(ETH_RPC),
    call(ETH_RPC, VOTING_V2, SEL.getCurrentRoundId),
    call(ETH_RPC, VOTING_V2, SEL.getVotePhase),
    call(ETH_RPC, VOTING_V2, SEL.getNumberOfPriceRequests),
    block(SEP_RPC),
    call(SEP_RPC, REGISTRY, SEL.leafCount),
    call(SEP_RPC, REGISTRY, conflictedCall(THAI.voter)),
    call(SEP_RPC, REGISTRY, conflictedCall(WHALE)),
  ]);
  return {
    at: `mainnet ${b.toLocaleString()} · Sepolia ${sb.toLocaleString()}`,
    rows: [
      ["UMA VotingV2 round", <><strong>{round.toString()}</strong> ({phase === 0n ? "commit" : "reveal"} phase)</>],
      ["Price requests", `${pending} pending, ${resolved.toLocaleString()} resolved`],
      ["Registry leaves", `${leaves.toLocaleString()} (dispute, voter) pairs`],
      ["isConflicted(Thailand, 0xacb1…6272)", yesNo(c1)],
      ["isConflicted(same dispute, whale 0xb524…3715)", yesNo(c2)],
    ],
  };
}

// ---------- Arbitrum Sepolia ----------

const ARB_RPC = ["https://sepolia-rollup.arbitrum.io/rpc", "https://arbitrum-sepolia-rpc.publicnode.com"];
const ARB_X = "https://sepolia.arbiscan.io";
const EM = "0xd96e40e336363f856ce264176da6c24bf23803b4";
const OOV3 = "0x1037A21a30aEfF90c269b01c3933eB9a5285d9b8";
const ASSERTION = "0x57ca4c55695ada75c42df08a1f15c8020d410a83fa25b393c5a69fcd5b50d75e";

async function loadArbitrum(): Promise<Read> {
  const [b, [court], [result], [, viaEm]] = await Promise.all([
    block(ARB_RPC),
    call(ARB_RPC, EM, SEL.courtOf + pad(ASSERTION)),
    call(ARB_RPC, OOV3, SEL.getAssertionResult + pad(ASSERTION)), // reverts unless settled
    call(ARB_RPC, EM, SEL.getAssertionPolicy + pad(ASSERTION)), // (block, arbitrateViaEM, discardOracle, validateDisputers)
  ]);
  return {
    at: `block ${b.toLocaleString()}`,
    rows: [
      ["Assertion", <code>{short(ASSERTION)}</code>],
      ["EM.courtOf", <>{b58(court)} <span className="muted">(Saring court)</span></>],
      ["OOv3.getAssertionResult", <>{yesNo(result)} <span className="muted">(settled; Saring said NO, disputer won)</span></>],
      ["EM.getAssertionPolicy", <>arbitrateViaEscalationManager = {viaEm ? "true" : "false"} <span className="muted">({viaEm ? "UMA DVM bypassed" : "DVM used"})</span></>],
    ],
  };
}

// ---------- Base Sepolia ----------

const BASE_RPC = ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"];
const BASE_X = "https://sepolia.basescan.org";
const ARBITRATOR = "0xd96e40e336363f856ce264176da6c24bf23803b4";
const REALITY = "0x86b653Dc9aa6d7311109276925927087573f91CB";
const QID = "0xf68230ab06fd9e433ad3f497e5b9956b34ebf0ca74e11a306c5f7cbb9ec200ae";
const answer = (h: bigint) => (h === 1n ? "YES" : h === 0n ? "NO" : h === 2n ** 256n - 1n ? "INVALID" : hex32(h));

async function loadBase(): Promise<Read> {
  const [b, [court], [ruled], [fin], [res]] = await Promise.all([
    block(BASE_RPC),
    call(BASE_RPC, ARBITRATOR, SEL.courtOf + pad(QID)),
    call(BASE_RPC, ARBITRATOR, SEL.ruled + pad(QID)),
    call(BASE_RPC, REALITY, SEL.isFinalized + pad(QID)),
    call(BASE_RPC, REALITY, SEL.resultFor + pad(QID)),
  ]);
  return {
    at: `block ${b.toLocaleString()}`,
    rows: [
      ["Question", <code>{short(QID)}</code>],
      ["Arbitrator.courtOf", <>{b58(court)} <span className="muted">(Saring court)</span></>],
      ["Arbitrator.ruled", ruled ? "true" : "false"],
      ["Reality.eth isFinalized", fin ? "true" : "false"],
      ["Reality.eth resultFor", <><strong>{answer(res)}</strong> <span className="muted">(answerer said YES; Saring overruled)</span></>],
    ],
  };
}

// ---------- section ----------

const CARDS: { chain: string; net: string; what: ReactNode; load: () => Promise<Read>; links: Links }[] = [
  {
    chain: "Tempo",
    net: "Moderato testnet",
    what: <>A pathUSD YES/NO market that settles only on a relayer-signed Saring verdict; fees paid by TIP-20 memo and MPP.</>,
    load: loadTempo,
    links: [
      ["SaringMarket", `${TEMPO_X}/address/${TEMPO_MARKET}`],
      ["settle() tx", `${TEMPO_X}/tx/0x05a3e4459f2988318d887d027fd94047ffe3c630d6c7fc85b02b42992dd5340d`],
      ["claim tx", `${TEMPO_X}/tx/0xaaded73b50f2665ea43d78dea69e814259b134fe6e391a295ab8360e4e21bd01`],
      ["Fee with memo", `${TEMPO_X}/tx/0xfd2ecd44cbd7f47565e4cec1451ab74660303f752c6c4cb37ff9a3e698e37846`],
    ],
  },
  {
    chain: "Zcash",
    net: "testnet (NU7)",
    what: <>Juror bonds, refunds and rewards move as shielded ZEC with encrypted memos, so no one can check a bribe was earned.</>,
    load: loadZcash,
    links: [
      ["Payout tx", ZEC_X("752e543cd8ef2d4e35511c09afe89d89d164df4c3adb4f1dc909d64b5e03aa85")],
      ["Bond 1", ZEC_X("5edea8cec97f12eb584a366e4705b951bce6c07eb48067d9fdd643c339f8902e")],
      ["Bond 2", ZEC_X("971faa3c8a8c18afd738549333f51c29c2474d27f9630d3dc804d70d19b78c57")],
      ["Bond 3", ZEC_X("e6c5ef6943b2735a782eae77cb72e9fa17f44c737f6a7afc748d2426c68b207b")],
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
    what: <>UMA DVM votes are rebuilt from mainnet logs; the conflicted-voter set is committed to a Merkle registry anyone can query.</>,
    load: loadEthereum,
    links: [
      ["UMA VotingV2", `https://etherscan.io/address/${VOTING_V2}#readContract`],
      ["UmaConflictRegistry", `https://sepolia.etherscan.io/address/${REGISTRY}`],
      ["Registry deploy tx", "https://sepolia.etherscan.io/tx/0xc7c0a7b18cc73aea684c66a6eb280b1f6d15b0bd660ae77a9c276c0dc50fff4f"],
    ],
  },
  {
    chain: "Arbitrum",
    net: "Sepolia",
    what: <>A UMA OOv3 escalation manager: a disputed assertion goes to a Saring court instead of the DVM.</>,
    load: loadArbitrum,
    links: [
      ["SaringEscalationManager", `${ARB_X}/address/${EM}`],
      ["resolve() tx", `${ARB_X}/tx/0x47d123956b20235728e45363a7f72d5b9c1c36d79ceb67cb6826775f24da3324`],
      ["settleAssertion tx", `${ARB_X}/tx/0x60761025882c3d693c27867d0e5e8d14876642233477104ab39fec89c47cdf72`],
    ],
  },
  {
    chain: "Base",
    net: "Sepolia",
    what: <>A Reality.eth v3 arbitrator, the slot Kleros fills for Seer and Precog, backed by a Saring court.</>,
    load: loadBase,
    links: [
      ["SaringArbitrator", `${BASE_X}/address/${ARBITRATOR}`],
      ["rule() tx", `${BASE_X}/tx/0x5878e40b55faecdaf3b3c5b8b5f491f03227247d3556a2b1c7350ed1e57fd47e`],
      ["Reality.eth v3", `${BASE_X}/address/${REALITY}`],
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
          chain from your browser (Zcash through our <code>/api/chains</code> proxy), not by stored results. Refresh to read
          again.
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
