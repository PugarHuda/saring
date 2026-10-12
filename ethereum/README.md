# Saring on Ethereum L1: UMA conflicts checked against the chain, with no indexer

The [Conflict Report](../conflict-report/README.md) finds UMA DVM voters who held a position in the Polymarket market they were voting on. It gets its votes from the Goldsky subgraph and its positions from Polymarket's Data API. This folder rebuilds the same numbers from **Ethereum mainnet logs** and checks positions against **Polygon contract state**, so a reader doesn't have to trust our indexer, Goldsky or Polymarket's API. It then commits the whole conflicted-voter set to an **L1 contract** (`UmaConflictRegistry`) that any contract or UI can query with a Merkle proof.

```
Ethereum L1  VotingV2 0x004395ed…34ac   RequestAdded / RequestResolved / VoteCommitted / VoteRevealed logs,
                                        getRoundEndTime(), priceRequests(id)
      │  ancillaryData = "ancillaryDataHash:<h>,childBlockNumber:<n>,childOracle:<a>,…"
      ▼
Polygon      OracleChildTunnel log @ n  → question text, accepted only if keccak(text) == h
             CTF 0x4D97…6045            → conditionId exists? positionIds; balanceOfBatch(EOA+Safe) @ block of last reveal
             Safe(voter) = CREATE2(0xaacF…541b, keccak(voter), initHash) → getOwners() == voter
      ▼
Ethereum     UmaConflictRegistry        root of {(UMA priceRequestId, voter)} → isConflicted(id, voter, proof)
```

## What is read from L1

| Item | Source |
|---|---|
| Contract | `VotingV2` at `0x004395edb43EFca9885CEdad51EC9fAf93Bd34ac`, taken from UMA's own deployment list [`packages/core/networks/1.json`](https://github.com/UMAprotocol/protocol/blob/master/packages/core/networks/1.json). VotingV2 emits `RequestAdded`. `PriceRequestAdded` is the old Voting v1 name. |
| All disputes | Every `RequestAdded` and `RequestResolved` log with `identifier = YES_OR_NO_QUERY` since 2025-01-01. That is 4.7 M blocks, fetched in 9k-block chunks and cached incrementally. Each log gives `time`, the full `ancillaryData`, the deciding `roundId` and the resolved `price`. |
| Dispute id | `priceRequestId = keccak256(abi.encode(identifier, time, ancillaryData))`. We check it by calling `VotingV2.priceRequests(id)`, which returns `lastVotingRound`; this matched the `RequestResolved` round on every dispute we checked. |
| Votes | `VoteRevealed(voter, caller, roundId, identifier, time, ancillaryData, price, numTokens)` during the reveal phase of the deciding round. The window comes from `getRoundEndTime(round)` and `getRoundEndTime(round-1)`, and timestamps are mapped to blocks by bisection. `VoteCommitted` is read too, so we can count commits that were never revealed. |
| Vote → side | `price` 1e18 → outcome 0 (Yes), 0 → outcome 1 (No), 0.5e18 → 50-50, anything else → "other" (for example the "too early" value). Outcome names come from the question text ("p1 corresponds to …"). |
| Cut-off time | The timestamp of the block holding the last `VoteRevealed` for that request. This is the same definition as the report's `lastRevealTime`. |

Polygon is read only for two things: what the hashed L1 ancillary data points to, and who held what.

- **Question.** It comes from the `OracleChildTunnel` log at `childBlockNumber`, and is accepted only if `keccak(text)` equals the L1 `ancillaryDataHash`.
- **Market.** `questionID = keccak(text before ",ooRequester:")`.
  - A standard market has `conditionId = keccak(ooRequester, questionID, 2)`, and we check that `getOutcomeSlotCount > 0`.
  - A neg-risk market goes through `NegRiskOperator.questionIds(questionID)` and then `NegRiskAdapter.getConditionId`, with WrappedCollateral as the collateral.
