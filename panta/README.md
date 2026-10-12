# Panta integration

Saring plugs into the dispute flow that Panta (`balr_market`, program
`6gM5afTQBq5VZCfgpGqcsqzfWd5maLSCKWtGjbEobZMp`, Solana mainnet) already runs on chain.
Panta data is always read from mainnet. The court runs on devnet (Saring program
`3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy`, Arcium cluster offset 456).

| File | What it does |
|---|---|
| `panta.ts` | Reads Panta positions (`UserPosition`), market questions and wallet identity ids |
| `balr_market.json` | Panta's on-chain Anchor IDL, used to decode events and accounts |
| `disputes.ts` | Scans Panta's whole transaction history for disputes and settlements |
| `sources.ts` | Pluggable mainnet event sources: RPC polling, Solami gRPC, Solami WebSocket, Solami Mirage, backfill |
| `watch.ts` | Watches Panta, writes `out/live-feed.jsonl`, and opens a Saring court for each dispute |
| `solami-stats.ts` | Live Panta metrics through Solami RPC |
| `decode.check.ts` | Self-check that a `MarketDisputed` event built byte by byte decodes correctly |
| `out/` | Outputs and logs of every run quoted below |

## Setup

Run all commands from the repo root after `set -a; . ./.env.local; set +a`.

| Variable | Used for |
|---|---|
| `MAINNET_RPC_URL` | Panta reads (holders, questions, history scan, polling fallback) |
| `RPC_URL` | Devnet, where the Saring court runs. The wallet is `~/.config/solana/id.json` |
| `SOLAMI_API_KEY` | Turns on Solami as the real-time path. Create an "API key" at solami.dev → Dashboard → API keys and paste it here. Never commit it |
| `SOLAMI_TRANSPORT` | `grpc` (default), `ws`, or `mirage` |
| `SOLAMI_FROM_SLOT` | Optional. Makes gRPC replay history from this slot before going live |
| `SOLAMI_MIRAGE_ID` | Optional. A Mirage subscription created in the dashboard (see below) |
| `SOLAMI_GRPC_URL` | Optional. Overrides `https://grpc.solami.dev`, e.g. with the `fra.` regional host |

To use your own key, change `SOLAMI_API_KEY` and nothing else. If the key is unset, the
watcher falls back to polling `MAINNET_RPC_URL`.

## Solami endpoints, and which ones work with our key

I took these from Solami's docs at solami.dev/docs (the site is a single-page app, so the
pages Mirage, gRPC, API keys and Endpoints are inside its JS bundle) and from `solami.dev/llms.txt`.
Each one was tested against mainnet with our key on 2026-10-12.

| Product | Endpoint and auth | Result |
|---|---|---|
| RPC | `https://rpc.solami.dev/sol?api_key=KEY` | **Works.** `getSlot` and `getProgramAccounts` (966 Panta positions) succeed. `getSignaturesForAddress` with `limit: 1000` returns `-32603 Request failed` while `limit: 100` works, so the code pages by 100. `getTransaction` with `jsonParsed` returns inner instructions that web3.js's schema rejects, so the code uses `json` |
| WebSocket | `wss://ws.solami.dev/ws/sol?api_key=KEY` with standard PubSub | **Works.** `logsSubscribe({mentions:[Panta]})` and `programSubscribe(Panta, {filters:[{dataSize:202}]})` both return subscription ids |
| Yellowstone gRPC | `https://grpc.solami.dev:443`, metadata `x-token: KEY`, `geyser.Geyser/Subscribe` | **Works.** It returns HTTP 200 and a live stream. I checked the decoder on a busy program (pump.fun): real transaction frames (signature, slot, logs) and account frames (pubkey, data) both decode, and the `datasize` filter applies. `from_slot` replay reaches about 3,100 slots back. Asking for more returns `grpc-status 11 ... last available: N`, and the client then retries from N |
| Mirage | Create with `POST https://api.solami.dev/mirage/create` `{label, filter:{account_include, accounts, vote, failed, commitment}}`. Stream from `wss://ws.solami.dev/mirage/stream/{id}?api_key=KEY`, which sends binary Yellowstone `SubscribeUpdate` frames | **Refused for our key.** `/mirage/create` returns `403 missing required permission: MirageManage` and `/mirage/list` returns `403 MirageView`. The stream needs a key whose role grants `MirageStream` plus a subscription id. The code is written to the documented API but has never received a live frame |

The gRPC client in `sources.ts` has no dependencies. It speaks raw HTTP/2 through Node's
`http2` module and hand-encodes the protobuf fields it needs. I checked the field numbers
against `yellowstone-grpc-proto` `geyser.proto` and `solana-storage.proto`. The decoder
(`decodeSubscribeUpdate`) is shared with Mirage, which sends the same frames byte for byte.
The subscription asks for:

- transactions with `account_include = [Panta]`, `vote = false`, `failed = false`
- accounts with `owner = [Panta]` and `datasize = 202`, which is every `UserPosition`
- `commitment = CONFIRMED`

