/**
 * Header-anchored proofs for the 70 conflicted VoteRevealed rows of the case studies (out/verify-case-studies.json).
 *
 *   npx tsx prove-votes.ts             # build out/vote-proofs.json (eth_getBlockByNumber + eth_getBlockReceipts)
 *   npx tsx prove-votes.ts --verify    # re-check the bundle: only RPC used is eth_getBlockByNumber (block hashes)
 *   npx tsx prove-votes.ts --verify --offline   # no RPC at all; you supply trust in the bundled block hashes
 *
 * Per row: keccak(RLP(header)) == blockHash, receipt-trie Merkle-Patricia proof (rebuilt from all receipts of the
 * block) verifies against header.receiptsRoot, and the VoteRevealed log inside the proven receipt decodes to the
 * claimed voter / roundId / identifier / price / numTokens and to the case study's priceRequestId.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Trie } from '@ethereumjs/trie'
import { decodeEventLog, fromRlp, hexToBytes, bytesToHex, keccak256, toRlp, numberToHex, type Hex } from 'viem'
import { roundLogs, rpc, priceRequestId, VOTING_ABI, VOTING_V2, YES_OR_NO } from './uma-onchain.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CASES = path.join(HERE, 'out', 'verify-case-studies.json')
const BUNDLE = path.join(HERE, 'out', 'vote-proofs.json')
const RPCS = (process.env.ETH_RPC ?? 'https://rpc.mevblocker.io,https://mainnet.gateway.tenderly.co,https://eth.drpc.org').split(',')

// ---------------------------------------------------------------- RLP of headers and receipts
const q = (x?: Hex | null): Hex => { // JSON-RPC quantity -> minimal big-endian bytes (0 -> empty)
  const s = BigInt(x ?? 0).toString(16)
  return s === '0' ? '0x' : `0x${s.length % 2 ? '0' : ''}${s}`
}
// Header field order through Prague; trailing optional fields are included when the node returns them.
const HEADER: [string, 'h' | 'n'][] = [['parentHash', 'h'], ['sha3Uncles', 'h'], ['miner', 'h'], ['stateRoot', 'h'],
  ['transactionsRoot', 'h'], ['receiptsRoot', 'h'], ['logsBloom', 'h'], ['difficulty', 'n'], ['number', 'n'],
  ['gasLimit', 'n'], ['gasUsed', 'n'], ['timestamp', 'n'], ['extraData', 'h'], ['mixHash', 'h'], ['nonce', 'h'],
  ['baseFeePerGas', 'n'], ['withdrawalsRoot', 'h'], ['blobGasUsed', 'n'], ['excessBlobGas', 'n'],
  ['parentBeaconBlockRoot', 'h'], ['requestsHash', 'h']]
const OPTIONAL_FROM = 15
export function headerRlp(b: any): Hex {
  const f = HEADER.filter(([k], i) => i < OPTIONAL_FROM || b[k] != null).map(([k, t]) => t === 'n' ? q(b[k]) : b[k] as Hex)
  return toRlp(f)
}
export function receiptRlp(r: any): Hex {
  const body = toRlp([q(r.status), q(r.cumulativeGasUsed), r.logsBloom, r.logs.map((l: any) => [l.address, l.topics, l.data])])
  return Number(r.type) === 0 ? body : `0x${Number(r.type).toString(16).padStart(2, '0')}${body.slice(2)}` as Hex
}
const trieKey = (txIndex: number) => hexToBytes(toRlp(q(numberToHex(txIndex))))

// ---------------------------------------------------------------- verification of one row (shared by build and --verify)
type Row = { case: number, voter: string, priceRequestId: Hex, block: number, tx: Hex, txIndex: number, logPos: number,
  claimed: { roundId: number, price: string, numTokens: string }, proof: Hex[] }
type Bundle = { summary: any, blocks: Record<string, { hash: Hex, header: Hex }>, rows: Row[] }

export async function verifyRow(row: Row, blk: { hash: Hex, header: Hex }) {
  if (keccak256(blk.header) !== blk.hash) throw new Error('keccak(RLP(header)) != blockHash')
  const h = fromRlp(blk.header, 'hex') as Hex[]
  if (BigInt(h[8] === '0x' ? 0 : h[8]) !== BigInt(row.block)) throw new Error('header number mismatch')
  const value = await new Trie().verifyProof(hexToBytes(h[5]), trieKey(row.txIndex), row.proof.map(hexToBytes))
  if (!value) throw new Error('receipt not in receiptsRoot')
  const enc = bytesToHex(value)
  const typed = value[0] < 0x80
  const [status, , , logs] = fromRlp(typed ? `0x${enc.slice(4)}` : enc, 'hex') as any[]
  if (status !== '0x01') throw new Error('receipt status != 1')
  const [address, topics, data] = logs[row.logPos]
  if (address.toLowerCase() !== VOTING_V2.toLowerCase()) throw new Error('log not emitted by VotingV2')
  const ev: any = decodeEventLog({ abi: VOTING_ABI, data, topics })
  const a = ev.args
  const got = { eventName: ev.eventName, voter: a.voter.toLowerCase(), roundId: Number(a.roundId), identifier: a.identifier,
    price: a.price.toString(), numTokens: a.numTokens.toString(), priceRequestId: priceRequestId(a.identifier, a.time, a.ancillaryData) }
  const bad = [
    got.eventName !== 'VoteRevealed' && 'event', got.voter !== row.voter && 'voter', got.identifier !== YES_OR_NO && 'identifier',
    got.roundId !== row.claimed.roundId && 'roundId', got.price !== row.claimed.price && 'price',
    got.numTokens !== row.claimed.numTokens && 'numTokens', got.priceRequestId !== row.priceRequestId && 'priceRequestId',
  ].filter(Boolean)
  if (bad.length) throw new Error(`decoded log mismatch: ${bad.join(',')}`)
  return got
}

async function at(url: string, method: string, params: unknown[]) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) })
      const j: any = await r.json(); if (j.error) throw new Error(j.error.message); return j.result
    } catch (e) { if (i === 3) throw e; await new Promise(r => setTimeout(r, 800 * (i + 1))) }
  }
}
/** canonical block hash per RPC; 'agree' only when every reachable RPC returns the same hash */
async function canonicalHash(n: number) {
  const got = await Promise.all(RPCS.map(u => at(u, 'eth_getBlockByNumber', [numberToHex(n), false]).then(b => b?.hash as Hex, () => null)))
  const ok = got.filter(Boolean) as Hex[]
  return { hash: ok[0], agree: ok.length > 0 && ok.every(x => x === ok[0]), sources: ok.length }
}