- **Position at the vote.** We read `CTF.balanceOfBatch([EOA, Safe] × [Yes, No])` as an archive `eth_call` at the first Polygon block at or after the cut-off. "Conflicted" means at least 1 share of either outcome. This is the balance itself, not a reconstruction from trades.
- **Ownership.** For every flagged Safe we call `getOwners()` and check that it equals the voter address (shown as "owner✓").

`conflict-report/out/*.json` is used only to turn a question substring into a request, and as the thing we compare against.

## Commands

Run from `ethereum/`. Needs Node 22. Foundry is only needed for the registry.

```bash
npm install
# one dispute, by question substring, report request_id, identifier:time, or priceRequestId
npx tsx uma-onchain.ts --request "Thailand strikes Cambodia by Friday" --pick 1
npx tsx uma-onchain.ts --request YES_OR_NO_QUERY:1753502405          # pure L1 lookup (identifier + time)
npx tsx uma-onchain.ts --request "Honduran general election be between 60% and 65%" --all
# re-derive the report from L1
npx tsx uma-onchain.ts --verify-report --top 10                       # 10 largest disputes by volume (+ Polygon positions)
npx tsx uma-onchain.ts --verify-report --case-studies                 # the 10 case studies
npx tsx uma-onchain.ts --verify-report --top 10 --all-tallies         # + every dispute's tally (voters, UMA, winner share)
npx tsx uma-onchain.ts --index                                        # just build/refresh the L1 request index
# header-anchored receipt proofs for the 70 case-study conflict rows
npx tsx prove-votes.ts                                                # build out/vote-proofs.json
npx tsx prove-votes.ts --verify [--offline]                           # re-check; RPC only for block hashes (none with --offline)
# registry
npx tsx conflict-registry/script/build-merkle.ts                      # root + proofs from conflicts.csv
cd conflict-registry && forge install foundry-rs/forge-std --no-git && forge test -vv
./deploy.sh                                                           # Sepolia (needs funded key, see below)
```

The default RPCs are `rpc.mevblocker.io`, `mainnet.gateway.tenderly.co` and `eth.drpc.org` for Ethereum, and `polygon.drpc.org` and `polygon.gateway.tenderly.co` for Polygon. On 2026-10-12 these were the keyless endpoints that served archive `eth_getLogs` and `eth_call`. publicnode, ankr and llamarpc now need a key or fail. Override them with `ETH_RPC=url1,url2` and `POLYGON_RPC=…`. If an RPC rejects a range, the chunk is split in half and retried. Logs are cached in `.cache/`: the request index, one file per round for reveals and commits, and the Polygon question texts.

The `--request` output has one row per revealed vote: flag, voter, UMA weight, vote, the CREATE2 Safe with `[safe|eoa]` showing where shares were found and `owner✓`, the on-chain holding at the vote, the report's Data-API holding, and `https://etherscan.io/tx/<VoteRevealed tx>`. The full result is written to `out/request-<time>-<id>.json`.

## Results (run 2026-10-12)

**Request index.** From L1 we found 4,453 resolved `YES_OR_NO_QUERY` requests with `time` after 2025-01-01. The report's `uma_yes_no_requests_resolved` is also **4,453**.

**10 largest disputes by market volume** (`out/verify-report.json`): **10/10 vote tallies match exactly.**