Every 10 s the client sends a ping-only request, and every minute it logs a heartbeat.
After a disconnect it resumes from the last slot it saw (`from_slot`).

## How Panta disputes work today

1. The `oracle` signs `submit_oracle_result(yes_wins)` (or `_usdc`). This emits
   `OracleResultSubmitted` and opens a dispute window.
2. A wallet that holds shares in the market (otherwise error 6098 `NoSharesInMarket`) calls
   `dispute_resolved_event(proposed_yes_wins)`, proposing the opposite outcome (otherwise
   6073 `OutcomeUnchanged`). The call posts a bond, creates the PDA
   `ReviewRequest ["review_request", event]`, and emits
   `MarketDisputed {event, disputer, oracle_proposed_yes_wins, disputer_proposed_yes_wins, bond_lamports}`.
3. A single signer then calls `resolve_event(yes_wins)` (or `_usdc`). This emits `EventResolved`
   and settles the bond with `ResolutionDisputeSettled {settled_by, disputer_correct, final_yes_wins, bond_lamports, reward_lamports}`.

`MarketConfig` (`8mJjfx7SuWwS4yfVZXtqC2cvzxr3TQHsCgKyjpuDWKAP`) has **no bond field**. It holds
three admins (`664h…ghbR`, `H23s…ngd2`, `4mjB…J83m`), the relayer (`4mjB…`), a 1 SOL creation
fee, a 200 bps primary fee and a 150 bps secondary fee. The program computes the bond itself,
and it is visible only per dispute.

## Integration mapping

```
Panta (mainnet)                                   Saring (devnet today)
dispute_resolved_event(proposed_yes_wins)
  -> MarketDisputed {event, bond_lamports}   ==>  watch.ts (Solami gRPC stream)
                                                  create_court(id, "panta:<event>")     init_court_v3
                                                  record_positions x ceil(holders/6)     record_positions_v3
                                                    every UserPosition holder of <event>, encrypted
                                                  add_juror / cast / resolve            add_juror_v3, cast_v3, resolve_v3
                                                    -> court {yes, no, excluded}
resolve_event(yes_wins = court.yes > court.no) <== verdict
  -> ResolutionDisputeSettled {settled_by = Saring authority}
```

Panta has to make one change. For a disputed market, the signer of `resolve_event` becomes the
Saring court authority instead of a Panta admin key. The court is labelled `panta:<event>`, and
that authority signs only `yes_wins = court.yes > court.no` for it. Today the protocol's own
admins judge disputes against their own oracle (numbers below).

## Measured numbers (Solana mainnet, `out/disputes.json`)

`disputes.ts` read **all 4,067 signatures** of the program, from the first transaction on
2026-06-10 16:40 UTC to 2026-10-11 16:46 UTC. Of those, 4,018 succeeded. It decoded every
event with the IDL.

- **170 resolutions**: 64 `resolve_event` (SOL) and 106 `resolve_event_usdc`, each preceded by a `submit_oracle_result`.
- **4 disputes in total, which is 2.4% of resolutions.** All four were SOL markets and all came in the first 9 days (2026-06-11 to 06-19). There have been **0 disputes in the 16 weeks since**, and no `ReviewRequest` account is open now.
- In all four, the disputer proposed YES against the oracle's NO. One wallet (`BZva…`) filed three of them.

| Market | Bond (SOL) | Disputer correct | Time to settle | Settled by |
|---|---|---|---|---|
| `8kAb…7S` | 0.0099 | yes | 1.6 min | `4mjB…` (admin 3 and relayer) |
| `4jrs…Sp` | 0.0138 | no | 6 min | `H23s…` (admin 2) |
| `TXZi…zd` | 0.0864 | yes | 13.8 h | `H23s…` (admin 2) |
| `67Ku…zr` ("$ETH to Hit $2500 before Friday 19th of June") | 0.2284 | no | 1.7 h | `H23s…` (admin 2) |

- Bonds ranged from 0.0099 to 0.2284 SOL, totalling 0.338 SOL. Disputers lost 0.242 SOL of that. `reward_lamports` was 0 every time.
- Admin 1 (`664h…`) signed 336 of the oracle submit and resolve transactions. Every dispute was settled by another key from the same three-admin set.

## `disputes.ts`

```
npx ts-node --transpile-only -P tsconfig.json panta/disputes.ts [maxSignatures=10000]
```

The script pages through `getSignaturesForAddress`, then fetches the successful transactions
in batches of 10, about 10 per second, with backoff. It decodes `Program data:` lines with
`BorshEventCoder` and Panta's IDL, and counts `Instruction: X` lines. Both counts use only log
lines inside Panta's own invoke frame. It also decodes `MarketConfig` and every live
`ReviewRequest`. Output goes to `out/disputes.json` and the log to `out/disputes.log`.

## `watch.ts`

