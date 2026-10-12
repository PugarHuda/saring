/**
 * Saring x Ethereum L1: rebuild UMA DVM (VotingV2) dispute votes straight from Ethereum mainnet logs and
 * flag voters who held a position in the Polymarket market they voted on. No subgraph, no indexer.
 *
 *   npx tsx uma-onchain.ts --request "Thailand strikes Cambodia"      # question substring (looked up in the report)
 *   npx tsx uma-onchain.ts --request YES_OR_NO_QUERY:1753502405        # identifier + request time (pure L1)
 *   npx tsx uma-onchain.ts --request YES_OR_NO_QUERY-1753502405-0x616e # report request_id / ancillary-hex prefix
 *   npx tsx uma-onchain.ts --verify-report [--top 10] [--all-tallies]  # re-derive report numbers from L1
 *
 * What is read from where:
 *   Ethereum L1 (VotingV2 0x004395ed...34ac): RequestAdded, RequestResolved, VoteCommitted, VoteRevealed logs,
 *     getRoundEndTime(), priceRequests(id).
 *   Polygon (only to find what the hashed L1 ancillary data points at, and who held what):
 *     OracleChildTunnel log at childBlockNumber (keccak-checked against the L1 ancillaryDataHash),
 *     CTF getOutcomeSlotCount / getCollectionId / getPositionId, balanceOfBatch at the block of the last reveal,
 *     Gnosis Safe getOwners().
 *   conflict-report/out/*.json is only used to (a) map a question substring to a request and (b) compare.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseAbi, decodeEventLog, encodeEventTopics, encodeFunctionData, decodeFunctionResult, encodeAbiParameters,
  encodePacked, keccak256, stringToHex, hexToString, toHex, getAddress, getContractAddress, pad, type Hex,
} from 'viem'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPORT = process.env.CONFLICT_REPORT_OUT ?? path.join(HERE, '..', 'conflict-report', 'out')
const CACHE = path.join(HERE, '.cache')
const OUT = path.join(HERE, 'out')
fs.mkdirSync(CACHE, { recursive: true }); fs.mkdirSync(OUT, { recursive: true })

// ---------------------------------------------------------------- constants
// VotingV2 on mainnet, from UMAprotocol/protocol packages/core/networks/1.json ("contractName": "VotingV2").
export const VOTING_V2 = '0x004395edb43EFca9885CEdad51EC9fAf93Bd34ac' as const
export const YES_OR_NO = stringToHex('YES_OR_NO_QUERY', { size: 32 })
const WINDOW_START = Number(process.env.L1_WINDOW_START ?? 1735689600) // 2025-01-01, same window as the report
const E18 = 10n ** 18n

// Polygon (Polymarket) contracts
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'
const USDCE = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296'
const NEG_RISK_OPERATOR = '0x71523d0f655B41E805Cec45b17163f528B59B820'
const NEG_RISK_WCOL = '0x3A3BD7bb9528E159577F7C2e685CC81A765002E2'
const SAFE_FACTORY = '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b'
const SAFE_INIT_HASH = '0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf'

const RPCS: Record<Chain, string[]> = {
  // public endpoints that serve archive eth_getLogs without a key (tested 2026-10-12); override with ETH_RPC=a,b
  eth: (process.env.ETH_RPC ?? 'https://rpc.mevblocker.io,https://mainnet.gateway.tenderly.co,https://eth.drpc.org').split(','),
  poly: (process.env.POLYGON_RPC ?? 'https://polygon.drpc.org,https://polygon.gateway.tenderly.co').split(','),
}
type Chain = 'eth' | 'poly'

export const VOTING_ABI = parseAbi([
  'event VoteCommitted(address indexed voter, address indexed caller, uint32 roundId, bytes32 indexed identifier, uint256 time, bytes ancillaryData)',
  'event VoteRevealed(address indexed voter, address indexed caller, uint32 roundId, bytes32 indexed identifier, uint256 time, bytes ancillaryData, int256 price, uint128 numTokens)',
  'event RequestAdded(address indexed requester, uint32 indexed roundId, bytes32 indexed identifier, uint256 time, bytes ancillaryData, bool isGovernance)',
  'event RequestResolved(uint32 indexed roundId, uint256 indexed resolvedPriceRequestIndex, bytes32 indexed identifier, uint256 time, bytes ancillaryData, int256 price)',
  'function getRoundEndTime(uint256 roundId) view returns (uint256)',
  'function priceRequests(bytes32) view returns (uint32 lastVotingRound, bool isGovernance, uint64 time, uint32 rollCount, bytes32 identifier, bytes ancillaryData)',
])
const POLY_ABI = parseAbi([
  'function getOutcomeSlotCount(bytes32 conditionId) view returns (uint256)',
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)',
  'function getPositionId(address collateralToken, bytes32 collectionId) pure returns (uint256)',
  'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])',
  'function questionIds(bytes32 requestId) view returns (bytes32)',
  'function getConditionId(bytes32 questionId) view returns (bytes32)',
  'function getOwners() view returns (address[])',
])
const topic0 = (name: string) => encodeEventTopics({ abi: VOTING_ABI, eventName: name as any })[0] as Hex

// ---------------------------------------------------------------- JSON-RPC with rotation + adaptive getLogs
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const rr: Record<Chain, number> = { eth: 0, poly: 0 }
const RANGE_ERR = /range|too many|too large|exceed|limit of|max.*(results|logs)|response size|block range|query returned more/i
class RangeError_ extends Error {}

export async function rpc(chain: Chain, method: string, params: unknown[], tries = 10): Promise<any> {
  let last: unknown
  for (let i = 0; i < tries; i++) {
    const url = RPCS[chain][rr[chain]++ % RPCS[chain].length]
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(90_000),
      })
      const txt = await res.text()
      let j: any
      try { j = JSON.parse(txt) } catch { throw new Error(`${url} HTTP ${res.status}: ${txt.slice(0, 100)}`) }
      if (j.error) {
        const msg = String(j.error.message ?? JSON.stringify(j.error))
        if (method === 'eth_getLogs' && RANGE_ERR.test(msg) && !/rate/i.test(msg)) throw new RangeError_(msg)
        throw new Error(`${url}: ${msg}`)
      }
      return j.result
    } catch (e) {
      if (e instanceof RangeError_) throw e
      last = e
      await sleep(400 * (i + 1))
    }
  }
  throw last
}

async function pmap<T, R>(xs: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length); let k = 0
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (k < xs.length) { const i = k++; out[i] = await fn(xs[i], i) }
  }))
  return out
}

async function logsRange(chain: Chain, filter: object, a: number, b: number): Promise<any[]> {
  try {
    return await rpc(chain, 'eth_getLogs', [{ ...filter, fromBlock: toHex(a), toBlock: toHex(b) }])
  } catch (e) {
    if (b > a && e instanceof RangeError_) {
      const m = (a + b) >> 1
      return [...await logsRange(chain, filter, a, m), ...await logsRange(chain, filter, m + 1, b)]
    }
    throw e
  }
}

export async function getLogs(chain: Chain, filter: object, from: number, to: number, step = 5000, conc = 3) {
  const ranges: [number, number][] = []
  for (let b = from; b <= to; b += step) ranges.push([b, Math.min(to, b + step - 1)])
  const parts = await pmap(ranges, conc, ([a, b]) => logsRange(chain, filter, a, b))
  return parts.flat().sort((x, y) => Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) || Number(BigInt(x.logIndex) - BigInt(y.logIndex)))
}

const blkTs = new Map<string, number>()
export async function blockTs(chain: Chain, n: number) {
  const k = chain + n
  if (!blkTs.has(k)) blkTs.set(k, Number((await rpc(chain, 'eth_getBlockByNumber', [toHex(n), false])).timestamp))
  return blkTs.get(k)!
}
const latestMemo: Partial<Record<Chain, { n: number, t: number }>> = {}
export async function latest(chain: Chain) {
  if (!latestMemo[chain]) {
    const b = await rpc(chain, 'eth_getBlockByNumber', ['latest', false])
    latestMemo[chain] = { n: Number(b.number), t: Number(b.timestamp) }
  }
  return latestMemo[chain]!
}
/** first block with timestamp >= ts (interpolation, then bisection) */
export async function blockAt(chain: Chain, ts: number) {
  const bt = chain === 'eth' ? 12 : 2
  const L = await latest(chain)
  if (ts >= L.t) return L.n
  let lo = 0, hi = L.n
  let g = Math.max(1, L.n - Math.ceil((L.t - ts) / bt))
  for (let i = 0; i < 80 && hi - lo > 1; i++) {
    const t = await blockTs(chain, g)
    if (t >= ts) { hi = g; g -= Math.max(1, Math.ceil((t - ts) / bt)) } else { lo = g; g += Math.max(1, Math.floor((ts - t) / bt)) }
    if (g <= lo || g >= hi || i > 6) g = (lo + hi) >> 1
  }
  return hi
}