| # | market | round | voters report/L1 | UMA revealed report/L1 | winner share | resolved | conflicted: report (Data API) / on-chain balance | report rows confirmed on L1 |
|---|---|---|---|---|---|---|---|---|
| 1 | MicroStrategy sells any Bitcoin by May 31, 2026? | 10303 | 607 / 607 | 19,433,398 / 19,433,398 | 0.986 / 0.986 | No / No | 14 / 14 | 14/14 |
| 2 | MicroStrategy sells any Bitcoin by May 31, 2026? (2nd request) | 10303 | 607 / 607 | 19,433,398 / 19,433,398 | 0.9861 / 0.9861 | No / No | 14 / 14 | 14/14 |
| 3 | US forces enter Iran by April 30? | 10274 | 619 / 619 | 17,065,082 / 17,065,082 | 1 / 1 | other / other | 6 / 6 | 6/6 |
| 4 | US forces enter Iran by April 30? | 10275 | 635 / 635 | 17,237,963 / 17,237,963 | 0.9992 / 0.9992 | Yes / Yes | 11 / 11 | 11/11 |
| 5 | Will Zelenskyy wear a suit before July? | 10120 | 256 / 256 | 23,382,873 / 23,382,873 | 0.9909 / 0.9909 | other / other | 1 / 1 | 1/1 |
| 6 | Will Zelenskyy wear a suit before July? | 10121 | 193 / 193 | 20,643,340 / 20,643,340 | 0.9387 / 0.9387 | other / other | 1 / 1 | 1/1 |
| 7 | Will Zelenskyy wear a suit before July? | 10133 | 286 / 286 | 23,245,879 / 23,245,879 | 0.9274 / 0.9274 | other / other | 11 / 11 | 11/11 |
| 8 | Will Zelenskyy wear a suit before July? | 10136 | 287 / 287 | 22,757,385 / 22,757,385 | 0.9376 / 0.9376 | other / other | 18 / 18 | 18/18 |
| 9 | Will Zelenskyy wear a suit before July? | 10138 | 243 / 243 | 19,286,638 / 19,286,638 | 0.9325 / 0.9325 | No / No | 19 / 19 | 19/19 |
| 10 | US x Iran ceasefire extended by April 22, 2026? | 10284 | 612 / 612 | 18,184,837 / 18,184,837 | 0.9956 / 0.9956 | other / other | 1 / 1 | 1/1 |

Across these 10 disputes we checked 96 report conflict rows. All 96 are real L1 reveals with the same UMA weight and side, and the same CREATE2 Safe. For all 96 rows, the on-chain balance at the cut-off equals the Data API's reconstructed share count to the cent; for example `0xacb1…6272` holds 1,123,510.42 YES both ways. The conflicted-voter sets are identical, with nobody found only on-chain and nobody found only in the report.

**The 10 case studies** (`out/verify-case-studies.json`): 10/10 tallies match, and 70/70 conflict rows are confirmed on L1 (vote weight, side and Safe). All flagged Safes pass `getOwners() == voter`. Holdings match to the cent for 65 of the 70 rows. Of the other 5, 4 are the shutdown case below. The fifth is `0x86cc…273d` on "US or Israel strike Iran first?": the report has 1 Israel share, and on-chain shows 1 Israel plus 1 US, which is still a conflict either way.

**One honest mismatch: "Will the government shutdown end November 12?"** (neg-risk, round 10203). The report flags 7 conflicted voters, but on-chain balances confirm only 3. The other 4 are `0x86cc…273d`, `0x81f9…2ac0`, `0x790b…f04f` and `0x89db…3b7e`, and the report says all 4 held **No**. On-chain, 2 of them visibly held No one day before the cut-off (`0x81f9` 270.27, `0x790b` 1,659.63) and held nothing at the last reveal (Polygon block 79,071,919). The Data API trade history doesn't record what removed those shares. That fits a neg-risk `convertPositions` or a transfer, which the report already lists as not counted. For `0x86cc` we found no No balance at any point we sampled (30, 7, 3 and 1 days before the cut-off, and at the cut-off). `0x89db` has no on-chain balance at the cut-off; we didn't sample it at earlier points. The votes themselves (weight, side) match L1. So for this dispute the report overstates conflicts at the cut-off by 4 voters.

