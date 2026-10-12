/**
 * Hyperliquid mainnet HIP-4 outcome markets, read live from the Info API.
 *
 *   ts-node hyperliquid/hl.ts questions                 -> list HIP-4 questions (outcomeMeta)
 *   ts-node hyperliquid/hl.ts holders <question> [outcome]
 *        -> holders of the question's outcome tokens, each confirmed via spotClearinghouseState
 *
 * Request types used (all POST https://api.hyperliquid.xyz/info, verified live Oct 2026):
 *   {"type":"outcomeMeta"}                         outcomes[], questions[], deployers[]
 *   {"type":"recentTrades","coin":"#<enc>"}        last trades of one side; each has users:[buyer, seller]
 *   {"type":"spotClearinghouseState","user":addr}  balances[]; outcome side shows as coin "+<enc>"
 * enc = 10*outcome + side (side 0 = first sideSpec, usually Yes; 1 = No).
 * tokenDetails does NOT accept outcome tokens (they have no spot token index), so there is no
 * holder list endpoint: holders are discovered from trade counterparties, then confirmed by balance.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

export const INFO = process.env.HL_INFO_URL ?? "https://api.hyperliquid.xyz/info";
export const OUT = path.join(__dirname, "out");

export async function info<T = any>(body: object): Promise<T> {
  for (let i = 0; ; i++) {
    const r = await fetch(INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) return r.json() as Promise<T>;
    if (r.status !== 429 || i >= 5) throw new Error(`HL info ${JSON.stringify(body)}: HTTP ${r.status} ${await r.text()}`);
    await new Promise((s) => setTimeout(s, 1000 * (i + 1))); // ponytail: rate limit (1200 weight/min) backoff
  }
}

export interface Outcome { outcome: number; name: string; description: string; sideSpecs: { name: string }[]; venue: string }
export interface Question { question: number; name: string; description: string; fallbackOutcome: number; namedOutcomes: number[]; settledNamedOutcomes: number[] }
export const outcomeMeta = () => info<{ outcomes: Outcome[]; questions: Question[]; deployers: any[] }>({ type: "outcomeMeta" });

export interface Holder { address: string; balances: Record<string, string> } // "+<enc>" -> total

/** Holders of the given outcomes: trade counterparties whose live spot state shows a non-zero "+<enc>". */
export async function outcomeHolders(outcomes: number[]): Promise<{ holders: Holder[]; candidates: number; trades: number }> {
  const encs = outcomes.flatMap((o) => [10 * o, 10 * o + 1]);
  const users = new Set<string>();
  let trades = 0;
  for (const e of encs) {
    const t = (await info<any[]>({ type: "recentTrades", coin: `#${e}` })) ?? [];
    trades += t.length;
    for (const x of t) for (const u of x.users ?? []) users.add(u.toLowerCase());
  }
  const want = new Set(encs.map((e) => `+${e}`));
  const holders: Holder[] = [];
  for (const u of users) {
    const s = await info<{ balances: { coin: string; total: string }[] }>({ type: "spotClearinghouseState", user: u });
    const b = Object.fromEntries(s.balances.filter((x) => want.has(x.coin) && Number(x.total) !== 0).map((x) => [x.coin, x.total]));
    if (Object.keys(b).length) holders.push({ address: u, balances: b });
  }
  return { holders, candidates: users.size, trades };
}

/**
 * Court identity for a 20-byte EVM address: first 4 bytes (LE) of SHA-256(the 20 raw address
 * bytes), never 0. Same construction as sdk identityId() (which hashes the 32-byte Solana pubkey),
 * just over the EVM address bytes, so an HL juror collides with their own HL position inside MPC.
 */
export function evmIdentityId(address: string): number {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`not an EVM address: ${address}`);
  const id = createHash("sha256").update(Buffer.from(address.slice(2), "hex")).digest().readUInt32LE(0);
  return id === 0 ? 1 : id;
}

export const writeOut = (name: string, data: unknown) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2) + "\n");
};

/** Question -> its outcomes (named + fallback), or one outcome if given. */
export async function marketOutcomes(question: number, outcome?: number) {
  const meta = await outcomeMeta();
  const q = meta.questions.find((x) => x.question === question);
  if (!q) throw new Error(`question ${question} not in outcomeMeta`);
  const ids = outcome !== undefined ? [outcome] : [...q.namedOutcomes, q.fallbackOutcome];
  if (outcome !== undefined && !q.namedOutcomes.includes(outcome) && q.fallbackOutcome !== outcome) throw new Error(`outcome ${outcome} not in question ${question}`);
  return { q, outcomes: meta.outcomes.filter((o) => ids.includes(o.outcome)) };
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  // self-check: case-insensitive, deterministic, non-zero
  const x = "0x3bf39e4677efb07a775437b5e4bd6acf12906858";
  console.assert(evmIdentityId(x) === evmIdentityId(x.toUpperCase().replace("0X", "0x")) && evmIdentityId(x) > 0, "evmIdentityId");

  if (cmd === "questions") {
    const m = await outcomeMeta();
    console.log(`${m.outcomes.length} outcomes, ${m.questions.length} questions, ${m.deployers.length} deployers`);
    for (const q of m.questions) console.log(`#${q.question} ${q.name} ${q.description} (${q.namedOutcomes.length} named, settled ${q.settledNamedOutcomes.length})`);
    writeOut("questions.json", { at: new Date().toISOString(), source: INFO, questions: m.questions });
    return;
  }
  if (cmd !== "holders" || !a) throw new Error("usage: hl.ts questions | hl.ts holders <question> [outcome]");
  const { q, outcomes } = await marketOutcomes(Number(a), b === undefined ? undefined : Number(b));
  console.log(`question #${q.question}: ${q.description}`);
  for (const o of outcomes) console.log(`  outcome ${o.outcome} ${o.description} sides ${o.sideSpecs.map((s, i) => `${s.name}=#${10 * o.outcome + i}`).join(" ")}`);
  const r = await outcomeHolders(outcomes.map((o) => o.outcome));
  console.log(`${r.trades} recent trades, ${r.candidates} distinct counterparties, ${r.holders.length} confirmed holders (non-zero "+enc" in spotClearinghouseState):`);
  for (const h of r.holders) console.log(`  ${h.address} id=${evmIdentityId(h.address)} ${JSON.stringify(h.balances)}`);
  writeOut(`holders-q${q.question}${b ? `-o${b}` : ""}.json`, { at: new Date().toISOString(), source: INFO, question: q, outcomes, ...r });
}

if (require.main === module)
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