async function call(chain: Chain, to: string, abi: any, functionName: string, args: any[] = [], block: number | 'latest' = 'latest') {
  const data = encodeFunctionData({ abi, functionName, args } as any)
  const r = await rpc(chain, 'eth_call', [{ to, data }, block === 'latest' ? 'latest' : toHex(block)])
  return decodeFunctionResult({ abi, functionName, data: r } as any) as any
}

const readJson = (p: string, d: any = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
const writeJson = (p: string, v: any) => fs.writeFileSync(p, JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 1))

// ---------------------------------------------------------------- L1 request index (RequestAdded + RequestResolved)
export type L1Request = {
  key: string; rid: string; time: number; ancillary: Hex; priceRequestId: Hex
  added?: { round: number, block: number, tx: Hex, requester: string }
  resolved?: { round: number, block: number, tx: Hex, price: string }
}
export const requestKey = (time: number | bigint, anc: string) => `${time}-${anc.toLowerCase()}`
export const ridOf = (time: number | bigint, anc: string) => `YES_OR_NO_QUERY-${time}-${anc.toLowerCase()}`.slice(0, 80)
export const priceRequestId = (identifier: Hex, time: number | bigint, anc: Hex) =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes' }], [identifier, BigInt(time), anc]))

/** Scans every YES_OR_NO_QUERY RequestAdded/RequestResolved log on VotingV2 since WINDOW_START (incremental, cached). */
export async function requestIndex(log = console.error): Promise<Record<string, L1Request>> {
  const p = path.join(CACHE, 'request-index.json')
  const st = readJson(p, { scannedTo: 0, requests: {} as Record<string, L1Request> })
  const from = st.scannedTo ? st.scannedTo + 1 : await blockAt('eth', WINDOW_START - 7 * 86400)
  const to = (await latest('eth')).n - 5
  if (from <= to) {
    log(`[L1] scanning VotingV2 RequestAdded/RequestResolved logs, blocks ${from}..${to} (${to - from + 1} blocks)`)
    const filter = { address: VOTING_V2, topics: [[topic0('RequestAdded'), topic0('RequestResolved')], null, null, YES_OR_NO] }
    const logs = await getLogs('eth', filter, from, to, 9000, 4)
    for (const l of logs) {
      const ev: any = decodeEventLog({ abi: VOTING_ABI, data: l.data, topics: l.topics })
      const a = ev.args, key = requestKey(a.time, a.ancillaryData)
      const r: L1Request = st.requests[key] ??= {
        key, rid: ridOf(a.time, a.ancillaryData), time: Number(a.time), ancillary: a.ancillaryData,
        priceRequestId: priceRequestId(YES_OR_NO, a.time, a.ancillaryData),
      }
      if (ev.eventName === 'RequestAdded') r.added ??= { round: Number(a.roundId), block: Number(l.blockNumber), tx: l.transactionHash, requester: a.requester }
      else r.resolved = { round: Number(a.roundId), block: Number(l.blockNumber), tx: l.transactionHash, price: a.price.toString() }
    }
    st.scannedTo = to
    writeJson(p, st)
    log(`[L1] ${logs.length} new logs; index holds ${Object.keys(st.requests).length} YES_OR_NO_QUERY requests`)
  }
  return st.requests
}

