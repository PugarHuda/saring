# Audit scope

Target: **Saring v3.1**, commit `0fd102e`, deployed on Solana devnet. Read [ARCHITECTURE.md](ARCHITECTURE.md) first, then [THREAT_MODEL.md](THREAT_MODEL.md). Earlier findings are in [SECURITY.md](SECURITY.md).

## In scope

Line counts are from `wc -l` at `0fd102e`.

| File | Lines | What it is | Priority |
|---|---:|---|---|
| `programs/blindcourt/src/lib.rs` | 1087 | Anchor program: court PDA, 5 queue ixs + 5 verified callbacks, lock state machine, `reset_pending`, pari-mutuel market (`create_market` / `bet` / `claim`) | **P0** |
| `encrypted-ixs/src/lib.rs` | 154 | Arcis circuits `init_court_v3`, `add_juror_v3`, `record_positions_v3`, `cast_v3`, `resolve_v3` | **P0** |
| `app/api/rpc.js` | 80 | JSON-RPC proxy (allowlist, Origin, rate limit) holding the Helius key | P1 |
| `app/api/faucet.js` | 127 | Devnet faucet, hand-built Ed25519-signed transfer | P1 |
| `app/api/panta.js` | 41 | Panta REST proxy holding the API key | P2 |
| `app/src/court.ts` | 431 | Browser client: encryption, PDA derivation, tx sending, callback detection | P1 |
| `panta/panta.ts` | 100 | Mainnet Panta reader and the identity function `id = SHA-256(wallet)[0..4]` | P2 |
| `tests/blindcourt.ts` | 260 | End-to-end scenario (reference for intended behaviour) | ref |
| **Total** | **2280** | | |

## Out of scope

- The Arcium protocol, Arx nodes, the `arcis` / `arcium-*` crates (0.15.0) and `@arcium-hq/client`. We rely on their guarantees; see the trust assumptions in THREAT_MODEL.md.
- Anchor, the Solana runtime, `@solana/web3.js`.
- UI and visuals (`app/src/App.tsx`, `Blob.tsx`, `styles.css`, `shims/`), `conflict-report/` (Python data pipeline), `docs/` (static site), `panta/` scripts other than `panta.ts` (`check.ts`, `watch.ts`, `disputes.ts`, …), `sdk/`.
- Panta's own program and API.
- Generated files: `build/`, `target/`, `app/src/idl/*`.

## Invariants to check

Program (`lib.rs`):

