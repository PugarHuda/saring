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
```

`market-abi.ts` is generated from `contracts/out` after `forge build`:
`node -e 'const a=require("./contracts/out/SaringMarket.sol/SaringMarket.json").abi;require("fs").writeFileSync("market-abi.ts","export const marketAbi = "+JSON.stringify(a)+" as const;\n")'`

## Design notes and limits

- **Trust:** the market trusts one relayer key, and the attestation is only as honest as that key. The verdict itself is public on Solana, so anyone can check a signed attestation against `CourtAccount` and catch a lying relayer. Removing that trust (light client, Wormhole-style guardians, or multiple relayers with k-of-n) is future work.
- **`resolvedSlot`:** `CourtAccount` stores no resolution slot, so this field is the Solana slot at which the relayer saw the court already resolved. It is an upper bound, not the exact slot.
- **One market per court:** markets are keyed by court pubkey, so a court can be settled once, by any submitter, but only with the relayer's signature.
- **MPP vs memo:** MPP `charge` writes its own attribution memo, and the court doesn't exist until after payment. So MPP payments reconcile through the server's ledger (payment tx → court in `out/state.json`), while direct fees reconcile purely on-chain through the memo. The ledger is a local JSON file. Production needs a real DB, and `tempo.charge` needs a shared `store` for replay protection across instances.
- **Not run end to end:** the MPP-opened court `Fy8o…` was opened but not juried or resolved (seating jurors and voting is out of scope here), so `relayer.ts` correctly refuses it. The market was settled on the already-resolved court `24gQ…`.
- **Rounding:** pro-rata division can leave a few base units of dust in the contract.
- **Scanning:** `reconcile.ts` uses a fixed 50k-block `getLogs` window. Use an indexer at scale.
- Testnet only: Moderato tokens have no value.