/** Report ids are `identifier-time-ancillaryHex` cut to 80 chars, so two plain-text requests with the same time can
 *  share one. Disambiguate by the question title (from L1 text, or the keccak-verified Polygon text). */
export function ridResolver(idx: Record<string, L1Request>) {
  const by = new Map<string, L1Request[]>()
  for (const r of Object.values(idx)) by.set(r.rid, [...(by.get(r.rid) ?? []), r])
  return async (rid: string, marketTitle?: string): Promise<L1Request | undefined> => {
    const c = by.get(rid) ?? []
    if (c.length <= 1 || !marketTitle) return c[0]
    for (const r of c) {
      const q = await resolveQuestion(r.ancillary)
      if (q?.text.match(/q: title: (.*?), description:/s)?.[1]?.trim() === marketTitle.trim()) return r
    }
    return undefined
  }
}

// ---------------------------------------------------------------- rounds + reveals
const roundEndMemo = new Map<number, number>()
export async function roundEnd(round: number) {
  if (!roundEndMemo.has(round)) roundEndMemo.set(round, Number(await call('eth', VOTING_V2, VOTING_ABI, 'getRoundEndTime', [BigInt(round)])))
  return roundEndMemo.get(round)!
}

type Ev = { voter: string, round: number, time: number, a: number, price?: string, tokens?: string, block: number, tx: Hex, logIndex: number }
type RoundLogs = { round: number, from: number, to: number, anc: string[], events: Ev[] }

/** All YES_OR_NO_QUERY VoteRevealed (phase='reveal') or VoteCommitted (phase='commit') logs of one voting round. */
export async function roundLogs(round: number, phase: 'reveal' | 'commit' = 'reveal', log = console.error): Promise<RoundLogs> {
  const p = path.join(CACHE, `${phase}-${round}.json`)
  const c = readJson(p); if (c) return c
  const end = await roundEnd(round), len = end - await roundEnd(round - 1)
  const [t0, t1] = phase === 'reveal' ? [end - len / 2, end] : [end - len, end - len / 2]
  const from = await blockAt('eth', t0) - 2, to = await blockAt('eth', t1) + 2
  log(`[L1] round ${round}: fetching ${phase === 'reveal' ? 'VoteRevealed' : 'VoteCommitted'} logs, blocks ${from}..${to}`)
  const ev = phase === 'reveal' ? 'VoteRevealed' : 'VoteCommitted'
  const logs = await getLogs('eth', { address: VOTING_V2, topics: [topic0(ev), null, null, YES_OR_NO] }, from, to, 1500, 4)
  const anc: string[] = [], ai = new Map<string, number>()
  const events: Ev[] = logs.map(l => {
    const a: any = (decodeEventLog({ abi: VOTING_ABI, data: l.data, topics: l.topics }) as any).args
    if (!ai.has(a.ancillaryData)) { ai.set(a.ancillaryData, anc.length); anc.push(a.ancillaryData) }
    return { voter: a.voter.toLowerCase(), round: Number(a.roundId), time: Number(a.time), a: ai.get(a.ancillaryData)!,
      price: a.price?.toString(), tokens: a.numTokens?.toString(), block: Number(l.blockNumber), tx: l.transactionHash, logIndex: Number(l.logIndex) }
  })
  const out = { round, from, to, anc, events }
  if (to < (await latest('eth')).n - 64) writeJson(p, out) // cache only finalized rounds
  return out
}

export type Vote = { voter: string, tokens: bigint, price: bigint, side: string, tx: Hex, block: number }
export const sideOf = (p: bigint) => p === E18 ? 'Yes' : p === 0n ? 'No' : p === E18 / 2n ? '50-50' : 'other'