**All 4,121 report disputes, tallies only** (`--all-tallies`): **4,079 of 4,121** match exactly (voters, revealed UMA within 1 token, winner share within 0.0001), **42 differ**, and 0 are missing from L1. The 42 fall into two groups. (a) 23 disputes from one voting round (e.g. "LoL: LNG Esports vs Ultra Prime"): voters and revealed UMA match exactly, but the report gives winner share 0.9976 and L1 gives 1.0. (b) 19 disputes from 3 request timestamps, mostly sibling markets that share one timestamp and an identical ancillary-data prefix (e.g. "Will Bitcoin reach $110k/$120k/$150k by January 31, 2025?"): voter counts are off by 1 to 3 and revealed UMA by at most 0.5%. That pattern points to the report's request-id key (truncated ancillary data) putting the votes of one sibling request on another, so these are most likely report-side errors that the L1 check catches. They don't affect the conflict list: all 96 conflict rows in the top 10 and all 70 case-study rows check out on L1. Per-dispute detail is in `out/verify-report.json` under `all_tallies_mismatches`.

## Vote proofs: trust only block headers (`prove-votes.ts`)

**70/70 conflicted votes proven against block headers (68 mainnet blocks, 0 failures); Polygon balances remain RPC-trusted (no keyless archive getProof).**

Everything above trusts whichever RPC answered `eth_getLogs`. `prove-votes.ts` removes that trust for the vote side. For each of the 70 conflict rows in `out/verify-case-studies.json`, it:

1. reads the block hash from all three keyless RPCs and requires them to agree, then checks `keccak256(RLP(header)) == blockHash`. The header RLP covers every field through Prague (`requestsHash`);
2. fetches every receipt in the block with `eth_getBlockReceipts`, rebuilds the receipts trie with `@ethereumjs/trie` (key `RLP(txIndex)`, value the EIP-2718 typed receipt), and requires the root to equal `header.receiptsRoot`;
3. stores the Merkle-Patricia proof for the vote's receipt, and decodes the `VoteRevealed` log inside the proven receipt: emitter is VotingV2, status 1, and voter, roundId, identifier (`YES_OR_NO_QUERY`), price and numTokens all match. The case study's `priceRequestId` is recomputed from the log's `(identifier, time, ancillaryData)`.

The bundle `out/vote-proofs.json` (~780 KB) holds 68 headers (RLP and hash) and 70 rows (block, txIndex, log position, claimed values, proof nodes). `--verify` re-runs step 3 from the bundle alone and makes no receipt or log calls. It only asks the RPCs for `eth_getBlockByNumber` to confirm each bundled hash is the canonical mainnet hash. `--verify --offline` makes no calls at all. Tampering with a vote amount, a proof node or a header byte makes the affected row fail (tested).

**Trust: headers only.** A dishonest RPC can't forge a vote here. Doing so would mean finding a keccak collision in the trie or the header. The only remaining assumption is "these 68 block hashes are canonical mainnet". You can check that against any node you run, a light client, or a block explorer. We cross-check it on three independent providers. We did not chain the hashes back to a recent head. EIP-2935 serves only the last 8,191 block hashes and `BLOCKHASH` only the last 256, while these votes sit in blocks 22,015,400 to 24,588,437. A parent-hash walk would cost millions of header calls, and a beacon-chain light-client sync (historical summaries) is the right tool for that.

**Why the Polygon half stays RPC-trusted.** Proving a CTF `balanceOf` at a past block needs `eth_getProof` on a Polygon archive node, checked against that block's `stateRoot`. On 2026-10-12, no keyless Polygon endpoint serves historical state: drpc returns "Unknown state", publicnode needs a token, polygon-rpc returns 403, and 1rpc and llamarpc fail. So the holdings side (who held what at the vote) is still read with `eth_call` and is only as honest as the RPC. A paid archive key plus `eth_getProof` would close that gap with the same pattern.

## UmaConflictRegistry (`conflict-registry/`)

