# Security policy

Saring is a **devnet MVP that has not been audited**. Don't use it with real funds.

## Reporting a vulnerability

Email **hudapugar@gmail.com** with the subject `[saring security]`. Include the affected file and line or the instruction, a reproduction (transaction signatures or a test), and the impact. Please don't open a public issue for anything that affects the deployed devnet program or the hosted app (https://saring-silk.vercel.app). We'll acknowledge within 72 hours. There is no bug bounty yet.

## Supported versions

| Version | Commit | Where | Supported |
|---|---|---|---|
| v3.1 (program + `*_v3` circuits, release `circuits-v3`) | `0fd102e` | devnet `3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy`, Arcium cluster offset 456 | yes |
| v3 | `9bb99c3` | upgraded in place by v3.1 | no |
| pre-v3 (unkeyed ballots, no lock) | before `9bb99c3` | replaced | no |

The program is upgradeable, and the upgrade authority is the deployer key. There is no verifiable (reproducible) build yet. To check the deployed bytes, compare `solana program dump` against a local `arcium build` from the commit above.

## Review history

Two internal adversarial review rounds were done before submission. They were not independent audits.

| # | Finding | Component | Severity | Status | Fixed in |
|---|---|---|---|---|---|
| 1-1 | RPC proxy allowlist bypass: falsy or non-object batch entries (`null`, `0`) skipped the method check | `app/api/rpc.js` | High (key/quota abuse) | Fixed | `d5202ee` |
| 1-2 | Anyone could overwrite any juror's ballot: ids = `SHA-256(wallet)` prefix are public and were the only credential | circuits / `cast` | Critical | Fixed: per-seat secret ballot keys, checked in MPC, with rotation | v3 `9bb99c3` |
| 1-3 | Concurrent computations read the same state snapshot; the later callback erased the earlier update | program | High | Fixed: `pending` lock on every mutating queue ix | v3 `9bb99c3` |
| 1-4 | Resolve race / double verdict | program | High | Fixed: callback `require!(!resolved)`; `resolving` flag (v3.1) | v3 `9bb99c3`, v3.1 `0fd102e` |
| 1-5 | Duplicate seating gave one id several ballots | `add_juror_v3` | Medium | Fixed: dedup + `id/key != 0` | v3 `9bb99c3` |
| 1-6 | Silent slot overflow let a conflicted juror escape | circuits | High | Fixed: overflow flag → `incomplete` → market refund | v3 `9bb99c3` |
| 1-7 | Faucet races: concurrent requests got double grants | `app/api/faucet.js` | Low (devnet SOL) | Fixed: in-flight set; cooldown claimed before the first `await` | `d5202ee`, `0fd102e` |
| 2-1 | Vault not rent-exempt: a tiny first bet failed, and the last claim couldn't leave dust | market | Medium | Fixed: vault pre-funded with `minimum_balance(0)` | v3.1 `0fd102e` |
| 2-2 | Cast spam held the `pending` lock and blocked `resolve` | program | High (liveness) | Fixed: resolve uses its own `resolving` flag | v3.1 `0fd102e` |
| 2-3 | Sybil dust bettors overflowed the holder set to force an `incomplete` refund | market | Medium | Fixed: minimum stake 0.001 SOL, at most 6 bettors | v3.1 `0fd102e` |
| 2-4 | An aborted callback left `pending` stuck for good | program | Medium | Fixed: `aborted()` releases it; `reset_pending` after 300 slots | v3.1 `0fd102e` |
| 2-5 | Court used before `init_court` landed (invalid ciphertext state) | program | Medium | Fixed: `ready` flag | v3.1 `0fd102e` |
| 2-6 | Bets accepted after resolve was queued | market | Medium | Fixed: `bet` rejects `resolving` | v3.1 `0fd102e` |
| 2-7 | RPC proxy abuse from other origins and scripts | `app/api/rpc.js` | Medium | Partly fixed: `Origin` allowlist + per-IP rate limit (per instance) | v3.1 `0fd102e` |

## Known limitations (open)

These are documented, not fixed. Details and residual risk are in [THREAT_MODEL.md](THREAT_MODEL.md).

| Limitation | Severity | Ref |
|---|---|---|
| The authority seats jurors and relays positions, so it knows both lists | High (trust) | L1, T-20 |
| Mirroring bettors and positions into the court is not enforced on chain | High | L2, T-10 |
| 32-bit ids and 31-bit keys: ids can be ground to frame a juror; keys are guessable at scale | High for mainnet | L3, T-1, T-2 |
| A second wallet evades the conflict filter | Medium | L4, T-3 |
| Positions opened after the last mirroring escape the filter | Medium | L5, T-10 |
| Cast spam can still delay `add_juror` / `record_positions` | Low–Medium | L6, T-13 |
| No quorum and no resolve deadline | Medium | L7, T-17 |
| Bet account rent is not closed or refunded on claim; rounding dust stays in the vault | Low | L8, T-11 |
| `excluded` count leaks information for tiny juries | Low–Medium | L9, T-18 |
| `awaitStep` picks the callback signature heuristically (UI link only) | Info | L10, T-27 |
| Rate limits are per serverless instance, not global | Low | L11, T-25, T-26 |
| Late callback after `reset_pending` can cause a lost update | Medium | T-8: **fixed in v3.2** (callbacks ignored unless they come from the computation holding the lock), on branch `v3.2-pending-deploy`, deploying when devnet SOL for the upgrade buffer is available |
| `resolve` during an in-flight cast may read ciphertexts that do not match the queued nonce | Medium | T-9: **fixed in v3.2** (resolve takes the lock), same branch; in the live demo resolve is only queued after every ballot has finalized |
| An aborted `init_court` leaves the court unusable (`ready=0`) with no re-init path | Low | T-15 |