/** Revealed votes for one request in its deciding round, rebuilt from VoteRevealed logs only. */
export async function revealedVotes(req: L1Request, log = console.error) {
  let round = req.resolved?.round
  let rl: RoundLogs | undefined, evs: Ev[] = []
  if (round === undefined) { // unresolved: walk forward from the round it was added in, keep the last round with reveals
    const now = Math.floor(Date.now() / 1000)
    for (let r = req.added!.round; (await roundEnd(r)) - 172800 < now; r++) {
      const x = await roundLogs(r, 'reveal', log)
      const m = x.events.filter(e => e.time === req.time && x.anc[e.a].toLowerCase() === req.ancillary.toLowerCase())
      if (m.length) { rl = x; evs = m; round = r }
    }
  } else {
    rl = await roundLogs(round, 'reveal', log)
    evs = rl.events.filter(e => e.time === req.time && rl!.anc[e.a].toLowerCase() === req.ancillary.toLowerCase() && e.round === round)
  }
  const byVoter = new Map<string, Vote>()
  for (const e of evs) byVoter.set(e.voter, { voter: e.voter, tokens: BigInt(e.tokens!), price: BigInt(e.price!), side: sideOf(BigInt(e.price!)), tx: e.tx, block: e.block })
  const votes = [...byVoter.values()].sort((a, b) => (b.tokens > a.tokens ? 1 : b.tokens < a.tokens ? -1 : 0))
  const lastBlock = Math.max(0, ...votes.map(v => v.block))
  const lastRevealTime = lastBlock ? await blockTs('eth', lastBlock) : 0
  return { round: round!, votes, lastBlock, lastRevealTime, duplicateReveals: evs.length - votes.length }
}

export function tally(votes: Vote[]) {
  const g = new Map<string, bigint>(); let tot = 0n
  for (const v of votes) { g.set(v.side, (g.get(v.side) ?? 0n) + v.tokens); tot += v.tokens }
  const [winner, w] = [...g.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1))[0] ?? ['-', 0n]
  return { groups: g, total: tot, winner, share: tot ? Number(w * 1_000_000n / tot) / 1e6 : 0 }
}
const uma = (x: bigint) => Number(x / 10n ** 12n) / 1e6

// ---------------------------------------------------------------- Polygon: question text, market, positions
export const safeOf = (eoa: string) => getContractAddress({ opcode: "CREATE2",
  from: SAFE_FACTORY, salt: keccak256(pad(eoa as Hex, { size: 32 })), bytecodeHash: SAFE_INIT_HASH,
}).toLowerCase()

export type Market = { text: string, title: string | null, questionID: Hex | null, ooRequester: string | null,
  conditionId: Hex | null, negRisk: boolean, collateral: string | null, how: string, polygonTx?: Hex,
  names: { Yes: string, No: string } } // outcome index 0 (price 1e18, indexSet 1) / index 1 (price 0, indexSet 2)

/** Polymarket text says "Where p1 corresponds to No, p2 to Yes": p2 (=1e18) is outcome index 0, p1 (=0) is index 1. */
export const outcomeNames = (text: string) => {
  const m = text.match(/p1 corresponds to (.+?), p2 (?:corresponds )?to (.+?)(?:, p3|\.|$)/)
  return { Yes: m?.[2]?.trim() || 'Yes', No: m?.[1]?.trim() || 'No' }
}

/** L1 ancillary of a Polygon-bridged request is "ancillaryDataHash:<h>,childBlockNumber:<n>,childOracle:<a>,...".
 *  The real question is in the OracleChildTunnel log at that Polygon block; accept it only if keccak(text) == h. */
export async function resolveQuestion(anc: Hex): Promise<{ text: string, polygonTx?: Hex } | null> {
  const t = hexToString(anc)
  if (!t.startsWith('ancillaryDataHash:')) return { text: t }
  const p = path.join(CACHE, 'questions.json'); const memo = readJson(p, {})
  if (memo[anc]) return memo[anc]
  const m = Object.fromEntries(t.split(',').map(kv => [kv.slice(0, kv.indexOf(':')), kv.slice(kv.indexOf(':') + 1)]))
  const blk = Number(m.childBlockNumber), oracle = '0x' + m.childOracle, h = ('0x' + m.ancillaryDataHash).toLowerCase()
  const logs: any[] = await rpc('poly', 'eth_getLogs', [{ fromBlock: toHex(blk), toBlock: toHex(blk), address: oracle }])
  for (const l of logs) {
    const raw = Buffer.from(l.data.slice(2), 'hex')
    if (raw.length < 128) continue
    const off = Number(BigInt('0x' + raw.subarray(64, 96).toString('hex')))
    if (off + 32 > raw.length) continue
    const len = Number(BigInt('0x' + raw.subarray(off, off + 32).toString('hex')))
    const bytes = raw.subarray(off + 32, off + 32 + len)
    if (keccak256(bytes).toLowerCase() === h) {
      const v = { text: bytes.toString('utf8'), polygonTx: l.transactionHash }
      memo[anc] = v; writeJson(p, memo); return v
    }
  }
  return null
}

