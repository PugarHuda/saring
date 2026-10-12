# UMA Conflict Report dataset

Open data on how often UMA DVM voters held a position in the Polymarket market they were voting to resolve.
Regenerated daily by [`.github/workflows/conflict-report.yml`](../../.github/workflows/conflict-report.yml) from public sources.
Report: <https://pugarhuda.github.io/saring/>. Code: [`conflict-report/`](../../conflict-report/).

| File | Rows | What |
|---|---|---|
| `summary.json` | 1 object | Headline numbers shown on the report page |
| `disputes.csv` | 1 per DVM request | Every resolved UMA `YES_OR_NO_QUERY` DVM request (since 2025-01-01) mapped to a Polymarket market and with revealed votes |
| `conflicts.csv` | 1 per conflicted vote | A vote cast by a voter whose Polymarket wallet held ≥ 1 share in that market when the vote closed |

## Method

1. **Votes.** Resolved `YES_OR_NO_QUERY` price requests and the revealed votes (voter, price, tokens) of the final, deciding round, from UMA's public Goldsky subgraph `mainnet-voting-v2`.
2. **Question text.** Hashed ancillary data is recovered from `OracleChildTunnel` logs on Polygon and matched by keccak256.
3. **Market.** Polymarket `questionID = keccak256(ancillary data before ",ooRequester:")`, looked up on the Gamma API. Accepted only on an exact questionID or exact title match.
4. **Voter → wallet (CREATE2).** Each voter's Polymarket Gnosis Safe address is derived deterministically from the voting address with CREATE2 (factory `0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b`, salt `keccak256(owner)`, init-code hash `0x2bce2127…fecf`). The derivation was verified by calling `getOwners()` on-chain: the Safe's owner is the voting address. The voting address itself (EOA) is checked too. No funding-graph heuristics are used.
5. **Position at vote time.** Polymarket Data API activity (`TRADE`, `SPLIT`, `MERGE`, `REDEEM`) in that market up to the round's `lastRevealTime`. Conflicted = net ≥ 1 share of any outcome.
6. **Counterfactual.** Vote weight per answer recomputed without conflicted voters, checked against the 65% supermajority (SPAT) and the participation threshold (GAT).

It is a **lower bound**: voters trading from other wallets (separate keys, exchanges, email/magic accounts) are not detected. Holding a position and voting your own side is not proof of bad faith.

## `disputes.csv`

| Column | Meaning |
|---|---|
| `request_id` | UMA price-request id, truncated to 80 chars (`YES_OR_NO_QUERY-<request unix time>-<ancillary hex prefix>`) |
| `market`, `slug` | Polymarket question and slug (`https://polymarket.com/market/<slug>`) |
| `volume_usd` | Gamma market volume (may be 0 when Gamma has none) |
| `vote_round_end_utc` | Date the deciding round's reveal phase ended |
| `resolved_outcome` | Outcome UMA resolved to (`Yes`/`No`/…, `50-50`, or `other`) |
| `voters`, `tokens_revealed` | Number of revealed votes and UMA tokens behind them |
| `conflicted_voters`, `conflicted_tokens`, `conflicted_pct` | Voters holding a position, their tokens, and their share of revealed tokens (%) |
| `self_serving_tokens` | Conflicted tokens that voted for the side the voter held |
| `winner_all`, `winner_share_all` | Winning answer and its token share with all voters |
| `winner_clean`, `winner_share_clean` | Same with conflicted voters removed |
| `outcome_flips` | Winner changes when conflicted voters are removed |
| `clean_below_supermajority` | Clean winner share below 65% |
| `clean_below_GAT` | Clean participation below the GAT |
| `voters_touching_market` | Voter wallets with any pre-vote activity in the market (held or not) |

## `conflicts.csv`

| Column | Meaning |
|---|---|
| `request_id`, `market`, `conditionId` | Dispute (join to `disputes.csv` on `request_id`) and the Polymarket condition id |
| `vote_time_utc` | Date the round's reveal phase ended (position cutoff) |
| `voter` | Voting address on Ethereum |
| `link`, `polymarket_wallet` | `safe` (CREATE2-derived Safe) or `eoa`, and that Polygon address |
| `vote_tokens_UMA` | UMA tokens behind the vote |
| `voted_for` | Answer the voter chose |
| `held_shares_at_vote` | JSON `{outcome: net shares}` held at the cutoff |
| `net_cost_usdc` | Net USDC spent building the position up to the cutoff |
| `voted_own_side` | Voted for the outcome they held most of |
| `redeemed_after` | The wallet redeemed shares in this market after the cutoff |

## License and citation

Data: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Underlying records are public on-chain data and public APIs (UMA, Polygon, Polymarket).

> Saring. *UMA Conflict Report: UMA voters holding positions in the Polymarket markets they resolve* (dataset, updated daily). https://pugarhuda.github.io/saring/, accessed YYYY-MM-DD.

Cite `generated_utc` from `summary.json` for the exact snapshot; every daily version is in the repository's git history.