```
npx ts-node --transpile-only -P tsconfig.json panta/watch.ts [--backfill 7d] [--interval 20]
npx ts-node --transpile-only -P tsconfig.json panta/watch.ts --once <market>     # open a court for a market now
npx ts-node --transpile-only -P tsconfig.json panta/watch.ts --replay <sig>      # a past dispute tx
```

- **Source**: Solami gRPC when `SOLAMI_API_KEY` is set, otherwise RPC polling (see `sources.ts`).
  `--backfill <window>` first replays the window's Panta transactions through Solami RPC into the
  feed. It does not open courts for old disputes, and then it follows the live stream.
- **Feed**: each event is appended as one JSON line to `out/live-feed.jsonl`:
  `{ts, kind: "position"|"dispute"|"court", source, slot, chainTime?, signature?, market, wallet?, text}`.
  A position event reads "new position in market X by wallet W". It counts as "new" when the
  `UserPosition` PDA went from 0 lamports to rent in that transaction, or the first time the
  account appears on the gRPC account stream. Position events come from `SharesMinted`,
  `PrimaryOrderPlaced`, `SecondaryOrderPlaced` and `OrderMatched`, plus the 202-byte account updates.
- **Disputes**: a `MarketDisputed` event, or a `DisputeResolvedEvent(Usdc)` instruction where the
  market is the third account, opens a court labelled `panta:<market>` on devnet. The watcher then
  mirrors up to 42 holders, 6 per `record_positions_v3` MPC call. Transactions are confirmed by
  polling `getSignatureStatuses`. Handled markets are stored in `out/watch-state.json`, so a
  restart never opens a second court for the same market.

Runs on devnet:

- `--once 3wdV…SZNB` (`out/watch-once.log`): court `7QSYubTzmht7Y8Hus7yxXWAciVbDk4ZceWHMFcJVoh6T`,
  42 holders, 8 MPC computations. The log says it spent 0.0741 SOL, but a second identical run
  happened by accident at the same time on the same wallet (court `Fah225…`). So one run costs
  about 0.037 SOL.
- `--replay 5UKT…okLz`, the real 2026-06-19 dispute on `67Ku…` (`out/watch-replay.log`): court
  `D1N96E8fPXinKWd1fz9gxuLsuHPGNfzUnrqxektyRVfW`, 17 holders, 4 MPC computations, 0.0195 SOL.
- A `--replay` of a non-dispute transaction is refused.

Mainnet run through Solami on 2026-10-12 (`out/solami-live.log`, `out/live-feed.jsonl`): `--backfill 7d`
pulled 103 Panta transactions through Solami RPC and wrote **52 feed lines**: 40 new positions and
12 changed positions, from 33 wallets across 10 markets. No disputes fell in that window. After the
backfill the Solami gRPC stream stayed connected and sent a heartbeat every minute. Across three
runs it was live for about 23 minutes and received **0 Panta updates**, because Panta was quiet:
its newest transaction is from 2026-10-11 16:46 UTC. The stream decoder was checked separately on
live pump.fun traffic, as described above.

## `solami-stats.ts`

```
npx ts-node --transpile-only -P tsconfig.json panta/solami-stats.ts [window=24h]   # 90m, 24h, 7d
```

All reads go through Solami RPC. For the window, it reports Panta transactions, positions created
(PDA created in that transaction), position trades, unique wallets, markets touched, disputes and
settlements. It also reports the current number of `UserPosition` accounts, unique holders, markets
with holders and open `ReviewRequest`s. Output goes to `out/solami-stats.json`. Last 7 days, as of
2026-10-12 (`out/solami-stats.log`):

| Last 7 days | | Now | |
|---|---|---|---|
| successful Panta transactions | 103 | `UserPosition` accounts | 966 |
| positions created | 40 | unique holders | 182 |
| position trades | 53 | markets with holders | 209 |
| unique wallets | 33 | open `ReviewRequest`s | 0 |
| markets touched | 10 | | |
| disputes / settlements | 0 / 0 | | |

## Unit economics

Panta is the only venue we have measured, and its numbers are small. Over its whole history it
had 4 disputes in about 4 months, all in the first 9 days, out of 170 resolutions (2.4%). Bonds
were 0.0099 to 0.228 SOL, and disputers lost 0.242 SOL in total. A fee of 10% of the losing bond
would have earned **0.024 SOL across Panta's whole life**. At 20% it would be 0.048 SOL. One
Saring court on devnet costs about 0.02 SOL for 17 holders and about 0.037 SOL for 42. That is
more than a 10% fee would earn on three of the four real disputes.

So a fee taken as a share of the losing bond does not cover costs at Panta's scale. A working
model needs a flat minimum court fee, or a bond floor of about 0.25 SOL or more so that 10–20% of
it pays for the court. It also needs volume from several venues. Panta's own data does show the
problem Saring addresses: the same three admin keys propose the outcome and settle every dispute
against it, and they reversed their own oracle in 2 of 4 cases.