export async function market(anc: Hex, reportConditionId?: string): Promise<Market | null> {
  const q = await resolveQuestion(anc)
  if (!q) return null
  const text = q.text
  const title = text.match(/q: title: (.*?), description:/s)?.[1]?.trim() ?? null
  const i = text.indexOf(',ooRequester:')
  const questionID = i > 0 ? keccak256(stringToHex(text.slice(0, i))) : null
  const ooRequester = i > 0 ? getAddress('0x' + text.slice(i + 13, i + 53)) : null
  const base = { text, title, questionID, ooRequester, polygonTx: q.polygonTx, names: outcomeNames(text) }
  const exists = async (c: Hex) => Number(await call('poly', CTF, POLY_ABI, 'getOutcomeSlotCount', [c])) > 0
  if (questionID && ooRequester) {
    // standard binary market: conditionId = keccak(oracle=adapter, questionId, 2)
    const c = keccak256(encodePacked(['address', 'bytes32', 'uint256'], [ooRequester, questionID, 2n]))
    if (await exists(c)) return { ...base, conditionId: c, negRisk: false, collateral: USDCE, how: 'keccak(ooRequester, questionID, 2) exists on CTF' }
    // neg-risk market: UMA adapter questionID -> NegRiskOperator.questionIds -> NegRiskAdapter.getConditionId
    const nrq = await call('poly', NEG_RISK_OPERATOR, POLY_ABI, 'questionIds', [questionID]) as Hex
    if (BigInt(nrq) !== 0n) {
      const c2 = await call('poly', NEG_RISK_ADAPTER, POLY_ABI, 'getConditionId', [nrq]) as Hex
      if (await exists(c2)) return { ...base, conditionId: c2, negRisk: true, collateral: NEG_RISK_WCOL, how: 'NegRiskOperator.questionIds -> NegRiskAdapter.getConditionId' }
    }
  }
  if (reportConditionId && await exists(reportConditionId as Hex)) // fall back to the report's id, still checked on CTF
    return { ...base, conditionId: reportConditionId as Hex, negRisk: false, collateral: null, how: 'report conditionId (exists on CTF)' }
  return { ...base, conditionId: null, negRisk: false, collateral: null, how: 'not found' }
}

/** ERC-1155 balances (shares, 6 decimals) of each voter's EOA and derived Safe at a Polygon block. */
export async function positionsAt(m: Market, voters: string[], polyBlock: number) {
  const cols = m.collateral ? [m.collateral] : [USDCE, NEG_RISK_WCOL]
  const ids: { outcome: string, id: bigint }[] = []
  for (const [outcome, indexSet] of [['Yes', 1n], ['No', 2n]] as const) {
    const coll = await call('poly', CTF, POLY_ABI, 'getCollectionId', [pad('0x0', { size: 32 }), m.conditionId!, indexSet]) as Hex
    for (const col of cols) ids.push({ outcome, id: await call('poly', CTF, POLY_ABI, 'getPositionId', [col, coll]) })
  }
  const pairs: { voter: string, kind: 'safe' | 'eoa', wallet: string, outcome: string, id: bigint }[] = []
  for (const v of voters) for (const [kind, w] of [['safe', safeOf(v)], ['eoa', v]] as const) for (const x of ids) pairs.push({ voter: v, kind, wallet: w, ...x })
  const chunks: typeof pairs[] = []
  for (let i = 0; i < pairs.length; i += 400) chunks.push(pairs.slice(i, i + 400))
  const bals = (await pmap(chunks, 3, ch => call('poly', CTF, POLY_ABI, 'balanceOfBatch', [ch.map(x => x.wallet), ch.map(x => x.id)], polyBlock))).flat() as bigint[]
  const res = new Map<string, { held: Record<string, number>, via: { kind: string, wallet: string } | null }>()
  pairs.forEach((x, i) => {
    const r = res.get(x.voter) ?? { held: {}, via: null }
    const sh = Number(bals[i]) / 1e6
    if (sh > 0) r.held[x.outcome] = (r.held[x.outcome] ?? 0) + sh
    if (sh >= 1 && !r.via) r.via = { kind: x.kind, wallet: x.wallet }
    res.set(x.voter, r)
  })
  for (const r of res.values()) r.held = Object.fromEntries(Object.entries(r.held).filter(([, s]) => s >= 1).map(([k, s]) => [k, Math.round(s * 100) / 100]))
  return res
}

export async function owners(wallet: string): Promise<string[] | null> {
  try { return ((await call('poly', wallet, POLY_ABI, 'getOwners')) as string[]).map(a => a.toLowerCase()) } catch { return null }
}

// ---------------------------------------------------------------- report data (for lookup + comparison only)
const reportDisputes = () => readJson(path.join(REPORT, 'disputes.json'), []) as any[]
const reportConflicts = () => readJson(path.join(REPORT, 'conflicts.json'), []) as any[]

/** Full on-chain analysis of one request. */
export async function analyseRequest(req: L1Request, opts: { positions?: boolean, commits?: boolean, log?: typeof console.error } = {}) {
  const log = opts.log ?? console.error
  const rv = await revealedVotes(req, log)
  const t = tally(rv.votes)
  const repConf = reportConflicts().filter(c => c.request_id === req.rid)
  const rep = reportDisputes().find(d => d.request_id === req.rid)
  // VotingV2.priceRequests(keccak(abi.encode(identifier,time,ancillary))) proves the id and the deciding round on-chain
  const pr = await call('eth', VOTING_V2, VOTING_ABI, 'priceRequests', [req.priceRequestId])
  const onchainRequest = { lastVotingRound: Number(pr[0]), time: Number(pr[2]), rollCount: Number(pr[3]) }
  let mk: Market | null = null, pos: Awaited<ReturnType<typeof positionsAt>> | null = null, polyBlock = 0
  if (opts.positions !== false) {
    mk = await market(req.ancillary, repConf[0]?.conditionId)
    if (mk?.conditionId && rv.lastRevealTime) {
      polyBlock = await blockAt('poly', rv.lastRevealTime)
      pos = await positionsAt(mk, rv.votes.map(v => v.voter), polyBlock)
    }
  }
  let commits: number | null = null
  if (opts.commits) {
    const cl = await roundLogs(rv.round, 'commit', log)
    commits = new Set(cl.events.filter(e => e.time === req.time && cl.anc[e.a].toLowerCase() === req.ancillary.toLowerCase()).map(e => e.voter)).size
  }
  const rows = rv.votes.map(v0 => {
    let v = v0
    const p = pos?.get(v.voter)
    const nm = (k: string) => (mk?.names as any)?.[k] ?? k
    const held: Record<string, number> = Object.fromEntries(Object.entries(p?.held ?? {}).map(([k, s]) => [nm(k), s]))
    v = { ...v, side: nm(v.side) }
    const heldSides = Object.keys(held)
    const rc = repConf.find(c => c.voter === v.voter)
    return { ...v, safe: safeOf(v.voter), held, via: p?.via ?? null, conflictedOnchain: heldSides.length > 0,
      votedOwnSide: heldSides.length > 0 && v.side === Object.entries(held).sort((a, b) => b[1] - a[1])[0][0],
      conflictedInReport: !!rc, report: rc ?? null }
  })
  return { req, round: rv.round, onchainRequest, lastBlock: rv.lastBlock, lastRevealTime: rv.lastRevealTime, polyBlock,
    duplicateReveals: rv.duplicateReveals, commits, tally: t, market: mk, rows, report: rep ?? null, reportConflicts: repConf }
}

