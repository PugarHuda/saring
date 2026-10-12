# Saring x Zcash: shielded juror bonds and rewards

Saring is a conflict-blind jury for prediction-market disputes (Solana devnet program
`3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy`, ballots tallied in Arcium MPC, jurors who hold
a position in the disputed market are dropped inside MPC). This folder moves the jury's
money to Zcash: jurors post a **bond** and receive their **refund + reward** as shielded ZEC
with encrypted memos. A briber who watches Solana sees commitments and an aggregate verdict;
a briber who watches Zcash sees opaque shielded actions. Neither chain links a payment to a
juror, an amount, or a vote, so "pay me later if you vote YES" cannot be checked from outside.

Everything below ran on Zcash testnet (NU7 / Ironwood pool) and Solana devnet. No mocks.

## Flow

| step | script | chain |
|---|---|---|
| 1. operator opens a court | `court.ts open "<question>"` | Solana devnet |
| 2. juror registers: random salt, `commitment = sha256(jurorId_le32 ‖ salt)`; operator privately learns `{jurorId, salt, UA}` | `bond.ts <wallet> <court> [--register-only]` | off-chain |
| 3. juror posts a 0.01 TAZ bond to the operator's Unified Address, memo `saring-bond:<court>:<commitment>` (encrypted to the operator) | `bond.ts <wallet> <court>` | Zcash |
| 4. operator verifies bonds with a **view-only** wallet (UFVK, no spending key) and builds the allowlist | `verify-bonds.ts <court>` | Zcash (trial decryption) |
| 5. only bonded commitments are seated; ballots cast and tallied in MPC; conflicted ballots dropped | `court.ts seat <court> [conflicted]` | Solana devnet + Arcium |
| 6. operator reads the verdict from chain (`sdk/src/venue.ts readCourtVerdict`), cross-checks its seating record against the on-chain tally, then pays everything in **one** shielded tx: bond refund to every bonded juror (`saring-refund:<court>`), reward to every counted juror (`saring-reward:<court>:<verdict>`). Conflicted jurors get the refund, no reward. Refuses to pay a court twice. | `payout.ts <court>` | Zcash |
| 7. juror sees amount + decrypted memo in their own wallet; an auditor given the operator's UFVK rebuilds the whole ledger; anyone else sees only shielded actions | `audit.ts juror <w>` / `audit.ts auditor` / `audit.ts public <txid…>` | Zcash |

Slashing is not implemented: every bond is refunded. No bond means no seat (juror4 in the run).
A conflicted juror loses only the reward. Slashing a no-show would just mean leaving its bond
out of the payout, since the operator already holds it.

## What is public vs private

| | Solana devnet (anyone) | Zcash explorer (anyone) | operator (UFVK) | juror (own wallet) |
|---|---|---|---|---|
| juror identity | commitment / jurorId only | nothing | jurorId ↔ UA map | itself |
| individual votes | encrypted, never revealed | nothing | nothing (MPC) | own vote |
| who was conflicted | count only (`excluded`) | nothing | yes (it scripted the demo) | n/a |
| bond amounts | nothing | nothing (net pool balance = fee) | yes | own |
| reward amounts / recipients | nothing | nothing | yes | own |
| memos (court, verdict) | n/a | nothing | yes | own |
| verdict | yes | nothing | yes | yes (memo) |

`out/public-view.json` is the explorer API's decoding of each tx: zero transparent inputs or
outputs, N Ironwood actions, and a net shielded value balance equal to the fee.

## Run it

Needs: `zcash-devtool` (librustzcash light wallet) built with the NU7 testnet patch at
`~/tools/zcash-devtool/target/release/zcash-devtool`; wallets `operator`, `juror1..4` created
with `zcash-devtool wallet -w ~/.saring-zcash/<name> init --network test ...` (seed encrypted
to `~/.saring-zcash/<name>.age`); devnet SOL in `~/.config/solana/id.json`; TAZ from
https://faucet.testnet.valargroup.dev (0.125 TAZ/day).

