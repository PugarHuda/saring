# Saring

**Live demo: https://saring-silk.vercel.app** · Conflict Report: https://pugarhuda.github.io/saring/

**A conflict-blind jury for prediction-market disputes, on Solana with Arcium MPC.**

*Saring* is Indonesian for "filter". Jurors who hold a position in the disputed market are dropped silently. The chain only ever sees ciphertexts: it never sees who sits on the jury, who traded, how anyone voted, or which jurors were excluded, and the MPC never reveals which jurors were excluded. (In this MVP the court authority seats the jurors and relays the positions, so it knows both lists. See [Limitations](#limitations-mvp-and-roadmap).) The only public output is `(yes, no, excluded, incomplete)`, and a pari-mutuel market in the same program pays out on that verdict.

Built for Colosseum's Crypto World's Fair (Sep 14 to Oct 12, 2026). MIT-licensed. Code identifiers still use the working name `blindcourt`.

- **Live on Solana devnet (v3.2, T-8/T-9 lock fixes, [upgrade tx](https://explorer.solana.com/tx/5LMxzKfd4wah6PXzLAEZhkcB7nbPV18vseZHhM6vdon9kLqHJRBxg3p7Txbk5MYGaJqZ1bmQ4aWTxpkEPJdLV4dY?cluster=devnet)):** program [`3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy`](https://explorer.solana.com/address/3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy?cluster=devnet), Arcium 0.15.0 MXE on devnet cluster offset 456 (see [Devnet](#devnet)).
- **Try it:** https://saring-silk.vercel.app. You sit on the jury as juror #6 with your own secret ballot key, cast your own ballot, and can bet 0.01 SOL to watch MPC drop your ballot.
- **Real Panta data:** the demo dispute is a real [Panta](https://panta.market) market. Its holders are read from Panta's program on Solana mainnet (see [Panta integration](#panta-integration)).
- **Conflict Report:** https://pugarhuda.github.io/saring/
- **Verdict proof page:** https://pugarhuda.github.io/saring/court.html lists every court with a Wormhole VAA and, for one court (`?c=<court>`), reads the whole trail live: Solana court account, VAA, and each chain's settle tx.
- **SDK release:** [`sdk-v0.1.1`](https://github.com/PugarHuda/saring/releases/tag/sdk-v0.1.1) (`npm i https://github.com/PugarHuda/saring/releases/download/sdk-v0.1.1/saring-sdk-0.1.1.tgz`; 0.1.1 adds the guardian-signature check to `verifySaringVaa`), quickstart in [`sdk/README.md`](sdk/README.md#quickstart-from-the-release-tarball).

## Chain integrations

The court itself (encrypted state, MPC tally, settlement market) runs only on Solana devnet with Arcium. Each other chain either feeds it real data, pays for it, or consumes its verdict. Rows are ranked by depth: how much of the dispute loop runs on that chain. Status is as of 2026-10-12: **Live** means it ran on a public network and the links show it. Every app card at https://saring-silk.vercel.app/#multichain re-reads these contracts live.

| # | Chain | Folder | Deepest proof | Status | Proof links |
|---|---|---|---|---|---|
| 1 | **Solana devnet + Arcium** | [`programs/`](programs/), [`encrypted-ixs/`](encrypted-ixs/), [`app/`](app/) | The court: encrypted holder set, jury, ballots and seat keys; MPC drops conflicted jurors; a pari-mutuel market pays on the verdict | **Live** | [program `3CeQ…KyfHy`](https://explorer.solana.com/address/3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy?cluster=devnet), [web app](https://saring-silk.vercel.app) |
| 2 | **Base** (mainnet reads + Sepolia) | [`base/`](base/) | **Full Base-native loop.** 12 real holders of the Limitless market "Serie A, Atalanta vs Venezia" read from Base mainnet CTF logs; the top holder is seated as a juror in devnet court [`BT7f…kZhr`](https://explorer.solana.com/address/BT7fCq2tCffGCB8M64gj5o2P4aXLtdG4FjdWgPsqkZhr?cluster=devnet) and dropped by MPC (verdict **NO, 0/2/1**); the verdict goes out as a Wormhole VAA and settles a Reality.eth v3 question on Base Sepolia through `SaringArbitrator.ruleWithVaa`. Ballots are scripted; the Limitless market itself is still resolved by Limitless | **Live** | [ruleWithVaa tx `0x8147…44d2`](https://sepolia.basescan.org/tx/0x8147296f09df926865aeba6eb35215995d896c6ebbae26482fe09737033b44d2), [resolve tx](https://explorer.solana.com/tx/3KSWxCTd3LN37CizsTKTw4nSg2oUshDL7UXu8HKsVmJUrQ38v6auzZBU7SorszJvVjXqEHWoyU6XKp23uadCV5WS?cluster=devnet), [VAA](https://wormholescan.io/#/tx/5C5cb2Hs37Jb6acmy8zkhrdhLUszuW6potuZqKjVZVDryDjjXsbA64XvWSeU3JMdunCBi1Eh32XWtC3smofCjKJm?network=Testnet), [arbitrator `0x3848…682a`](https://sepolia.basescan.org/address/0x384822075dc735ea7de0b8417c9b4403bb9d682a) (Sourcify exact), [`base/README.md`](base/README.md) |
| 3 | **Tempo** (Moderato testnet) | [`tempo/`](tempo/) | **One paid dispute, end to end.** A venue bot gets an MPP 402, pays 0.50 pathUSD, and that payment opens devnet court [`H7Bd…NKU1`](https://explorer.solana.com/address/H7BdJraNzvNQBS6WaYxiaSK9jGrAFqVKfVVaNHSvNKU1?cluster=devnet); MPC drops the conflicted juror (NO 0/2/1); the VAA settles a fresh `SaringMarket` through `settleWithVaa`, sent from a zero-balance address with the fee sponsored by the operator; a TIP-20 memo receipt names the court and `reconcile.ts` maps payment to verdict | **Live** | [MPP payment](https://explore.testnet.tempo.xyz/tx/0x5201309197c561fdf37b1668febb0019b7d04f4577fd2b0cb6d944fc60e9bd45), [market `0x4df7…5eae`](https://explore.testnet.tempo.xyz/address/0x4df7a5af22bb31c5f33cf6d5a0e28859faa45eae), [sponsored settleWithVaa](https://explore.testnet.tempo.xyz/tx/0xb9a99298e7bf68b572617cf12ecc9ea1169f14bcae537341cf00da6e3ca97893), [memo receipt](https://explore.testnet.tempo.xyz/tx/0x67475ad666ffe37fd5811dcf27c152cd12c6c0476774797f5dffcfbb0461add6), [`tempo/README.md`](tempo/README.md) |
| 4 | **Arbitrum** (Sepolia) | [`arbitrum/`](arbitrum/) | **Two arbitration standards.** `SaringArbitratorV2` implements Kleros v2's `IArbitratorV2`: a real `SaringEscrow` dispute was ruled by VAA and the payer refunded (`currentRuling(0) = 2`). `SaringEscalationManager` takes UMA OOv3 disputes away from the DVM and resolves them by VAA. A Stylus (Rust/WASM) verifier sharing the verdict codec is built and tested and ran on nitro-devnode only: Stylus activation is paused on Arbitrum Sepolia and One (`activationGas = 2^64-1`), so it is **not deployed** there | **Live** (Solidity); Stylus devnode only | [ArbitratorV2 `0xc2b4…5ba5`](https://sepolia.arbiscan.io/address/0xc2b4805da6899d788b179f12eb19136bd73f5ba5), [Kleros ruleWithVaa tx](https://sepolia.arbiscan.io/tx/0x4a9da88971511f607a2d45a18866e6dd7dd5ceb2cbab5f78d65226352e18eeea), [OOv3 EM `0x6ae4…c56c`](https://sepolia.arbiscan.io/address/0x6ae4c89bb75291062b204e6ba9d43952786ec56c), [resolveWithVaa tx](https://sepolia.arbiscan.io/tx/0xafb717d9c06f195b4a952030c4f084ce2d316e54054750b910cf456517d95587), [`arbitrum/README.md`](arbitrum/README.md) |
| 5 | **Ethereum L1** (mainnet reads + Sepolia) | [`ethereum/`](ethereum/) | **70/70 conflicted `VoteRevealed` rows proven against mainnet block headers** (receipt → receipts trie → `receiptsRoot` → block hash), with an offline verifier; 4,079 of 4,121 Conflict Report tallies rebuilt exactly from L1 logs (42 differences explained). `UmaConflictRegistry` commits the conflicted-voter set as a Merkle root; a UMA OOv3 escalation manager on Sepolia resolves by VAA. Polygon balances are still RPC-trusted | **Live** | [`vote-proofs.json`](ethereum/out/vote-proofs.json) (`npx tsx prove-votes.ts --verify --offline`), [registry `0x4e87…BE55`](https://sepolia.etherscan.io/address/0x4e87CC9fD0791bC8cF85d9f49772E193BCD5be55), [resolveWithVaa tx](https://sepolia.etherscan.io/tx/0x914337a888d19e0cc6d96dac017234deb8f461948b921a323d0ef293de87db44), [`ethereum/README.md`](ethereum/README.md) |
| 6 | **Zcash** (NU7 testnet) | [`zcash/`](zcash/) | **Shielded bonds with slashing.** Jurors commit their payout address on Solana with a per-court seat key; the no-show (juror3) is slashed and its bond goes to the voters; one shielded payout tx; a public verifier using only the published viewing key (UFVK) passes 12/12 checks. Limit: the operator still decides which voters were conflicted, and only the count is checked | **Live** | [payout tx `9a7d57ae…755b`](https://testnet.zecblock.com/tx/9a7d57aee89f19209d32b48c7e5dc54168904b0f7d4520b7efa769156d0b755b), [court `8bX2…GNFm`](https://explorer.solana.com/address/8bX2MwDZof48jfgfGGE1T7sMJwa6aojWvbazzpTfGNFm?cluster=devnet), [verifier report](zcash/out/verify-8bX2MwDZof48jfgfGGE1T7sMJwa6aojWvbazzpTfGNFm.md), [`zcash/README.md`](zcash/README.md) |
| 7 | **Solana mainnet** (Panta, via Solami) | [`panta/`](panta/) | Reads real Panta holders into the demo court; scans Panta's whole history (4 disputes, every one settled by a Panta admin key); live feed and stats over Solami gRPC/RPC | **Live** (reads only; Solami Mirage refused for our key) | [`panta/README.md`](panta/README.md) |
| 8 | **Solana devnet** (PNP Exchange, a third-party venue) | [`pnp/`](pnp/) | **Saring settles another venue's own program.** A market on PNP's devnet program is created with the Saring court authority as its custom oracle; two wallets take YES and NO; the YES holder is seated as a juror in court `47GB…m1hF` and dropped by MPC (NO 0/2/1); the verdict calls PNP `settleMarket` and the NO side redeems. Settlement is a crank keyed to the court authority (CPI from Saring is the upgrade path); prior art: internet-court-skill also uses PNP's custom oracle | **Live** | [create market](https://explorer.solana.com/tx/5Arw4yqSpQExhLK5mP2ZJEUrhuQaDbVCNhEbDp7sD1izcWMWDSEqz1cnh48oJYeVgH8oWyEnFtEw3iQmy1HMonQJ?cluster=devnet), [settle](https://explorer.solana.com/tx/62ttfBdoatuQggXSYBizd3rV6AACEY6hHHnewzGjKXMib1S7yDZk7w58TR9yD7M6Y24RbyyXZFdEhjGXPhfqv9Dj?cluster=devnet), [NO redeem](https://explorer.solana.com/tx/66QqEECQujyx4QittXnT8k1GsCPmG9TvjCsMc8z7gJm9pfDFA9tLTB4WiXrshhGXMCX7Hq58dNSvv6dp3YFXWZtE?cluster=devnet), [`pnp/README.md`](pnp/README.md) |
| 9 | **Hyperliquid** (HIP-4 mainnet reads) | [`hyperliquid/`](hyperliquid/) | Real holders of HIP-4 question #391 mirrored into devnet court `FoRH…zPQBv`; verdict NO with the holder-juror dropped. `SaringHyperCourt` on HyperEVM (VAA or EIP-712 settle, bond refunded on HyperCore through CoreWriter `spotSend`) is built and passes 10 tests, **not deployed** (waiting on testnet HYPE gas); `settle.ts` is ready for a sub-deployer grant. No `settleOutcome` was submitted | Court **Live**; settlement **not deployed** | [resolve tx](https://explorer.solana.com/tx/5vskW3KgJ9WYKgkzy8773i3tF7aFpUwqvviLNYodNyAjm8oCkNCVwKz7wF5nfNSw3BN31t8uCjTU6xZCHNFgGfNX?cluster=devnet), [`hyperliquid/README.md`](hyperliquid/README.md) |

**Skipped: Robinhood Chain.** Neither UMA nor Reality.eth is deployed there, and there is no Wormhole core bridge on chains 4663/46630 to carry a verdict. Stock-token holders can only be enumerated with thousands of capped `eth_getLogs` calls, and testnet stock-token addresses could not be verified. We would have had to invent the dispute venue, so we left it out.

### Trust model: EIP-712 relayer → Wormhole VAA

| | Before (legacy deployments only) | Now (Wormhole VAA, `relayer = 0`) |
|---|---|---|
| Who states the verdict | One Saring relayer key signs an EIP-712 `Verdict` | The `saring_wormhole` program ([`DdNYVoQV…WdPq`](https://explorer.solana.com/address/DdNYVoQVXZdWjAaYq9pnrH2fec17F1QnSXDyfnTQWdPq?cluster=devnet)) reads the resolved Saring court on-chain and posts it as a Wormhole message ([Solana tx](https://explorer.solana.com/tx/5WtYWwEuDrMmkyaQt7hfX8bdcGrqom19AbLUXnGMX43kHjcoVRTqAzXeXj3vheF2vFg9SPgvySj9H7aQJRiREy7Z?cluster=devnet)) |
| What the EVM contract checks | `ecrecover == relayer` | Guardian signatures via the chain's own Wormhole core bridge, emitter = the program's PDA on Solana, payload court = bound court |
| Can Saring forge a verdict? | Yes, by signing anything | Not through the message path (see limits). A contract with a Wormhole core can't be deployed with a relayer at all (`RelayerWithVaa`) |

What each chain now trusts, deepest first:

| Chain | Verdict / data path | What you still trust |
|---|---|---|
| Base | Real mainnet holders → court → VAA → Reality.eth ([tx](https://sepolia.basescan.org/tx/0x8147296f09df926865aeba6eb35215995d896c6ebbae26482fe09737033b44d2)) | Wormhole testnet guardian; the owner key that binds court to question; the public RPCs that served the holder logs |
| Tempo | MPP payment → court → VAA → sponsored `settleWithVaa`; market deployed with `relayer = address(0)` (VAA only) ([tx](https://explore.testnet.tempo.xyz/tx/0xb9a99298e7bf68b572617cf12ecc9ea1169f14bcae537341cf00da6e3ca97893)) | Wormhole testnet guardian; the MPP payment → court link sits in the server ledger (the memo receipt names the court on chain) |
| Arbitrum | Kleros `IArbitratorV2` and OOv3 EM, both by VAA ([tx](https://sepolia.arbiscan.io/tx/0x4a9da88971511f607a2d45a18866e6dd7dd5ceb2cbab5f78d65226352e18eeea)) | Wormhole testnet guardian; the owner key that binds court to dispute |
| Ethereum | Votes: block headers only ([bundle](ethereum/out/vote-proofs.json)); OOv3 EM by VAA | That 68 block hashes are canonical (checked on 3 providers); Polygon balances are RPC-trusted |
| Zcash | Payouts checked by anyone with the published UFVK ([report](zcash/out/verify-8bX2MwDZof48jfgfGGE1T7sMJwa6aojWvbazzpTfGNFm.md)) | The operator picks which voters were conflicted (only the count is checked) and must send the payout |
| Hyperliquid | Court live; settlement contract not deployed | Everything past the court verdict is unproven on chain |

The same VAA (court `24gQ…YGb`) settled four adapters, first on the pre-review contracts and again on the VAA-only redeploys: [Base `ruleWithVaa`](https://sepolia.basescan.org/tx/0x7595811eceb6825878bce3ff5f64ce5c6e6ae2be375026107023e8e14ebe532e) · [Arbitrum `resolveWithVaa`](https://sepolia.arbiscan.io/tx/0x89ebcbca147f046ceb8df1adc30d4436f1fdd3a8d25f16ff7a75754c6d249617) · [Ethereum Sepolia `resolveWithVaa`](https://sepolia.etherscan.io/tx/0x46ee84adb1ac62fb692fffdc8b58d06232e11c89dc47df2cdf0604dd6fe7aeec) · [Tempo `settleWithVaa`](https://explore.testnet.tempo.xyz/tx/0x4ef420f2ffcf25d29921dbe56d8b0f31e1c9ca840bd547609918af8bee73d0c1), and the Kleros V2 escrow. The Base and Tempo loops above each posted their own VAA (sequences 1 and 2). Foundry fork tests run against each chain's real core bridge with the recorded VAA (tampered payload, wrong emitter and wrong court all revert). We used the core message path because Wormhole Queries is a closed beta. **Limits:** the testnet guardian set is a single guardian (mainnet is 13 of 19), and `saring_wormhole` and the Saring program are still upgradeable by our wallet. Details: [`wormhole/README.md`](wormhole/README.md).

### Security fixes after review (2026-10-13)

An adversarial review of the last 30 hours of code found two High issues in the EVM adapters. Both are fixed in the source
and on chain. Status of every finding is in the per-chain READMEs (sections "Known issues").

- **The relayer key could still rule on the Wormhole deployments (High).** Fix: `SaringWormhole._requireVaaOnly` makes a
  contract with a Wormhole core revert `RelayerWithVaa` if it is built with a relayer, so the EIP-712 path exists only on
  core-less (legacy) deployments. The four affected contracts held `relayer` as an immutable with no setter, so they were
  redeployed with `relayer = 0` (each reads back `relayer() == 0x0` and is Sourcify exact match), and each one settled a new
  dispute from the same recorded VAA:
  [Tempo `0xab3a…c639`](https://explore.testnet.tempo.xyz/address/0xab3a24e55b84eafd0767c71797b7aa75e16ec639) ([settleWithVaa](https://explore.testnet.tempo.xyz/tx/0x4ef420f2ffcf25d29921dbe56d8b0f31e1c9ca840bd547609918af8bee73d0c1)) ·
  [Arbitrum EM `0xc36d…4b58`](https://sepolia.arbiscan.io/address/0xc36dd39a3fc1831a2813e20316f998c08fb74b58) ([resolveWithVaa](https://sepolia.arbiscan.io/tx/0x89ebcbca147f046ceb8df1adc30d4436f1fdd3a8d25f16ff7a75754c6d249617)) ·
  [Sepolia EM `0x4101…115c`](https://sepolia.etherscan.io/address/0x41014a50d7582ae90b50d0b1da0c1ccbaac0115c) ([resolveWithVaa](https://sepolia.etherscan.io/tx/0x46ee84adb1ac62fb692fffdc8b58d06232e11c89dc47df2cdf0604dd6fe7aeec)) ·
  [Base arbitrator `0xad38…f8c5`](https://sepolia.basescan.org/address/0xad38eb68f9912f39e201960f22e584d650f2f8c5) ([ruleWithVaa](https://sepolia.basescan.org/tx/0x7595811eceb6825878bce3ff5f64ce5c6e6ae2be375026107023e8e14ebe532e)).
  The old contracts (`0x5780…f482`, `0x6ae4…c56c`, `0x2618…dcda0`, `0x3848…682a`) still accept the relayer key and are kept only as history.
  The Kleros `SaringArbitratorV2` never had a relayer.
- **Tempo bets were accepted after the verdict was public (High).** Fix: the owner opens each court with `open(court, closesAt)`
  before voting starts, and `bet` reverts `MarketClosed` at or after `closesAt` and on courts never opened. The live run shows a
  bet after the deadline rejected, then `settleWithVaa` and the claim.
- **Medium:** the escrow uses pull payments (a reverting party can't block `ruleWithVaa`); the Reality.eth arbitrator has a
  permissionless `cancelArbitration` after 7 days; the faucet checks Origin and can't pay twice after a timeout; the RPC proxy
  limits uncached mainnet scans; the SDK's `verifySaringVaa` checks guardian signatures (`sdk-v0.1.1`); the proof page
  shows only events from Saring's own contracts. Foundry: 60 tests across the four adapters, including a relayer-signed
  verdict rejected by every VAA-only contract.

---

## Why

When a prediction market is disputed, someone has to decide the outcome. On Polymarket that is UMA token voters. We matched every resolved UMA yes/no request on a Polymarket market since Jan 1, 2025 to the voters' Polymarket wallets (method and code in the [Conflict Report](https://pugarhuda.github.io/saring/)):

| Metric | Value |
|---|---|
| UMA disputes mapped to Polymarket markets | 4,121 |
| UMA voters who control a Polymarket wallet | 60.4% (3,743 of 6,198) |
| Disputes where at least one voter held a position in that market at vote time | 20.2% (834 of 4,121) |
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

Panta's REST API (`live-api.panta.market/api/v1`, `X-Api-Key`) is used by the web app through a server proxy, [`app/api/panta.js`](app/api/panta.js), so the key never reaches the browser. The app uses three endpoints: the market catalog (the market picker, joined with on-chain holder counts), market detail (the market card and the titles in the live feed) and per-wallet positions (the god-view cross-check of each juror against chain). Holders still come from chain: the API has no endpoint that lists a market's holders, and the on-chain accounts are the source of truth. `panta/check.ts` is a quick mainnet sanity check: it prints the question, holder and trader counts, and whether the identity ids are unique.

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
| Program | [`3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy`](https://explorer.solana.com/address/3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy?cluster=devnet), upgraded in place to v3.2 ([upgrade tx](https://explorer.solana.com/tx/5LMxzKfd4wah6PXzLAEZhkcB7nbPV18vseZHhM6vdon9kLqHJRBxg3p7Txbk5MYGaJqZ1bmQ4aWTxpkEPJdLV4dY?cluster=devnet); v3 built with `opt-level = "z"`, 614 KB) |
| Arcium MXE | devnet cluster offset **456**, Arcium 0.15.0 |
| Original deploy tx | [`4bANmR3H…vdLDcV36`](https://explorer.solana.com/tx/4bANmR3HSzStMSo8z54RSBkh2YKDdQZPRT7kcfjYSLo6JWtvoXAshVwU8zWqQDFEQGLJc4Fmt6Lvqu5EvdLDcV36?cluster=devnet) |
| MXE init tx | [`dCSh4xpn…6iHtd`](https://explorer.solana.com/tx/dCSh4xpnt1FtZPwu4sSDezwBgVmre3hSqXYPJAxV84oQ3nSzHM23Y4tuieSXmqStGqAZys1xji1XVhrEwY6iHtd?cluster=devnet) |
| Circuits | GitHub release `circuits-v3` of this repo, pinned by hash |

All five v3 computation definitions are initialized. Verified v3 runs on devnet:

- **Browser, production app:** the visitor voted NO and bet NO. Verdict yes=0 no=2 excluded=4 incomplete=false (the visitor's own ballot was dropped as a conflict), and the 0.01 SOL bet was paid out and claimed.
- **CLI, scripted scenario** (stale-key bribe, forged overwrite, market claim): yes=0 no=2 excluded=3, and the NO bettor was paid the 0.03 SOL pool. (court AyL12VgeDcf5PNrBEujyptgJ7V9MSwYyr8Eftuc7vMPk; payout 0.029995 SOL after fee; vault emptied)

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

- One-click faucet: 0.15 SOL to the burner; one run costs about 0.10 SOL (about 0.105 with a bet).
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
tempo/                          Tempo: memo fees, MPP pay-per-court, paid dispute end to end, SaringMarket settled by VAA
ethereum/                       Ethereum L1: UMA votes rebuilt from logs, header-anchored vote proofs, UmaConflictRegistry
zcash/                          Zcash: shielded juror bonds, slashing, committed payouts, UFVK verifier
hyperliquid/                    Hyperliquid HIP-4: real holders mirrored into a court; HyperEVM SaringHyperCourt (not deployed)
arbitrum/                       Arbitrum: UMA OOv3 escalation manager, Kleros v2 IArbitratorV2, Stylus verifier
base/                           Base: Reality.eth v3 arbitrator, real Limitless holders -> court -> VAA loop
wormhole/                       saring_wormhole emitter program, shared verdict codec, VAA verifier contracts
```

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md): components, encrypted state slot map, PDAs, instructions, lock state machine, sequence diagrams
- [THREAT_MODEL.md](THREAT_MODEL.md): actors, trust assumptions, STRIDE threats, bribery / receipt-freeness argument, privacy leakage
- [SECURITY.md](SECURITY.md): how to report a vulnerability, supported versions, review history, known limitations
- [AUDIT_SCOPE.md](AUDIT_SCOPE.md): in-scope files, invariants, build/test, deployed addresses, `circuits-v3` hashes
- CI: [`.github/workflows/ci.yml`](.github/workflows/ci.yml)

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
| Rewards and no-show slashing exist only in the Zcash bond flow, run by the operator; no appeals | Not a full court yet | Fee from the losing dispute bond; appeal round with a larger jury |
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