// ---------------------------------------------------------------- CLI
const fmt = (n: number, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })
const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4)
const iso = (t: number) => new Date(t * 1000).toISOString().replace('.000Z', 'Z')

async function findRequests(sel: string, idx: Record<string, L1Request>): Promise<L1Request[]> {
  const all = Object.values(idx)
  let m = sel.match(/^YES_OR_NO_QUERY[-:@](\d{9,11})(?:-(0x[0-9a-fA-F]*))?$/)
  if (m) {
    const time = Number(m[1]), pre = (m[2] ?? '0x').toLowerCase()
    return all.filter(r => r.time === time && r.ancillary.toLowerCase().startsWith(pre))
  }
  if (/^0x[0-9a-fA-F]{64}$/.test(sel)) return all.filter(r => r.priceRequestId.toLowerCase() === sel.toLowerCase())
  // free text: raw L1 ancillary first (non-bridged requests carry the question on L1), then report question titles
  const s = sel.toLowerCase()
  const raw = all.filter(r => hexToString(r.ancillary).toLowerCase().includes(s))
  if (raw.length) return raw
  const rids = new Set(reportDisputes().filter(d => String(d.market).toLowerCase().includes(s)).map(d => d.request_id))
  return all.filter(r => rids.has(r.rid)).sort((a, b) => b.time - a.time)
}

async function cmdRequest(sel: string, args: string[]) {
  const idx = await requestIndex()
  const reqs = await findRequests(sel, idx)
  if (!reqs.length) { console.log(`no YES_OR_NO_QUERY request on VotingV2 matches "${sel}" (window since ${iso(WINDOW_START)})`); process.exit(1) }
  if (reqs.length > 1) {
    console.log(`${reqs.length} matching requests (showing #${Number(arg(args, '--pick') ?? 0)}; choose with --pick n):`)
    reqs.slice(0, 15).forEach((r, i) => console.log(`  [${i}] ${r.rid}  ${reportDisputes().find(d => d.request_id === r.rid)?.market ?? ''}`))
  }
  const req = reqs[Number(arg(args, '--pick') ?? 0)]
  const a = await analyseRequest(req, { commits: true })
  const mk = a.market
  console.log(`\n=== ${mk?.title ?? hexToString(req.ancillary).slice(0, 100)}`)
  console.log(`priceRequestId ${req.priceRequestId}  (keccak(abi.encode(identifier,time,ancillaryData)); VotingV2.priceRequests -> lastVotingRound ${a.onchainRequest.lastVotingRound}, rollCount ${a.onchainRequest.rollCount})`)
  console.log(`request time ${iso(req.time)} | added in round ${req.added?.round} https://etherscan.io/tx/${req.added?.tx}`)
  console.log(`resolved in round ${req.resolved?.round ?? '-'} -> ${req.resolved ? sideOf(BigInt(req.resolved.price)) : 'unresolved'} https://etherscan.io/tx/${req.resolved?.tx ?? ''}`)
  if (mk) console.log(`question from Polygon OracleChildTunnel (keccak-verified vs L1 ancillaryDataHash) tx ${mk.polygonTx ?? '(plain L1 ancillary)'}\nconditionId ${mk.conditionId} via ${mk.how}${mk.negRisk ? ' [negRisk]' : ''}`)
  console.log(`deciding round ${a.round}: ${a.rows.length} revealed votes (${a.commits} committed), ${fmt(uma(a.tally.total))} UMA, winner ${a.tally.winner} ${(a.tally.share * 100).toFixed(2)}%`)
  console.log(`positions read with CTF.balanceOfBatch at Polygon block ${a.polyBlock} (= last reveal ${iso(a.lastRevealTime)}, L1 block ${a.lastBlock})\n`)
  const conf = a.rows.filter(r => r.conflictedOnchain || r.conflictedInReport)
  for (const r of conf) if (r.via?.kind === 'safe' || r.report?.link === 'safe') (r as any).owners = await owners(r.safe)
  const show = args.includes('--all') ? a.rows : [...conf, ...a.rows.filter(r => !conf.includes(r)).slice(0, Number(arg(args, '--limit') ?? 10))]
  console.log(['flag', 'voter', 'UMA', 'vote', 'Polymarket Safe (CREATE2)', 'held at vote (on-chain)', 'report', 'VoteRevealed tx'].join(' | '))
  for (const r of show) {
    const flag = r.conflictedOnchain ? (r.votedOwnSide ? 'CONFLICT*' : 'CONFLICT ') : r.conflictedInReport ? 'report-only' : '         '
    const held = Object.entries(r.held).map(([k, s]) => `${fmt(s)} ${k}`).join(', ') || '-'
    const own = (r as any).owners ? ((r as any).owners.includes(r.voter) ? ' owner✓' : ` owners=${(r as any).owners.map(short).join('/')}`) : ''
    const rep = r.report ? `${r.report.held_shares_at_vote} ${r.report.voted_own_side ? 'own-side' : ''}` : '-'
    console.log([flag, r.voter, fmt(uma(r.tokens), 2), r.side, r.safe + (r.via ? ` [${r.via.kind}]` : '') + own, held, rep, `https://etherscan.io/tx/${r.tx}`].join(' | '))
  }
  if (show.length < a.rows.length) console.log(`… ${a.rows.length - show.length} more non-conflicted voters (--all to list)`)
  const nOn = a.rows.filter(r => r.conflictedOnchain).length
  const confTok = a.rows.filter(r => r.conflictedOnchain).reduce((s, r) => s + r.tokens, 0n)
  console.log(`\nconflicted on-chain: ${nOn} voters, ${fmt(uma(confTok))} UMA (${a.tally.total ? (Number(confTok * 10000n / a.tally.total) / 100).toFixed(2) : 0}% of revealed); report (Data API): ${a.reportConflicts.length}`)
  console.log('* = voted for the outcome it held. CONFLICT = EOA or derived Safe held >= 1 share of either outcome at the last reveal.')
  const f = path.join(OUT, `request-${req.time}-${req.priceRequestId.slice(2, 10)}.json`)
  writeJson(f, { ...a, tally: { ...a.tally, groups: Object.fromEntries(a.tally.groups) } }); console.log(`written ${path.relative(process.cwd(), f)}`)
}