- **Leaf.** `keccak256(bytes.concat(keccak256(abi.encode(bytes32 disputeId, address voter))))`, using OpenZeppelin `StandardMerkleTree`. Inner nodes are sorted-pair keccak hashes.
- **disputeId.** UMA's own VotingV2 `priceRequestId`, so a consumer can compute it from `(identifier, time, ancillaryData)` with `disputeIdOf()`, or call `isConflictedRequest(identifier, time, ancillary, voter, proof)` directly.
- **Built from.** `conflict-report/out/conflicts.csv`, which has 2,256 rows. Every row maps to an L1 request (0 unmapped), giving **2,256 leaves across 834 disputes**.
  - Root: `0x9eb03f8171aa6cb079efb210af191385fc5b3f9706638b1e7cf14b5c67d157af`.
  - `datasetHash` is the sha256 of the CSV: `0x97c8866e…3cc216`.
  - Report ids are cut to 80 characters, so two plain-text requests with the same `time` can share an id. Those are told apart by the question title.
- **Outputs** (`data/`).
  - `root.json` holds the root and counts.
  - `proofs.json` maps `disputeId → voter → proof`, for a UI.
  - `disputes.json` holds each disputeId's full UMA request, deciding round and voter set.
  - `merkle-tree.json` is the OpenZeppelin dump.
  - `fixture.json` holds the real proofs used by the tests.
- **Tests.** `forge test` gives **8/8 passing**, including a fuzz test with 256 runs. They cover:
  - real proofs for the top 3 case studies;
  - the Thailand case checked through the raw UMA request (identifier, time, full L1 ancillaryData → disputeId);
  - rejection of the largest non-conflicted voter in that dispute (2.38 M UMA), a wrong dispute, a tampered or empty proof, and random pairs;
  - owner-only `publish`, after which old proofs stop verifying.
- **Local deploy.** We deployed to `anvil` with `RPC=http://127.0.0.1:8545 KEY_FILE=… ./deploy.sh`. `cast call isConflicted(Thailand, 0xacb1…6272)` returned `true`, and the same call for the whale `0xb524…3715` returned `false`.

### Sepolia: deployed

- `UmaConflictRegistry`: [`0x4e87CC9fD0791bC8cF85d9f49772E193BCD5be55`](https://sepolia.etherscan.io/address/0x4e87CC9fD0791bC8cF85d9f49772E193BCD5be55), deploy tx [`0xc7c0a7b1…ff4f`](https://sepolia.etherscan.io/tx/0xc7c0a7b18cc73aea684c66a6eb280b1f6d15b0bd660ae77a9c276c0dc50fff4f). Deployer `0x1E11D68d1D1C98e3dC768DaCd84d87F52F834747`.
- It was deployed with root `0x9eb03f81…57af` (2256 leaves, 834 disputes) and dataset URI `https://pugarhuda.github.io/saring/data/conflicts.csv`.
- On-chain check against Sepolia: `isConflicted(Thailand, 0xacb1…6272, proof)` returns `true`, and the whale `0xb524…3715` with the same proof returns `false`. The record is in `conflict-registry/data/deployment-11155111.json`.
- The source is verified on Sourcify with an exact match: <https://repo.sourcify.dev/11155111/0x4e87CC9fD0791bC8cF85d9f49772E193BCD5be55>. We did not verify on Etherscan because that needs an API key.

## Limits

- **Coverage is a lower bound, same as the report.** We check the voter's EOA and its CREATE2 Polymarket Safe. Polymarket proxy (email/magic) wallets, other wallets, and CEX accounts aren't linked.
- **The cut-off is the last reveal.** A position that is opened during the round and closed before the last reveal isn't flagged, as in the shutdown case above.
- **Neg-risk markets** are resolved through NegRiskOperator and NegRiskAdapter on Polygon. If both derivations fail, the code falls back to the report's `conditionId`, but only after checking on the CTF that the condition exists. Every dispute verified here was derived on-chain without that fallback.
- **The registry is a commitment, not an oracle.** It proves "this (dispute, voter) pair is in Saring's published report with dataset hash X". Anyone can recompute the root from the CSV and the L1 logs with `build-merkle.ts`, and check any row with `--request`. The root has to be republished when the daily monitor adds disputes.
- **Public RPCs** are rate-limited. A full re-tally of every dispute takes about 315 rounds of reveal logs, roughly 1.5 h cold. Cached reruns take seconds.