// ---------------------------------------------------------------- build
async function build() {
  const cs = JSON.parse(fs.readFileSync(CASES, 'utf8'))
  const rows: Row[] = [], blocks: Bundle['blocks'] = {}, failures: any[] = []
  const targets: { case: number, voter: string, pid: Hex, ev: any }[] = []
  for (const [i, c] of cs.results.entries()) {
    const rl = await roundLogs(c.round, 'reveal')
    for (const rc of c.rowChecks) {
      const ev = rl.events.find((e: any) => e.voter === rc.voter && priceRequestId(YES_OR_NO, e.time, rl.anc[e.a] as Hex) === c.priceRequestId)
      if (ev) targets.push({ case: i, voter: rc.voter, pid: c.priceRequestId, ev: { ...ev, round: c.round } })
      else failures.push({ case: i, voter: rc.voter, error: 'no VoteRevealed log for this voter/request in the round' })
    }
  }
  const byBlock = new Map<number, typeof targets>()
  for (const t of targets) byBlock.set(t.ev.block, [...(byBlock.get(t.ev.block) ?? []), t])
  console.error(`[prove] ${targets.length} reveals in ${byBlock.size} blocks`)
  let k = 0
  for (const [n, ts] of byBlock) {
    try {
      const canon = await canonicalHash(n)
      if (!canon.agree || canon.sources < 2) throw new Error(`block hash not agreed by >=2 RPCs (${canon.sources})`)
      const b = await rpc('eth', 'eth_getBlockByNumber', [numberToHex(n), false])
      const header = headerRlp(b)
      if (keccak256(header) !== canon.hash) throw new Error('header RLP does not hash to canonical block hash')
      const receipts: any[] = await rpc('eth', 'eth_getBlockReceipts', [numberToHex(n)])
      const trie = new Trie()
      for (const r of receipts) await trie.put(trieKey(Number(r.transactionIndex)), hexToBytes(receiptRlp(r)))
      if (bytesToHex(trie.root()) !== b.receiptsRoot) throw new Error('rebuilt receipts trie root != header.receiptsRoot')
      blocks[n] = { hash: canon.hash, header }
      for (const t of ts) {
        const r = receipts.find(x => x.transactionHash === t.ev.tx)
        const logPos = r?.logs.findIndex((l: any) => Number(l.logIndex) === t.ev.logIndex) ?? -1
        if (!r || logPos < 0) { failures.push({ case: t.case, voter: t.voter, error: 'tx/log not in block receipts' }); continue }
        const row: Row = { case: t.case, voter: t.voter, priceRequestId: t.pid, block: n, tx: t.ev.tx, txIndex: Number(r.transactionIndex),
          logPos, claimed: { roundId: t.ev.round, price: t.ev.price, numTokens: t.ev.tokens },
          proof: (await trie.createProof(trieKey(Number(r.transactionIndex)))).map(x => bytesToHex(x)) }
        await verifyRow(row, blocks[n])
        rows.push(row)
      }
    } catch (e: any) { for (const t of ts) failures.push({ case: t.case, voter: t.voter, block: n, error: e.message }) }
    if (++k % 10 === 0) console.error(`[prove] blocks ${k}/${byBlock.size}`)
  }
  const expected = cs.results.reduce((s: number, r: any) => s + r.rowChecks.length, 0)
  const summary = { generated_utc: new Date().toISOString(), votingV2: VOTING_V2, source: 'out/verify-case-studies.json',
    rows_expected: expected, rows_proven: rows.length, blocks: Object.keys(blocks).length, failures,
    cases: cs.results.map((c: any, i: number) => ({ case: i, market: c.market, round: c.round, priceRequestId: c.priceRequestId })),
    trust: 'block hashes only: header hash cross-checked on ' + RPCS.join(', ') }
  fs.writeFileSync(BUNDLE, JSON.stringify({ summary, blocks, rows }))
  console.log(`${rows.length}/${expected} conflicted VoteRevealed rows proven against mainnet block headers (${Object.keys(blocks).length} blocks); ${failures.length} failures`)
  for (const f of failures) console.log('FAIL', JSON.stringify(f))
  console.log(`written ${path.relative(process.cwd(), BUNDLE)} (${(fs.statSync(BUNDLE).size / 1024).toFixed(0)} KB)`)
}