1. **Solvency.** `vault.lamports ≥ rent_min(0) + Σ_{unclaimed bets} payout(bet)` at all times. Before any claim: `vault.lamports ≥ rent_min(0) + yes_pool + no_pool` (≥ because anyone can transfer lamports into the vault).
2. **Payout bound.** `Σ payouts ≤ yes_pool + no_pool`. Refund case: every bettor gets exactly `amount`. Win case: `⌊amount·total / winning_pool⌋`, losers 0. No `claim` can succeed twice for one bet (`claimed`).
3. **Pool accounting.** `yes_pool = Σ amount over bets with yes`, and the same for `no_pool`. A bet never changes side. `bettors ≤ 6` and equals the number of distinct `BetAccount`s. Every stake is ≥ 1 000 000 lamports.
4. **At most one verdict.** `resolved` goes `false → true` once. `yes/no/excluded/incomplete` are written only in the successful `resolve_v3_callback`, and never again.
5. **Freeze after resolve.** `resolving ∨ resolved ⇒` no new `add_juror` / `record_positions` / `cast` / `resolve` / `bet` can be **queued**. (A callback for a cast queued *before* resolve can still rewrite `state`/`nonce`. Confirm this can't affect the verdict: THREAT_MODEL T-9.)
6. **Single writer.** While `pending`, no second mutating computation can be queued. Every mutating callback clears `pending`, success or abort. Check `reset_pending` (T-8).
7. **Readiness.** `ready = false ⇒` no queue except the initial `init_court_v3`. `ready` only becomes true in a verified `init_court_v3_callback`.
8. **Authority.** Only `court.authority` can `add_juror`, `record_positions`, `resolve` and `reset_pending` (PDA seeds derived from the signer, plus `has_one`).
9. **Callback authenticity.** No callback writes state, nonce or verdict without `verify_output` succeeding against the court's cluster and computation accounts.
10. **Layout.** `state` stays at byte offset 9 and is 13 × 32 bytes. `STATE_OFFSET` / `STATE_BYTES` match `Pack<[u32; 73]>`.
11. **Market binding.** `market.court_acc == court_acc` and the `vault` / `bet` PDAs match their seeds and stored bumps in `bet` and `claim`, so a market can't settle on another court's verdict.

Circuits (`encrypted-ixs/src/lib.rs`):

12. **A ballot counts iff its key matches.** `cast_v3` changes slots 56–71 only when `id ≠ 0 ∧ key ≠ 0 ∧ seat.id = id ∧ seat.key = key`. Otherwise the state is unchanged (apart from re-encryption).
13. **Rotation.** After a matching cast with `new_key ≠ 0`, the old key no longer authorizes anything.
14. **Seats.** Juror ids are unique across slots 48–55. `id = 0` or `key = 0` is never seated. A full jury sets `F`.
15. **Holders.** Non-zero holder ids are unique across slots 0–47. A full table sets `F`.
16. **Tally.** `yes + no + excluded = number of seats with a ballot ≠ 0`. A seat is excluded iff its id ∈ holders. `incomplete ⇔ F ≠ 0`. Nothing else is revealed.
17. **Obliviousness.** No branch or loop bound depends on secret data in a way that changes what is revealed.

## Questions we would like answered

- T-8: can a late callback after `reset_pending` overwrite a newer state? Should callbacks check the queued `computation_offset`?
- T-9: does Arcium read `ArgBuilder::account` data when the computation is queued or when it runs? If at run time, can `resolve` (which takes no lock) pair an old nonce with new ciphertexts?
- Is `Rent::minimum_balance(0)` the right reserve for a system-owned, zero-data vault under current rent rules?
- `create_market` can be called by anyone for any court. Any griefing beyond paying the reserve?

## Build and test

Toolchain (pinned): **Arcium CLI 0.15.0**, **Anchor 1.0.2**, **Solana CLI 3.1.10 (Agave)**, Rust **1.89.0** (`rust-toolchain.toml`), Node 22, Yarn 1.22. Linux or WSL2 with Docker for the localnet.

```bash
yarn install
arcium build                 # compiles circuits → build/*.arcis, *.hash, *.weight, then the program
arcium test                  # Arcium localnet (2 nodes, Docker) + tests/blindcourt.ts
```

Against the deployed devnet program (fresh court id per run; needs ~0.5 devnet SOL at `~/.config/solana/id.json`):

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json \
ARCIUM_CLUSTER_OFFSET=456 \
npx ts-mocha -p ./tsconfig.json -t 2000000 tests/blindcourt.ts
```

Expected result: `verdict: yes=0 no=2 excluded=3 incomplete=false`, NO bettor paid ≈ 0.03 SOL, vault left with only its rent reserve.

Web app: `cd app && yarn install --frozen-lockfile && yarn build` (or `yarn dev`).

### What CI checks (`.github/workflows/ci.yml`)

- `cargo check -p encrypted-ixs --locked` (the circuits crate type-checks with the pinned rustc 1.89.0 and needs no Arcium CLI).
- **Circuit release integrity**: downloads the five `circuits-v3/*.arcis` release assets and checks their SHA-256 against the values below, which are the values compiled into the deployed program by `circuit_hash!`.
- App: `yarn install --frozen-lockfile`, `yarn build` (`tsc --noEmit` + `vite build`), `node --check app/api/*.js`. Also `tsc -p sdk --noEmit` if `sdk/package.json` exists.
- **Not in CI: `cargo check -p blindcourt`.** The program's proc macros read `build/<circuit>.arcis`, `.hash` **and** `.weight`. Those come only from `arcium build` (Arcium CLI + Docker), and `build/` is gitignored. With only the release `.arcis` and derived `.hash` files, the check still fails on the missing `.weight` files. We left it out rather than fake it. Run `arcium build` locally.

## Deployed addresses

| | |
|---|---|
| Program (devnet) | `3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy` |
| Arcium MXE | devnet cluster offset `456`, Arcium 0.15.0, backend Cerberus |
| Arcium program | from `getArciumProgramId()` (`@arcium-hq/client` 0.15.0) |
| Panta program (read-only, mainnet) | `6gM5afTQBq5VZCfgpGqcsqzfWd5maLSCKWtGjbEobZMp` |
| Demo Panta market (mainnet) | `3wdVRLDiMeuWRjGcFq2FZgAyCLhswTwNSKEHgNFRSZNB` |
| Verified devnet court (CLI scenario) | `AyL12VgeDcf5PNrBEujyptgJ7V9MSwYyr8Eftuc7vMPk` |
| Hosted app | https://saring-silk.vercel.app |

## Release `circuits-v3`

URL prefix: `https://github.com/PugarHuda/saring/releases/download/circuits-v3/`. SHA-256 of each asset (equal to `build/<name>.hash`, the value pinned by `circuit_hash!`; checked on 2026-10-12, published assets match the local build byte for byte):

| Circuit | SHA-256 |
|---|---|
| `init_court_v3.arcis` | `28e35f9ee6dccb77b07dd0b2663309c46a01da5ddc84be96449ddf317a379f98` |
| `add_juror_v3.arcis` | `08758e5e360fd5516b98d9373f79f8e901d38b8ba445cb0c2154353838d9256c` |
| `record_positions_v3.arcis` | `7ccfeb7fab44d75612f5832c015d7fd410b2d6378519810b7c050070d73f9de7` |
| `cast_v3.arcis` | `cb883abb35904d3867d37ca96cf1aa9c14ee0aca0fde8607cdc85c8acf3b2748` |
| `resolve_v3.arcis` | `2bea557e86943860e8dc72729cb303b875db5076b1fc410463758d465b444a46` |

To check that these circuits came from `encrypted-ixs/src/lib.rs`: run `arcium build` at `0fd102e` and compare `sha256sum build/*_v3.arcis`. This assumes the Arcis 0.15.0 compiler output is deterministic, which we have not checked on a second machine.