```bash
alias zr='node_modules/.bin/ts-node --transpile-only -O "{\"module\":\"commonjs\",\"esModuleInterop\":true}"'
zr zcash/zec.ts                              # self-check (memo decoding, commitments)
zr zcash/court.ts open "Saring x Zcash: did the bonded jury convene?"
zr zcash/seed-demo-wallets.ts                # demo only: faucet-funded juror1 seeds the others
for j in juror1 juror2 juror3; do zr zcash/bond.ts $j <court>; done
zr zcash/bond.ts juror4 <court> --register-only   # registers, never bonds -> never seated
zr zcash/verify-bonds.ts <court>
zr zcash/court.ts seat <court> juror3        # juror3 plays the conflicted juror
zr zcash/payout.ts <court>
zr zcash/audit.ts juror juror1; zr zcash/audit.ts auditor; zr zcash/audit.ts public <txid...>
```

## The run (Oct 12 2026)

Court `HRA5oPAf4HPqKUu4sj3FpWDzuhvSJPDRD2xajSgLh7FM` (courtId 1582894422), Solana devnet.
Four jurors registered, three bonded, juror3 played the conflicted juror.

| what | tx |
|---|---|
| demo seeding (juror1 → juror2, juror3, operator) | [0d72ed66…547e](https://testnet.zecblock.com/tx/0d72ed66d770a2f9c043f2d6026d063195dfaafa96f6875eb065b3377c2b547e) |
| bond juror1, 0.01 TAZ | [5edea8ce…902e](https://testnet.zecblock.com/tx/5edea8cec97f12eb584a366e4705b951bce6c07eb48067d9fdd643c339f8902e) |
| bond juror2, 0.01 TAZ | [971faa3c…8c57](https://testnet.zecblock.com/tx/971faa3c8a8c18afd738549333f51c29c2474d27f9630d3dc804d70d19b78c57) |
| bond juror3, 0.01 TAZ | [e6c5ef69…207b](https://testnet.zecblock.com/tx/e6c5ef6943b2735a782eae77cb72e9fa17f44c737f6a7afc748d2426c68b207b) |
| juror4 | registered, no bond, not seated, received nothing |
| seat / cast / resolve | Solana devnet links in `out/court-HRA5….json` ([resolve](https://explorer.solana.com/tx/jDzuH11xH8TKDUX8KCunWrXUiAYxhwQDz78CFAjyZRrtDHw8XQPqmFWjHrpSiA5DwQKU1HgBjwU27kZ64ka8VX4?cluster=devnet)) |
| verdict on chain | `yes 0, no 2, excluded 1, outcome NO` (juror3's YES dropped in MPC) |
| payout: 3 refunds + 2 rewards, one tx, 0.04 TAZ | [752e543c…aa85](https://testnet.zecblock.com/tx/752e543cd8ef2d4e35511c09afe89d89d164df4c3adb4f1dc909d64b5e03aa85) |

Receiver side (`out/receipts-juror1.json`, juror1's own wallet):
`0.005 TAZ  "saring-reward:HRA5…h7FM:NO"` and `0.01 TAZ  "saring-refund:HRA5…h7FM"`.
juror3 (conflicted) got only the refund (`out/receipts-juror3.json`); juror4 got nothing.

Auditor with the operator's UFVK only (`out/audit.json`): 3 bonds = 0.03, 3 refunds = 0.03,
2 rewards = 0.01, verdict in memos `NO`, refunds match bonds.

Public view (`out/public-view.json`): the payout tx is 6 Ironwood actions, 0 transparent
inputs/outputs, net value balance 0.0003 (the fee). No address, amount or memo.

Logs: `out/bonds.log`, `out/verify-bonds.log`, `out/court-seat.log`, `out/payout.log`, `out/audit.log`.

## Limits

- Testnet only. The Zcash testnet ran the NU7 upgrade (new Ironwood shielded pool, tx v6);
  stock `zcash-devtool` did not know the activation height, so it is built with a local patch.
  Notes land in the **Ironwood** pool (Orchard-family actions). ZecBlock is the explorer that
  follows the NU7 chain; testnet.zcashexplorer.app was stuck on the old fork.
- The operator is trusted with the juror → UA map and the seating record (who was conflicted
  in the scripted dispute). It cannot see votes (MPC), but it knows who it paid. A production
  version would let each juror claim with a ZK proof of "my commitment was counted" instead.
- Light-wallet sync only scans compact blocks, which carry no memos; `zec.ts` runs
  `enhance` after `sync` to fetch full transactions so memos decrypt.
- Bridging is out of scope: the court lives on Solana, the money on Zcash, and the operator
  is the bridge (reads the Solana verdict, signs the Zcash payout).
- Demo wallets were seeded from one faucet drip (`out/seed-demo-wallets.json`); in practice
  each juror funds its own wallet.