// ---------------------------------------------------------------- verify (no receipts RPC; headers only, or none with --offline)
async function verify(offline: boolean) {
  const b: Bundle = JSON.parse(fs.readFileSync(BUNDLE, 'utf8'))
  let ok = 0; const bad: string[] = []
  const anchored = new Map<string, boolean>()
  if (!offline) for (const n of Object.keys(b.blocks)) {
    const c = await canonicalHash(Number(n))
    anchored.set(n, c.agree && c.hash === b.blocks[n].hash)
  }
  for (const r of b.rows) {
    try {
      await verifyRow(r, b.blocks[r.block])
      if (!offline && !anchored.get(String(r.block))) throw new Error('bundled block hash is not the canonical mainnet hash')
      ok++
    } catch (e: any) { bad.push(`${r.voter} block ${r.block}: ${e.message}`) }
  }
  console.log(`${ok}/${b.rows.length} rows verify (${offline ? 'offline: bundled headers trusted' : `block hashes checked against ${RPCS.length} RPCs`})`)
  for (const x of bad) console.log('FAIL', x)
  if (bad.length || ok !== b.summary.rows_expected) process.exit(1)
}

const args = process.argv.slice(2)
;(args.includes('--verify') ? verify(args.includes('--offline')) : build()).catch(e => { console.error(e); process.exit(1) })