async function cmdVerify(args: string[]) {
  const idx = await requestIndex()
  const resolveRid = ridResolver(idx)
  const disputes = reportDisputes()
  const top = Number(arg(args, '--top') ?? 10)
  const cs = new Set((readJson(path.join(REPORT, 'case_studies.json'), []) as any[]).map(c => c.request_id))
  const chosen = args.includes('--case-studies') ? disputes.filter(d => cs.has(d.request_id))
    : [...disputes].sort((a, b) => b.volume_usd - a.volume_usd).slice(0, top)
  const outName = args.includes('--case-studies') ? 'verify-case-studies.json' : 'verify-report.json'
  const results: any[] = []
  for (const d of chosen) {
    const req = await resolveRid(d.request_id, d.market)
    if (!req) { results.push({ request_id: d.request_id, market: d.market, error: 'request not found in L1 RequestAdded/RequestResolved logs' }); continue }
    console.error(`\n[verify] ${d.market} (${d.vote_round_end_utc})`)
    const a = await analyseRequest(req)
    const t = a.tally
    const nm = (k: string) => (a.market?.names as any)?.[k] ?? k
    const l1Conf = a.rows.filter(r => r.conflictedOnchain)
    const repConfVoters = new Set(a.reportConflicts.map((c: any) => c.voter))
    const l1Voters = new Map(a.rows.map(r => [r.voter, r]))
    // each report conflict row must be a real L1 reveal with the same weight and side, and its wallet must be the CREATE2 Safe/EOA
    const rowChecks = a.reportConflicts.map((c: any) => {
      const v = l1Voters.get(c.voter)
      return { voter: c.voter, onL1: !!v, tokensMatch: !!v && Math.abs(uma(v.tokens) - c.vote_tokens_UMA) < 0.01,
        sideMatch: !!v && v.side === c.voted_for, walletMatch: c.link === 'safe' ? safeOf(c.voter) === c.polymarket_wallet : c.polymarket_wallet === c.voter,
        onchainHeld: v ? (a.rows.find(r => r.voter === c.voter)!.held) : null, reportHeld: c.held_shares_at_vote }
    })
    const cmp = {
      voters: [d.voters, a.rows.length],
      tokens_revealed: [d.tokens_revealed, Math.round(uma(t.total))],
      winner_all: [d.winner_all, nm(t.winner)],
      winner_share_all: [d.winner_share_all, Math.round(t.share * 1e4) / 1e4],
      resolved_outcome: [d.resolved_outcome, req.resolved ? nm(sideOf(BigInt(req.resolved.price))) : null],
      vote_round_end_utc: [d.vote_round_end_utc, a.lastRevealTime ? iso(a.lastRevealTime).slice(0, 10) : null],
      conflicted_voters: [d.conflicted_voters, l1Conf.length],
      conflicted_tokens: [d.conflicted_tokens, Math.round(uma(l1Conf.reduce((s, r) => s + r.tokens, 0n)))],
    }
    const exact = ['voters', 'tokens_revealed', 'winner_all', 'winner_share_all', 'resolved_outcome', 'vote_round_end_utc'] as const
    const mismatches = exact.filter(k => String(cmp[k][0]) !== String(cmp[k][1]))
      .filter(k => !(k === 'winner_share_all' && Math.abs(Number(cmp[k][0]) - Number(cmp[k][1])) <= 1e-4))
    results.push({
      request_id: d.request_id, market: d.market, volume_usd: d.volume_usd, priceRequestId: req.priceRequestId,
      round: a.round, onchainLastVotingRound: a.onchainRequest.lastVotingRound, resolvedTx: req.resolved?.tx,
      conditionId: a.market?.conditionId, conditionHow: a.market?.how, polyBlock: a.polyBlock,
      compare: cmp, voteMismatches: mismatches,
      reportRowsVerified: rowChecks.filter((c: any) => c.onL1 && c.tokensMatch && c.sideMatch && c.walletMatch).length,
      reportRows: rowChecks.length, rowChecks,
      onlyOnchain: l1Conf.filter(r => !repConfVoters.has(r.voter)).map(r => ({ voter: r.voter, held: r.held, via: r.via, tokens: uma(r.tokens), side: r.side })),
      onlyReport: [...repConfVoters].filter(v => !l1Conf.find(r => r.voter === v)),
    })
  }
  let tallies: any = null
  if (args.includes('--all-tallies')) tallies = await verifyAllTallies(resolveRid, disputes)
  const summary = {
    generated_utc: new Date().toISOString(), votingV2: VOTING_V2, rpc: RPCS.eth,
    disputes_checked: results.length,
    vote_tallies_exact_match: results.filter(r => !r.error && r.voteMismatches.length === 0).length,
    report_conflict_rows_verified_on_L1: `${results.reduce((s, r) => s + (r.reportRowsVerified ?? 0), 0)}/${results.reduce((s, r) => s + (r.reportRows ?? 0), 0)}`,
    conflicted_voters_report_vs_onchain: results.map(r => r.compare ? `${r.compare.conflicted_voters[0]}→${r.compare.conflicted_voters[1]}` : 'n/a').join(', '),
    all_tallies: tallies?.summary ?? null,
  }
  writeJson(path.join(OUT, outName), { summary, results, all_tallies_mismatches: tallies?.mismatches ?? null })
  console.log('\n| # | market | round | voters rpt/L1 | UMA revealed rpt/L1 | winner share rpt/L1 | resolved | conflicted rpt (Data API) / on-chain balance | report rows verified on L1 |')
  console.log('|---|---|---|---|---|---|---|---|---|')
  results.forEach((r, i) => r.error ? console.log(`| ${i + 1} | ${r.market} | ERROR ${r.error} |`) : console.log(
    `| ${i + 1} | ${r.market} | ${r.round} | ${r.compare.voters.join(' / ')} | ${r.compare.tokens_revealed.map((x: number) => fmt(x)).join(' / ')} | ${r.compare.winner_share_all.join(' / ')} | ${r.compare.resolved_outcome.join(' / ')} | ${r.compare.conflicted_voters.join(' / ')} | ${r.reportRowsVerified}/${r.reportRows} |`))
  console.log('\n' + JSON.stringify(summary, null, 1))
  for (const r of results) if (r.voteMismatches?.length) console.log(`MISMATCH ${r.market}: ${r.voteMismatches.map((k: string) => `${k} ${JSON.stringify(r.compare[k])}`).join('; ')}`)
}

