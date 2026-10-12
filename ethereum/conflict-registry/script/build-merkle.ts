/**
 * Builds the UmaConflictRegistry Merkle tree from conflict-report/out/conflicts.json (= conflicts.csv rows).
 * Every row's request_id is resolved to the full UMA request (identifier, time, ancillaryData) using the
 * RequestAdded/RequestResolved logs of VotingV2 on Ethereum mainnet, so disputeId is UMA's own priceRequestId.
 *
 *   npx tsx conflict-registry/script/build-merkle.ts
 * Outputs (conflict-registry/data/): root.json, proofs.json, disputes.json, merkle-tree.json, fixture.json
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { StandardMerkleTree } from '@openzeppelin/merkle-tree'
import { requestIndex, ridResolver, REPORT, YES_OR_NO, type L1Request } from '../../uma-onchain.ts'

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')
fs.mkdirSync(DATA, { recursive: true })

const conflicts: any[] = JSON.parse(fs.readFileSync(path.join(REPORT, 'conflicts.json'), 'utf8'))
const csv = fs.readFileSync(path.join(REPORT, 'conflicts.csv'))
const datasetHash = '0x' + crypto.createHash('sha256').update(csv).digest('hex')
const csvRows = csv.toString('utf8').trim().split('\n').length - 1

const idx = await requestIndex()
const resolveRid = ridResolver(idx)
const memo = new Map<string, L1Request | undefined>()
const lookup = async (c: any) => {
  const k = c.request_id + '|' + c.market
  if (!memo.has(k)) memo.set(k, await resolveRid(c.request_id, c.market))
  return memo.get(k)
}

const leaves = new Map<string, [string, string]>()
const disputes: Record<string, any> = {}
const unmapped: any[] = []
for (const c of conflicts) {
  const r = await lookup(c)
  if (!r) { unmapped.push(c.request_id); continue }
  const id = r.priceRequestId
  leaves.set(`${id}-${c.voter}`, [id, c.voter])
  const d = disputes[id] ??= { request_id: c.request_id, market: c.market, conditionId: c.conditionId, identifier: YES_OR_NO,
    time: r.time, ancillaryData: r.ancillary, decidingRound: r.resolved?.round, resolvedTx: r.resolved?.tx, voters: [] as string[] }
  if (!d.voters.includes(c.voter)) d.voters.push(c.voter)
}
const values = [...leaves.values()].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]))
const tree = StandardMerkleTree.of(values, ['bytes32', 'address'])

const proofs: Record<string, Record<string, string[]>> = {}
for (const [i, v] of tree.entries()) (proofs[v[0]] ??= {})[v[1]] = tree.getProof(i)

const root = {
  root: tree.root, datasetHash, leafCount: values.length, disputeCount: Object.keys(disputes).length,
  conflictRows: conflicts.length, csvRows, unmappedRows: unmapped.length,
  leafEncoding: 'keccak256(bytes.concat(keccak256(abi.encode(bytes32 disputeId, address voter))))',
  disputeId: 'UMA VotingV2 priceRequestId = keccak256(abi.encode(bytes32 identifier, uint256 time, bytes ancillaryData))',
  source: 'conflict-report/out/conflicts.csv', generated_utc: new Date().toISOString(),
}
fs.writeFileSync(path.join(DATA, 'root.json'), JSON.stringify(root, null, 1))
fs.writeFileSync(path.join(DATA, 'proofs.json'), JSON.stringify(proofs))
fs.writeFileSync(path.join(DATA, 'disputes.json'), JSON.stringify(disputes, null, 1))
fs.writeFileSync(path.join(DATA, 'merkle-tree.json'), JSON.stringify(tree.dump()))

// Forge fixture: real proofs from the report's case studies + a real non-conflicted voter (biggest whale of the Thailand dispute)
const cases = JSON.parse(fs.readFileSync(path.join(REPORT, 'case_studies.json'), 'utf8')).slice(0, 3).map((c: any) => {
  const r = memo.get(c.request_id + '|' + c.market)!
  return { name: c.market, disputeId: r.priceRequestId, voter: c.voter, proof: proofs[r.priceRequestId][c.voter],
    identifier: YES_OR_NO, time: r.time, ancillaryData: r.ancillary }
})
const fixture = { root: tree.root, datasetHash, leafCount: values.length, disputeCount: Object.keys(disputes).length,
  cases, nonConflictedVoter: '0xb524735356985d2f267fa010d681f061dff03715' }
fs.writeFileSync(path.join(DATA, 'fixture.json'), JSON.stringify(fixture, null, 1))
console.log(JSON.stringify(root, null, 1))
if (unmapped.length) console.log('unmapped request ids:', [...new Set(unmapped)].slice(0, 10))
