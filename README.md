# Saring

**Live demo: https://saring-silk.vercel.app** · Conflict Report: https://pugarhuda.github.io/saring/

**A conflict-blind jury for prediction-market disputes, on Solana with Arcium MPC.**

*Saring* is Indonesian for "filter". Jurors who hold a position in the disputed market are dropped silently. The chain only ever sees ciphertexts: it never sees who sits on the jury, who traded, how anyone voted, or which jurors were excluded, and the MPC never reveals which jurors were excluded. (In this MVP the court authority seats the jurors and relays the positions, so it knows both lists. See [Limitations](#limitations-mvp-and-roadmap).) The only public output is `(yes, no, excluded, incomplete)`, and a pari-mutuel market in the same program pays out on that verdict.

Built for Colosseum's Crypto World's Fair (Sep 14 to Oct 12, 2026). MIT-licensed. Code identifiers still use the working name `blindcourt`.

- **Live on Solana devnet (v3):** program [`3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy`](https://explorer.solana.com/address/3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy?cluster=devnet), Arcium 0.15.0 MXE on devnet cluster offset 456 (see [Devnet](#devnet)).
- **Try it:** https://saring-silk.vercel.app. You sit on the jury as juror #6 with your own secret ballot key, cast your own ballot, and can bet 0.01 SOL to watch MPC drop your ballot.
- **Real Panta data:** the demo dispute is a real [Panta](https://panta.market) market. Its holders are read from Panta's program on Solana mainnet (see [Panta integration](#panta-integration)).
- **Conflict Report:** https://pugarhuda.github.io/saring/

---

## Why

When a prediction market is disputed, someone has to decide the outcome. On Polymarket that is UMA token voters. We matched every resolved UMA yes/no request on a Polymarket market since Jan 1, 2025 to the voters' Polymarket wallets (method and code in the [Conflict Report](https://pugarhuda.github.io/saring/)):

| Metric | Value |
|---|---|
| UMA disputes mapped to Polymarket markets | 4,093 |
| UMA voters who control a Polymarket wallet | 60.4% (3,742 of 6,197) |
| Disputes where at least one voter held a position in that market at vote time | 20.4% (834) |
| Same, markets with ≥ $1M volume | 65.7% (423 of 644) |
| Distinct conflicted voters, and the cost of their positions | 405 voters, ≈ $8.0M |
| **Outcomes that flip if conflicted voters are removed** | **0** |

Read this carefully. Conflicted voters did **not** change any outcome in this data, because their token weight was small. The point is that **nothing filters them**, and the numbers are a lower bound, since anyone can trade from a second wallet. Courts recuse conflicted judges even when they would have ruled correctly.

Why nobody filters: the obvious fix leaks. Publishing the jury tells bribers whom to pay. Publishing who holds positions doxxes traders. The check needs both lists and has to put neither on chain, so it runs as a computation over two secret sets inside MPC. That is the job Arcium does.

## How it works

```mermaid
sequenceDiagram
    participant M as Market (Panta, on-chain)
    participant A as Court authority
    participant J as Juror (any relayer)
    participant P as Saring (Solana)
    participant X as Arcium MXE (MPC)

    A->>P: create_court(market)
    P->>X: init_court_v3 → empty encrypted state
    A->>P: add_juror(Enc(juror_id, secret_key))
    P->>X: add_juror_v3: seat id + key (dedup, overflow flag)
    A->>M: read every UserPosition of the market
    A->>P: record_positions(Enc(6 trader ids)) per batch
    P->>X: record_positions_v3: add ids to holder set (incl. bettors)
    J->>P: cast(Enc(juror_id, key, new_key, yes/no))  (can repeat)
    P->>X: cast_v3: overwrite ballot only if key matches; optionally rotate key
    A->>P: resolve()
    P->>X: resolve_v3: drop jurors ∈ holders, tally the rest
    X-->>P: callback (verified): yes, no, excluded, incomplete
    P-->>P: VerdictEvent → market claim() pays winners or refunds
```

**State.** Each dispute is a `CourtAccount` PDA (`["court", authority, id]`) holding one MXE-encrypted `Pack<[u32; 73]>`: 48 position-holder slots, 8 juror ids, 8 ballots, 8 secret seat keys, and an overflow flag. Every update runs inside MPC and writes back fresh ciphertexts and a nonce through a verified callback. The program allows one computation at a time per court (a `pending` lock, with an authority-only `reset_pending` if a computation is dropped), the resolve callback rejects a second verdict, and the market text is capped at 64 bytes.

**Circuits** (`encrypted-ixs/src/lib.rs`). The compiled circuits are hosted off chain as GitHub release assets (`circuits-v3`). The program pins each one with a hash computed at build time, so a swapped circuit file doesn't match.

| Circuit | Does | Reveals |
|---|---|---|
| `init_court_v3` | empty state | nothing |
| `add_juror_v3` | seats an encrypted id and its secret ballot key in the first empty jury slot; ignores an id already seated; sets the overflow flag if the jury is full (authority only) | nothing |
| `record_positions_v3` | adds up to 6 encrypted trader ids per call to the holder set, de-duplicated; sets the overflow flag if the set is full (authority only) | nothing |
| `cast_v3` | writes or overwrites the ballot for that juror id **only if the key matches the seat's current key**; a non-zero `new_key` rotates the key | nothing |
| `resolve_v3` | for each juror, checks membership in the holder set, then tallies only conflict-free ballots | `yes`, `no`, `excluded`, `incomplete` |

**Secret ballot keys (receipt-free, MACI-style).** Juror ids are `SHA-256(wallet)` prefixes, so they are public to anyone who knows the wallet. An id alone therefore can't authorize a ballot. Each seat has its own secret key, held only inside MPC. A ballot counts only with the seat's current key, and a ballot can rotate the key. A juror can hand a briber their key and a YES "receipt", then quietly cast NO and rotate the key. Whatever the briber sends with the old key is ignored, and the briber can't tell. A forged ballot with a guessed key is ignored the same way. This is MACI's key-change idea, with MPC in place of MACI's trusted coordinator.

**Overflow and `incomplete`.** If the holder set or the jury fills up, an encrypted flag is set and `resolve_v3` reveals `incomplete = true`, because the conflict check may have missed someone. A market on an incomplete verdict refunds every bettor.

**Settlement market.** The same program has `create_market`, `bet` and `claim`: a pari-mutuel YES/NO pool per court that pays the winning side pro rata on the court's verdict. It refunds on a tie, on an incomplete verdict, or when nobody backed the winning side. Bettors are mirrored into the court's holder set like any trader, so a bettor who also sits on the jury is excluded.

**Demo scenario** (`tests/blindcourt.ts`). The dispute is a real Panta market: *"Will @debar be the outright winner of the NectarFi Frontier Traders Competition?"* (`3wdVRLDiMeuWRjGcFq2FZgAyCLhswTwNSKEHgNFRSZNB`).

- Every wallet with a position in that market (42 at the last run, 37 of them still open) is read from Solana mainnet and mirrored, encrypted, into the court, together with the market's 2 bettors.
- Five jurors are seated, each with a secret key: 3 real holders of this market and 2 real Panta traders with no position in it.
- A market opens on the court: 0.02 SOL on NO, 0.01 SOL on YES.
- The 3 conflicted jurors vote YES. One clean juror is "bribed": he casts YES and hands over his key, then casts NO and rotates the key. The briber re-sends YES with the stale key, which is ignored. The other clean juror votes NO, and an outsider's forged YES with a guessed key is ignored.
- A plain jury rules YES 4–1.
- Saring rules **yes=0, no=2, excluded=3, incomplete=false**, and never reveals which three. The NO bettor claims the whole 0.03 SOL pool.

Honest caveat: the 5 scripted jurors' ballots are scripted, because we don't hold those wallets' keys. The positions and identities are real chain data. In the web app the visitor's ballot (juror #6) is real.

## Panta integration

[`panta/panta.ts`](panta/panta.ts) reads Panta directly from its on-chain program on Solana mainnet (`balr_market`, `6gM5afTQBq5VZCfgpGqcsqzfWd5maLSCKWtGjbEobZMp`). There are no mocks or fixtures.

- **Holders of a market:** `getProgramAccounts` over Panta's `UserPosition` accounts (202 bytes), filtered by discriminator and by market at offset 9. Each account gives the owner (offset 41) and YES/NO shares (offsets 74 and 90). A position account that exists counts even if it is now empty, because a trader who exited still had a stake in the outcome (42 wallets have a position in the demo market, 37 still open).
- **Market question:** read from the market's `Event` account.
- **All Panta traders:** every `UserPosition` on the program (182 traders at the last run), used to pick clean jurors who have no position in the disputed market.
- **Identity:** `id = first 4 bytes of SHA-256(wallet pubkey)`, the same function for holders, bettors and jurors. It is encrypted client-side (x25519 + Rescue) before it reaches the chain.

We don't use a Panta API key. Panta's REST API has no endpoint that lists a market's holders, and the on-chain accounts are the source of truth anyway. `panta/check.ts` is a quick mainnet sanity check: it prints the question, holder and trader counts, and whether the identity ids are unique.

## Run it

Requirements: Linux or WSL2 with Docker running, **Arcium CLI 0.15.0**, **Anchor 1.0.2**, **Solana CLI 3.1.10**, Rust (pinned by `rust-toolchain.toml`), Node and Yarn. The test reads Panta from Solana mainnet. The public RPC works, and `MAINNET_RPC_URL` overrides it.

```bash
yarn install
arcium build          # compiles the Arcis circuits (build/*.arcis) and the Anchor program
arcium test           # starts an Arcium localnet (2 MPC nodes, Docker) and runs tests/blindcourt.ts
```

Expected output (abridged; holder and trader counts change as Panta trades):

```
Panta market 3wdVRLDiMeuWRjGcFq2FZgAyCLhswTwNSKEHgNFRSZNB: "Will @debar be the outright winner of the NectarFi Frontier Traders Competition?"
42 wallets hold a position; ... other Panta traders do not
court opened <court PDA>
5 jurors seated with secret ballot keys (encrypted)
market opened: 0.02 SOL on NO, 0.01 SOL on YES
44 positions mirrored (42 Panta holders + 2 bettors, encrypted)
ballots cast (incl. a stale-key bribe and a forged overwrite, both ignored in MPC)
verdict: yes=0 no=2 excluded=3 incomplete=false
claim paid 0.03 SOL (minus fee) to the NO bettor
losing bettor claimed 0; vault empty
  ✔ excludes jurors who hold a position in a real Panta market, without revealing who
1 passing
```

Each instruction waits for its MPC computation to finalize, so a run takes several minutes. The test expects a keypair at `~/.config/solana/id.json`.

## Devnet

| | |
|---|---|
| Program | [`3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy`](https://explorer.solana.com/address/3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy?cluster=devnet), upgraded in place to v3 (built with `opt-level = "z"`, 614 KB) |
| Arcium MXE | devnet cluster offset **456**, Arcium 0.15.0 |
| Original deploy tx | [`4bANmR3H…vdLDcV36`](https://explorer.solana.com/tx/4bANmR3HSzStMSo8z54RSBkh2YKDdQZPRT7kcfjYSLo6JWtvoXAshVwU8zWqQDFEQGLJc4Fmt6Lvqu5EvdLDcV36?cluster=devnet) |
| MXE init tx | [`dCSh4xpn…6iHtd`](https://explorer.solana.com/tx/dCSh4xpnt1FtZPwu4sSDezwBgVmre3hSqXYPJAxV84oQ3nSzHM23Y4tuieSXmqStGqAZys1xji1XVhrEwY6iHtd?cluster=devnet) |
| Circuits | GitHub release `circuits-v3` of this repo, pinned by hash |

All five v3 computation definitions are initialized. Verified v3 runs on devnet:

- **Browser, production app:** the visitor voted NO and bet NO. Verdict yes=0 no=2 excluded=4 incomplete=false (the visitor's own ballot was dropped as a conflict), and the 0.01 SOL bet was paid out and claimed.
- **CLI, scripted scenario** (stale-key bribe, forged overwrite, market claim): yes=0 no=2 excluded=3, and the NO bettor was paid the 0.03 SOL pool. [CONFIRM CLI RUN]

To run the same Panta scenario against devnet (a fresh court id each run, so re-runs don't collide):

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json \
ARCIUM_CLUSTER_OFFSET=456 \
npx ts-mocha -p ./tsconfig.json -t 2000000 tests/blindcourt.ts
```

The wallet needs about 0.5 devnet SOL. The public devnet RPC rate-limits polling (HTTP 429), so a dedicated devnet RPC URL is more reliable.

## Web app

`app/` is a Vite + React + three.js front end, hosted at **https://saring-silk.vercel.app**. It reads the same Panta market from mainnet, shows the Conflict Report numbers, and runs the dispute on devnet from a burner wallet. The visitor is juror #6, with their own secret ballot key and their own ballot. They can also bet 0.01 SOL on the court's market, which gives them a position, so MPC drops their ballot and `excluded` goes up by one.

- One-click faucet: 0.12 SOL to the burner; one run costs about 0.08 SOL.
- 25 steps (28 with a bet), about 2–4 minutes. Every step links its transaction; MPC steps link the queue transaction and the successful callback.
- All RPC goes through a same-origin server proxy with a method allowlist, so the provider key never reaches the browser.
- By default each juror's conflict status shows as "Encrypted". A "god view" toggle reveals which jurors hold the market, which the chain never sees.

Run it locally with `cd app && yarn install && yarn dev`. See [`app/README.md`](app/README.md) for RPC settings.

## Layout

```
encrypted-ixs/src/lib.rs        Arcis circuits (MPC side)
programs/blindcourt/src/lib.rs  Anchor program: court PDA, queue + callback per circuit, settlement market
panta/panta.ts                  reads Panta markets, holders and traders from Solana mainnet
tests/blindcourt.ts             end-to-end Panta dispute + market (localnet or devnet)
app/                            web app (Vite + React + three.js), runs the dispute on devnet
conflict-report/                Conflict Report pipeline (Python) and site source
docs/                           published Conflict Report (GitHub Pages)
```

## Limitations (MVP) and roadmap

| Limitation today | Why it matters | Plan |
|---|---|---|
| The court authority seats jurors (`add_juror` is authority-only) and relays positions | The authority knows both the jury and the holder list (the chain doesn't), so this is not yet bribe-resistant against the operator | Jurors self-register with an attested identity; the market program pushes positions by CPI |
| Positions are mirrored from a snapshot | A position opened after mirroring escapes the filter | Market program calls `record_positions` by **CPI on every fill**, gated to the market's program id |
| Ids and keys are 32-bit | Fine for a demo, too small for mainnet (collisions, guessable keys) | Widen ids and keys to 64+ bits |
| Conflict = same id, wallet-level | Trading from a second wallet evades the filter (same lower-bound caveat as the data) | One person, one id via **Solana Attestation Service** (program `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG`, live on devnet), so linked wallets count as one person; still not perfect |
| Ballots of the 5 scripted jurors are scripted | We don't hold those wallets' keys (the visitor's ballot in the web app is real) | Real jurors sign their own ballots in a pilot |
| `excluded` count is public; jury ≤ 8, holders ≤ 48 | With tiny juries the count can leak who was excluded; overflow makes the verdict `incomplete` | Larger padded jury and holder sets; optionally reveal only the verdict |
| Positions read only for Solana markets | Polymarket positions live on Polygon, so live filtering doesn't apply to them | Solana-native venues first; cross-chain position attestations later |
| One computation at a time per court | The `pending` lock serializes updates; a dropped computation needs `reset_pending` | Batch ballots per computation |
| No juror rewards, slashing, appeals | Not a full court yet | Fee from the losing dispute bond; appeal round with a larger jury |
| Devnet only | — | One pilot market with a venue, then an audit before mainnet (target Q1 2027) |

**Why there is no secret sortition (deliberately).** We considered drawing the jury at random inside MPC after voting, from a larger pool. We didn't build it. A briber who can't tell who will be drawn just pays everyone in the pool, so a draw after voting doesn't raise the cost of bribery much, and it makes outcomes depend on a random draw rather than on the ballots. Secret ballot keys already make a bribe unverifiable, which is the property that matters. The remaining trust gap is the authority that seats jurors, and the fix for that is attested self-registration, not a lottery.

Not audited. Don't use with real funds.

## Prior art

- **Kleros** randomly draws jurors from staked subcourts. Votes are hidden with Shutter threshold encryption, and there are appeal rounds. Jurors' identities are public on chain, and there is no check of whether a juror holds a position. Saring borrows the court model and adds the private conflict filter.
- **UMA DVM** uses commit-reveal voting weighted by UMA tokens, and it is the resolver for Polymarket. It has no conflict check. Our Conflict Report measures what this misses.
- **MACI** (Privacy & Scaling Explorations) gives receipt-free, collusion-resistant voting through key changes, but it relies on a trusted coordinator who can decrypt. Saring's secret ballot keys use the same key-change idea, with Arcium MPC in place of the coordinator.
- **Arcium `examples/voting`**: this repo started from it (see below).

## Prior code and license

Forked from the `voting` example in [`arcium-hq/examples`](https://github.com/arcium-hq/examples/tree/main/voting) (commit `fe15384`). We kept the scaffolding and the comp-def, queue and callback pattern. We rewrote the circuits, the account layout, the instructions and the tests, and added the settlement market, the Panta reader, the web app and the Conflict Report. The examples repo has no LICENSE file, and `voting/package.json` declares ISC. This repo is MIT-licensed (see [LICENSE](LICENSE)).