/** Every report dispute: voters + revealed UMA + winner recomputed from VoteRevealed logs (no Polygon). */
async function verifyAllTallies(resolveRid: ReturnType<typeof ridResolver>, disputes: any[]) {
  const reqs = await pmap(disputes, 4, async d => ({ d, r: await resolveRid(d.request_id, d.market) }))
  const rounds = [...new Set(reqs.filter(x => x.r?.resolved).map(x => x.r!.resolved!.round))].sort()
  console.error(`[all] ${disputes.length} disputes across ${rounds.length} rounds`)
  let done = 0
  await pmap(rounds, 2, async r => { await roundLogs(r, 'reveal', () => {}); if (++done % 20 === 0) console.error(`[all] rounds ${done}/${rounds.length}`) })
  const mismatches: any[] = []; let ok = 0, missing = 0
  for (const { d, r } of reqs) {
    if (!r?.resolved) { missing++; mismatches.push({ request_id: d.request_id, market: d.market, issue: 'not found/resolved on L1' }); continue }
    const rv = await revealedVotes(r, () => {}); const t = tally(rv.votes)
    const got = { voters: rv.votes.length, tokens_revealed: Math.round(uma(t.total)), winner_share_all: Math.round(t.share * 1e4) / 1e4 }
    const bad = d.voters !== got.voters || Math.abs(d.tokens_revealed - got.tokens_revealed) > 1 || Math.abs(d.winner_share_all - got.winner_share_all) > 1e-4
    if (bad) mismatches.push({ request_id: d.request_id, market: d.market, report: { voters: d.voters, tokens_revealed: d.tokens_revealed, winner_share_all: d.winner_share_all }, l1: got })
    else ok++
  }
  return { summary: { disputes: disputes.length, exact_match: ok, mismatched: mismatches.length - missing, not_on_L1: missing }, mismatches }
}

function arg(args: string[], k: string) { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--verify-report')) return cmdVerify(args)
  const sel = arg(args, '--request')
  if (sel) return cmdRequest(sel, args)
  if (args.includes('--index')) { const idx = await requestIndex(); const v = Object.values(idx)
    const inWin = v.filter(r => r.time > WINDOW_START)
    console.log(JSON.stringify({ requests: v.length, in_window: inWin.length, resolved_in_window: inWin.filter(r => r.resolved).length }, null, 1)); return }
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1) })
}
