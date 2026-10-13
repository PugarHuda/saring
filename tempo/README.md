# Saring on Tempo

Saring is a conflict-blind jury for prediction-market disputes. It runs on Solana devnet with Arcium MPC. This folder connects it to **Tempo** (the Stripe + Paradigm payments L1), so dispute resolution can be bought and settled in stablecoins:

| Piece | What it does | Tempo features used |
|---|---|---|
| `fee.ts` | A venue pays Saring's per-dispute fee: 1.00 pathUSD via TIP-20 `transferWithMemo`, where the memo is the 32-byte Saring court pubkey. The script then decodes the memo back from the on-chain event. | TIP-20 memo, stablecoin gas (AlphaUSD), programmatic faucet |
| `reconcile.ts` | Scans `TransferWithMemo` events paid to the operator, maps memo to Saring court, reads each verdict from Solana devnet, and prints an invoice/settlement table. | TIP-20 memo events |
| `mpp-server.ts` / `mpp-client.ts` | `POST /courts` is paid per request over MPP. The server answers with a 402 challenge, the client pays 0.50 pathUSD on Tempo, and the server then opens a real Saring court on Solana devnet and returns it with a `Payment-Receipt`. | Machine Payments Protocol (`mppx`, `tempo.charge`, `testnet: true`) |
| `contracts/src/SaringMarket.sol` | A YES/NO pari-mutuel market in a TIP-20 stablecoin. It settles **only** on an EIP-712 Verdict attestation signed by the Saring relayer, checked with `ecrecover` (high-s signatures are rejected). Ties, incomplete verdicts and an empty winning side are refunded. Claims pay pro rata, and betting closes once settled. | TIP-20 as ERC-20, Foundry on Tempo, Sourcify verifier |
| `relayer.ts` | Reads a resolved court on Solana (`sdk/src/venue.ts` `readCourtVerdict`, which rejects accounts the Saring program doesn't own), signs the EIP-712 Verdict, and submits `settle()` as a Tempo 0x76 transaction with gas paid in AlphaUSD. It refuses unresolved courts. | Tempo tx type 0x76, fee token |
| `market.ts` | End to end: deploy, then two bettors each send **one atomic 0x76 batch tx (approve + bet)**, then relay the verdict, the winner claims, and the loser's claim and a late bet are both shown to revert. | batched calls in one Tempo tx |


**Wormhole path.** `SaringMarket` now also has `settleWithVaa(vaa)`: any bettor can settle with a guardian-signed VAA from the
`saring_wormhole` program on Solana, checked by Wormhole's Tempo testnet core `0xa29E8c21924834E6249bCE1FD733f24eC492018c`. No relayer key is involved.
Live (after the security review: `relayer = 0`, betting deadline): market [`0xab3a…c639`](https://explore.testnet.tempo.xyz/address/0xab3a24e55b84eafd0767c71797b7aa75e16ec639) (Sourcify exact match),
[open(court, closesAt)](https://explore.testnet.tempo.xyz/tx/0x36ae58968e91887286ba0b63415f57d956ffc3a08e390f0dbfa8038952aa10c8), [bet A YES](https://explore.testnet.tempo.xyz/tx/0xdea2a071d10f92d0210fdb03c9872fb51e30a2048b4e826b43fc38a31637c226),
[bet B NO](https://explore.testnet.tempo.xyz/tx/0xdffac2ec7d21bb912fef13bcd20c098900af749a671f8f8d3d94551aa56b9bc5), a bet after `closesAt` rejected (`MarketClosed`),
[settleWithVaa](https://explore.testnet.tempo.xyz/tx/0x4ef420f2ffcf25d29921dbe56d8b0f31e1c9ca840bd547609918af8bee73d0c1) giving outcome No, [claim B +5 pathUSD](https://explore.testnet.tempo.xyz/tx/0x855ab9a0f3d3b20ec26584c706de8a1bb1463897a75dc1a29e24044b4a272a5f).
The earlier market [`0x5780c7e5…f482`](https://explore.testnet.tempo.xyz/address/0x5780c7e56f46ae0df0e43acfc184b0c47ea0f482) ([settleWithVaa](https://explore.testnet.tempo.xyz/tx/0x93b87af3d4c0ac42db03178eb91672c962f01e3e32542af06063574d51b5bddc)) still trusts a relayer key and is history only. Details are in [`../wormhole/README.md`](../wormhole/README.md).
The constructor is now `(token, relayer, wormhole, emitter)`.

## Live run on Moderato testnet (chain 42431), 2026-10-12

Explorer: https://explore.testnet.tempo.xyz. Saring court used: `24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb` (Solana devnet, resolved **NO**: yes 0 / no 1 / excluded 1).

| Step | Tx |
|---|---|
| Dispute fee 1.00 pathUSD, memo = court `0x0fccfd5d…a36aa5f04` | [0xfd2ecd44…](https://explore.testnet.tempo.xyz/tx/0xfd2ecd44cbd7f47565e4cec1451ab74660303f752c6c4cb37ff9a3e698e37846) |
| MPP payment 0.50 pathUSD that opened court `Fy8oQL3Paip4HAZd2gVGCBrZWYGqTbgUZT3gP4BPpPek` (devnet init queue `4Zcawvev…`, callback `5XgJHaXP…`) | [0xb8ec2dff…](https://explore.testnet.tempo.xyz/tx/0xb8ec2dff1a5db3ef02b6425d086fe037a1f817a643a8f78868665e89afe680af) |
| SaringMarket deployed at [`0x256EebAd0930Fe8e899B5E7C239130db50Af0446`](https://explore.testnet.tempo.xyz/address/0x256EebAd0930Fe8e899B5E7C239130db50Af0446) (Sourcify **exact_match** on contracts.tempo.xyz) | [0x6f86607d…](https://explore.testnet.tempo.xyz/tx/0x6f86607ddf98a9242e41c5861de55e7a09d295d85719291b296a3244ca74e837) |
| Bettor A: 3 pathUSD YES (approve + bet in one 0x76 tx) | [0x14fb519e…](https://explore.testnet.tempo.xyz/tx/0x14fb519e96ad3cb58a2c93b48a7bb5bab9b0e8c7c7ca042ba18197860525d79e) |
| Bettor B: 2 pathUSD NO (approve + bet in one 0x76 tx) | [0x24a545f7…](https://explore.testnet.tempo.xyz/tx/0x24a545f7c75afc27946365fefdb0493a772461a642278dc89857a3080f537d43) |
| Relayer `settle()` with the EIP-712 verdict (Solana slot 510221975), resulting in outcome No | [0x05a3e445…](https://explore.testnet.tempo.xyz/tx/0x05a3e4459f2988318d887d027fd94047ffe3c630d6c7fc85b02b42992dd5340d) |
| Bettor B claims 5.00 pathUSD (whole pool); A's claim reverts `NothingToClaim`, a late bet reverts `MarketClosed` | [0xaaded73b…](https://explore.testnet.tempo.xyz/tx/0xaaded73b50f2665ea43d78dea69e814259b134fe6e391a295ab8360e4e21bd01) |

Reconcile output (`out/reconcile.log`): 2 payments, 1.50 USD, 0 unmatched. The fee matched via its memo (court resolved NO). The MPP payment matched via the server ledger (court still OPEN).

Logs are in `out/*.log`, every hash is in `out/state.json`, and `out/forge-test.log` holds the 9 passing Foundry tests (pro-rata payout, bad and tampered signature, high-s, double settle, tie, incomplete, empty winning side, claim before settle, zero bet).

## One paid dispute, end to end (`mpp-e2e.ts`), 2026-10-12

`npx tsx mpp-e2e.ts` runs the full machine-payable dispute in one command (`--resume` continues from the checkpoint in `out/state.json` if the Tempo RPC drops a request). Log: `out/mpp-e2e.log`. This closes the gap noted below: the paid court is now juried, resolved, attested and settled.

| # | Step | Tx |
|---|---|---|
| 1 | Venue bot gets the 402, pays **0.50 pathUSD** over MPP; `mpp-server.ts` opens court [`H7BdJraN…NKU1`](https://explorer.solana.com/address/H7BdJraNzvNQBS6WaYxiaSK9jGrAFqVKfVVaNHSvNKU1?cluster=devnet) (id 1390085623) | Tempo [0x52013091…](https://explore.testnet.tempo.xyz/tx/0x5201309197c561fdf37b1668febb0019b7d04f4577fd2b0cb6d944fc60e9bd45), devnet [open](https://explorer.solana.com/tx/3DW7QAmNitw36WgGvdB1vnRJJQb5kchdsxJSyR9hcnoWhSHrEZ6PPy5atMEPff68tuQgcUj1x1gNfxS54Y8ahgeu?cluster=devnet) |
| 2 | 3 jurors seated; juror A's identity is mirrored (encrypted) as a position holder | [seat A](https://explorer.solana.com/tx/2FRzme9eYqN6AqR6ut8K6dyvzVtqbxMueSrDdX5ozT59ukFAJntU3qvgBLkbNGkAoMpzqFAgokpuXC8N9Tn4GhFU?cluster=devnet), [seat B](https://explorer.solana.com/tx/3iT3VgUuzV5Q2XBcCEoZoDC5qY6JgXxD4cSs3oN8ZUfCdrBhkyHJ6koXHyNjMYDzYKYArsoohwXYQydYGwu2uouW?cluster=devnet), [seat C](https://explorer.solana.com/tx/3WyvtkcpciDWhwWzHDkPwtC5L9i7jfnvZqcnYgJ7tNDsdNEBGWbMnrkpbLNvKy3j2i4DZKpSQwTWjb2S4crAEpzF?cluster=devnet), [mirror](https://explorer.solana.com/tx/4dxdBYQEveTpQhYWKBTULQQyb7UHmX8HQQ1n7dX9NmYsqFxNR9JyBso4SY4vP29x8Ffczouenx45vDs8bfXLNgbd?cluster=devnet) |
| 3 | Ballots A YES, B NO, C NO; Arcium MPC drops A's ballot and resolves **NO (yes 0 / no 2 / excluded 1)**; 0.063 devnet SOL total | [cast A](https://explorer.solana.com/tx/o4ugxgPPWvvLzZPLJicwp25tN2pqJMpaM1FQRYdrX2vgea27JaAPi3oYnLGkgkinBkj78cnuJFfEnnf9XFhAYeU?cluster=devnet), [cast B](https://explorer.solana.com/tx/42BzGc4e4zqpRkgJveRHBKHxp51RVZim4vTb6RopdDUXufLzNpmv9Wx7C4RNZrGcjtzdy5yDJKpjMXaYYwcwe1mA?cluster=devnet), [cast C](https://explorer.solana.com/tx/4Zc7gYeTHPKKWamcCxreStUi8Tzxe5Y6E9fgpq5ipyrDtXqfaCPqq3a3azFaZDKwrcmQ9QfxGx64HG46mv1Diy4S?cluster=devnet), [resolve](https://explorer.solana.com/tx/5hYSQ4Cj5es4yBHxkqd5HaxeYsnr2HGA6CrxcyrcBR2SosmmrAcXFNhMKk9DTTC96YWoBRZbKygtoi2Ju2yaqgSH?cluster=devnet) |
| 4 | `saring_wormhole` posts the verdict; guardian-signed VAA seq 2 | [post](https://explorer.solana.com/tx/5RHLwLv5w4qUf2wjsj4sLLzNpRFPyUD96RmPBJaf5g4M4urCPAj5mFKjinBTKPem48T6DYdQZLKeHP3fPcEQGmmq?cluster=devnet), [Wormholescan](https://wormholescan.io/#/tx/5RHLwLv5w4qUf2wjsj4sLLzNpRFPyUD96RmPBJaf5g4M4urCPAj5mFKjinBTKPem48T6DYdQZLKeHP3fPcEQGmmq?network=Testnet) ([API](https://api.testnet.wormholescan.io/api/v1/vaas/1/54c231cefc5bd0966f82594e4333d6211f9a1ab4740be61271fdcb2d5ceb6238/2)) |
| 5 | Fresh `SaringMarket` [`0x4df7a5af…5eae`](https://explore.testnet.tempo.xyz/address/0x4df7a5af22bb31c5f33cf6d5a0e28859faa45eae) for this court, `relayer = address(0)` (VAA only); bets A 3 YES, B 2 NO (approve+bet in one 0x76 tx each) | [deploy](https://explore.testnet.tempo.xyz/tx/0xc627c35245159af11dd13b8cdcc5169372690441c07990f76d0347c5e8e92d11), [bet A](https://explore.testnet.tempo.xyz/tx/0x9283672603f07f26c4c694080aeb7dffd347fadca7d9ae1478715b32dadcbfdf), [bet B](https://explore.testnet.tempo.xyz/tx/0x2e373f941fceb5811d6610b5d4fdd3409a375ea4e9a4fda1877e58e16bcbda53) |
| 6 | **`settleWithVaa` sent by a fresh zero-balance address `0x621B…8246` as a 0x76 tx with `feePayer` = operator**, fee paid in pathUSD (0.000199) out of the 402 income; outcome No | [settle](https://explore.testnet.tempo.xyz/tx/0xb9a99298e7bf68b572617cf12ecc9ea1169f14bcae537341cf00da6e3ca97893), [claim B +5.00](https://explore.testnet.tempo.xyz/tx/0xf5346c3fd006e565bf8ebfa66b38317bc6db32b6851f0a7447c54aeb9dfeecbd) |
| 7 | Receipt: operator `transferWithMemo` 0.01 pathUSD to the payer, memo = court pubkey `0xef507d93…825e` | [receipt](https://explore.testnet.tempo.xyz/tx/0x67475ad666ffe37fd5811dcf27c152cd12c6c0476774797f5dffcfbb0461add6) |
| 8 | `reconcile.ts`: the 0.50 payment maps (MPP ledger) to `H7Bd…NKU1`, verdict **NO (yes 0 / no 2 / excluded 1)** | `out/mpp-e2e.log` |

Notes: the memo carries the court only (TIP-20 memos are 32 bytes); the verdict is read from Solana by anyone holding it. The bet-A request got a Cloudflare 502 but the tx landed; its hash was recovered from the market's logs and the run resumed.

## Setup

```bash
cd ~/blindcourt/tempo
npm install                                   # viem 2.57 (viem/tempo), mppx 0.13, tsx
curl -L https://foundry.paradigm.xyz | bash && foundryup
(cd contracts && forge install foundry-rs/forge-std --no-git && forge build && forge test)
```

- **Keys:** `~/.saring-tempo/keys.json` (mode 0600, outside the repo) holds the roles venue, operator, relayer, bettorA and bettorB. It is created on first use and never printed. `~/.saring-tempo/mpp-secret` holds the MPP HMAC secret.
- **Funding:** fully programmatic. `client.faucet.fundSync` uses Tempo's `tempo_fundAddress` testnet faucet, which gives 1M each of pathUSD/AlphaUSD/BetaUSD/ThetaUSD per call. No captcha.
- **Solana:** `RPC_URL` (devnet) comes from `~/blindcourt/.env.local` and is never printed. The MPP server opens courts with `~/.config/solana/id.json` as authority, which needs devnet SOL (it refuses below 0.02 SOL).
- **Env:** `MPP_SECRET_KEY` (server), `PORT` (default 8787), `COURTS_URL` (client).

## Commands

```bash
npx tsx fee.ts [court]                      # pay + verify dispute fee
npx tsx reconcile.ts [fromBlock]            # settlement table
MPP_SECRET_KEY=$(cat ~/.saring-tempo/mpp-secret) npx tsx mpp-server.ts &
npx tsx mpp-client.ts "question <= 64 bytes" # 402 -> pay -> court id
npx tsx market.ts [court]                   # deploy, bet, relay, claim (needs forge build + market-abi.ts)
npx tsx relayer.ts <court> [market]         # relay one verdict to an existing market
npx tsx mpp-e2e.ts [question|--resume]      # 402, court, jurors, MPC, VAA, sponsored settle, receipt, reconcile
```

`market-abi.ts` is generated from `contracts/out` after `forge build`:
`node -e 'const a=require("./contracts/out/SaringMarket.sol/SaringMarket.json").abi;require("fs").writeFileSync("market-abi.ts","export const marketAbi = "+JSON.stringify(a)+" as const;\n")'`

## Design notes and limits

- **Trust:** the market trusts one relayer key, and the attestation is only as honest as that key. The verdict itself is public on Solana, so anyone can check a signed attestation against `CourtAccount` and catch a lying relayer. Removing that trust (light client, Wormhole-style guardians, or multiple relayers with k-of-n) is future work.
- **`resolvedSlot`:** `CourtAccount` stores no resolution slot, so this field is the Solana slot at which the relayer saw the court already resolved. It is an upper bound, not the exact slot.
- **One market per court:** markets are keyed by court pubkey, so a court can be settled once, by any submitter, but only with the relayer's signature.
- **MPP vs memo:** MPP `charge` writes its own attribution memo, and the court doesn't exist until after payment. So MPP payments reconcile through the server's ledger (payment tx → court in `out/state.json`), while direct fees reconcile purely on-chain through the memo. The ledger is a local JSON file. Production needs a real DB, and `tempo.charge` needs a shared `store` for replay protection across instances.
- **Earlier MPP court:** `Fy8o…` was opened but never juried, so `relayer.ts` correctly refuses it. `mpp-e2e.ts` (above) is the run where the paid court is juried, resolved and settled.
- **Rounding:** pro-rata division can leave a few base units of dust in the contract.
- **Scanning:** `reconcile.ts` uses a fixed 50k-block `getLogs` window. Use an indexer at scale.
- Testnet only: Moderato tokens have no value.

## Known issues (security review, 2026-10-13)

Status: both High findings are **fixed** in `contracts/src/SaringMarket.sol` and in the redeployed market `0xab3a…c639` above.
`0x5780…f482` and `0x4df7…5eae` were deployed before the fix and keep the old behaviour.

- **Fixed: betting stayed open after the verdict was public (High).** Now the owner calls `open(court, closesAt)`, and `bet`
  reverts `MarketClosed` at or after `closesAt` (and on courts never opened). Tests: `test_betAfterDeadline_reverts`,
  `test_betOnUnopenedCourt_reverts`, `test_open_onlyOwner_once_futureDeadline`. The deadline must be set before the
  court's voting starts; the live demo reuses an already-resolved court, so there it only shows the mechanism. Original finding: `bet` closes only when someone calls `settle`/`settleWithVaa`.
  Once the court resolves on Solana, its tally sits in a public account, but the VAA needs Solana finality plus guardian
  observation, and someone has to relay it. In that window, or at any later time until someone settles, an attacker bets
  heavily on the known winner and then settles in the same block. Example: pools are 100 YES / 100 NO and YES won. The
  attacker bets 10,000 YES and claims 10,000 * 10,200 / 10,100 = 10,099, which takes 99 of the honest YES side's 100
  winnings. Fix: give each market a deadline set before the jury votes, `open(court, closesAt)`, and have `bet` require
  `block.timestamp < closesAt`. Or settle only VAAs whose Wormhole `timestamp` comes before the deadline, so later bets refund.
- **Fixed: the relayer fallback was live on `0x5780…f482` (High).** A market with a Wormhole core can no longer be built with a relayer
  (`RelayerWithVaa`; tests `test_relayerWithWormhole_cannotDeploy`, `test_vaaOnly_rejectsRelayerSignedVerdict`). Original finding: Its `relayer()` is `0x1cc1…c5ec`, so that key can settle any court's
  market with any tally, before the court resolves. `0x4df7…5eae` is VAA-only (`relayer = 0`). See `wormhole/README.md`.
- **Only the owner opens markets now (Info; before, anyone could bet on any court).** Courts are still permissionless on Solana,
  so the owner must open only courts whose authority it trusts.
- Rounding: `claimable` floors, so dust of up to `#winners` base units stays in the contract. Funds are never over-paid.
