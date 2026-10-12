# Saring x Zcash: shielded juror bonds, slashing, and committed payouts

Saring is a conflict-blind jury for prediction-market disputes (Solana devnet program
`3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy`, ballots tallied in Arcium MPC, jurors who hold
a position in the disputed market are dropped inside MPC). This folder moves the jury's
money to Zcash. Jurors post a shielded **bond**. Jurors who vote get it back, and counted jurors
get a **reward**. A juror who is seated and never votes is **slashed**, and the forfeited bond goes
to the jurors who did vote. Every payment is shielded ZEC with an encrypted memo. A briber watching
Solana sees commitments and an aggregate verdict; one watching Zcash sees opaque shielded actions.

Everything below ran on Zcash testnet (NU7, Ironwood pool) and Solana devnet. No mocks.

## Design

Identifiers:

- `c = sha256(jurorId_le32 ‖ salt ‖ court)`: the juror's commitment, fresh per court so it can't be linked across courts.
- **seat key**: a fresh Solana keypair per juror per court, not linked to the juror's identity.
- **payout address**: the Orchard-family receiver of the juror's UA. A payment lands there, and a
  viewing key recovers exactly that string from an outgoing note.
- `u = sha256("saring-ua:" ‖ court ‖ ":" ‖ c ‖ ":" ‖ address)`: the payout-address commitment.
  A UA carries enough entropy that it can't be brute-forced, so it needs no salt.

| step | what happens | where | script |
|---|---|---|---|
| 1 | operator opens a court | Solana | `court.ts open` |
| 2 | operator publishes its **UFVK** (viewing key, cannot spend) | repo | `audit.ts publish-key` |
| 3 | juror bonds 0.01 TAZ from its own wallet. Memo `saring-bond:<court>:<c>:<seat key>`, encrypted to the operator. The juror wrote this memo, so only that seat key can act for `c`. | Zcash | `bond.ts` |
| 4 | operator verifies bonds with a view-only wallet and builds the allowlist | Zcash | `verify-bonds.ts` |
| 5 | **seat**: the `add_juror` tx also carries an SPL memo `saring-seat:<c>:<u>` that the seat key signs. The payout address is committed on chain by the juror, in the same tx that seats it. | Solana + MPC | `court.ts seat` |
| 6 | **cast**: the `cast` tx carries the memo `saring-cast:<c>`, signed by the same seat key. Who voted becomes public; how they voted stays encrypted. | Solana + MPC | `court.ts seat` |
| 7 | **payout**: the operator rebuilds seats and casts from the court account's own transactions and requires `#cast == yes+no+excluded`. Seated jurors who never cast are slashed. Voters get their bond back. Counted voters get `REWARD + slashed/#counted`. Every output must go to an address that opens `u`, otherwise nothing is paid. Everything goes out in one shielded tx with memos `saring-refund:<court>:<c>` and `saring-reward:<court>:<verdict>:<c>`. | Zcash | `payout.ts` |
| 8 | **verify**: anyone imports the published UFVK into a fresh view-only wallet and rechecks everything against Solana. Output is a JSON + markdown report that holds hashes and booleans, never addresses. | both | `audit.ts verify` |

The policy is one pure function (`zec.ts payoutPolicy`). It is self-tested and used by `payout.ts`;
`audit.ts verify` recomputes the expected amounts independently.

## Trust model, before → after

| concern | v1 (previous run) | v2 (this run) |
|---|---|---|
| where rewards go | operator's private juror→UA map; it could pay itself | the juror commits `u` on Solana with a key named in its own bond memo; the operator pays only an address that opens `u`; the verifier checks every output |
| who gets slashed | nobody; every bond refunded | derived from on-chain state: seats whose seat-key-signed `cast` never appeared on the court; requires `#cast == yes+no+excluded` |
| bond checks | the operator alone | anyone with the published UFVK: bond amount, seat key matches the seat-memo signer, bond mined before seating |
| payout checks | the operator's own ledger | anyone with the published UFVK: per-juror refund equals the bond, no-shows got nothing, reward count `== yes+no`, reward amount `== base + slashed/counted`, verdict in memo `==` chain, recipient opens `u` |
| what stays trusted | | which voters were **conflicted** (MPC reveals only the count; the verifier checks the count, the operator picks who). The operator still has to *send* the payout (it can stall, but it can't redirect without failing verification). Liveness of MPC callbacks. |

## What is public vs private

| | Solana devnet (anyone) | Zcash explorer (anyone) | UFVK holder (verifier) | juror |
|---|---|---|---|---|
| juror identity | `c` and seat key only (jurorId is encrypted to the MXE) | nothing | `c` | itself |
| votes | encrypted; who cast is public | nothing | nothing | own vote |
| payout address | `u` (a hash) | nothing | the Orchard receiver it paid | own |
| bond / payout amounts, memos | nothing | nothing (net value balance = fee) | yes | own |
| verdict | yes | nothing | yes | memo |

Publishing the UFVK opens the **operator's** ledger to the public verifier. Jurors stay pseudonymous
(`c` and seat key). The verify report itself never contains an address.

## Run it

You need: `zcash-devtool` built with the NU7 testnet patch at `~/tools/zcash-devtool/target/release/zcash-devtool`,
wallets `operator` and `juror1..4` in `~/.saring-zcash` (seeds age-encrypted), devnet SOL, and TAZ from
https://faucet.testnet.valargroup.dev.

```bash
alias zr='node_modules/.bin/ts-node --transpile-only -O "{\"module\":\"commonjs\",\"resolveJsonModule\":true,\"esModuleInterop\":true}"'
zr zcash/zec.ts                                   # self-check: memos, commitments, slashing policy
zr zcash/court.ts open "Saring x Zcash v2: slashing + committed payouts"
zr zcash/audit.ts publish-key                     # out/operator-viewing-key.json (UFVK only)
for j in juror1 juror2 juror3; do zr zcash/bond.ts $j <court>; done
zr zcash/verify-bonds.ts <court>
zr zcash/court.ts seat <court> --noshow juror3    # juror4 has no bond -> not seated
zr zcash/audit.ts verify <court>                  # anyone: bonds vs seats, before payout
zr zcash/payout.ts <court>
zr zcash/audit.ts verify <court>                  # anyone: payouts, slashing, commitments
zr zcash/audit.ts juror juror1; zr zcash/audit.ts auditor; zr zcash/audit.ts public <txid...>
```

## The run (Oct 12 2026, v2)

Court [`8bX2MwDZof48jfgfGGE1T7sMJwa6aojWvbazzpTfGNFm`](https://explorer.solana.com/address/8bX2MwDZof48jfgfGGE1T7sMJwa6aojWvbazzpTfGNFm?cluster=devnet)
(courtId 47423838). juror1..3 bonded and were seated. juror3 never voted. juror4 registered without bonding and was not seated.

| what | tx |
|---|---|
| bond juror1 (`540ef5c6…`), 0.01 TAZ | [d1148bfd…d233](https://testnet.zecblock.com/tx/d1148bfd1f69c7f4450959c5d4fcb09e0e3589b1a812bfe6dfe14375a880d233) |
| bond juror2 (`37302851…`), 0.01 TAZ | [7ef24c11…5de8](https://testnet.zecblock.com/tx/7ef24c11ae595f88ce1ba084dd8183057eca43bd03703fbece3cfa58f8475de8) |
| bond juror3 (`b8d4f908…`), 0.01 TAZ | [b3adcffe…21f8](https://testnet.zecblock.com/tx/b3adcffe4650c690b85f75ff31558aeeee9a9f8ddf76cf075baf8f5c35ab21f8) |
| seat + address commitment juror1 / juror2 / juror3 | [28cmeuTt…](https://explorer.solana.com/tx/28cmeuTtyT4wbpY4DvaVVEs1NJgMupYFnEP2LDuBLwqopBnGL9YQBpoH5JzBJmccbG4uEYrJ1UBh7cSveVcH3CSV?cluster=devnet) / [3tx81A39…](https://explorer.solana.com/tx/3tx81A396XEXoVx6guk6iDbohTbNmgCdWk5qB665gA6oKpkASN41CQSxxEMT4vGhWx11Axv9MwVzJAtQuoxQUYhQ?cluster=devnet) / [5Mk4Ytcx…](https://explorer.solana.com/tx/5Mk4YtcxW4yoQxBsH31EJeQ5eYB9Bqg24PT4EYEeneGEDiNLHZ6VWd7qBvXKJfJR3xKgcYNGziZPqjMyfDh4SqPv?cluster=devnet) |
| cast juror1 / juror2 (juror3: none) | [5FoeZ1FG…](https://explorer.solana.com/tx/5FoeZ1FGMGobrWrN5Sif58LT6scJqmEV9Vo14ZT5qBzxRHExFwQ92nPhxAtDnPfgGRU79KMVAiRBPLtXMWvfDq3p?cluster=devnet) / [5nRmJLgk…](https://explorer.solana.com/tx/5nRmJLgkGurYWCGKvFRUHtcswLu8VVzhjMfmwLvHwgFjPGVULSViHunFQVXRzj7Wyg6harDLCgnRiaztnBc4NAZs?cluster=devnet) |
| resolve: `yes 0, no 2, excluded 0 → NO` | [67Hbskrd…](https://explorer.solana.com/tx/67HbskRdN5a6p5UeEpxyMyQBtH9C66qADjiMcxE7JeMZkpHhW1o54YrBmsY3w6WGXK3F6eHdEeaYJJy26F5hgJsw?cluster=devnet) |
| payout, one tx: 2 refunds of 0.01, 2 rewards of 0.01 (0.005 base + 0.005 slashed share); juror3 gets nothing | [9a7d57ae…755b](https://testnet.zecblock.com/tx/9a7d57aee89f19209d32b48c7e5dc54168904b0f7d4520b7efa769156d0b755b) |

Public verifier report: [`out/verify-8bX2…GNFm.md`](out/verify-8bX2MwDZof48jfgfGGE1T7sMJwa6aojWvbazzpTfGNFm.md)
(and `.json`), produced from `out/operator-viewing-key.json` plus Solana alone. Pre-payout check: `out/verify-seated.log`.
Receipts (juror1's own wallet, `out/receipts-juror1.json`): `0.01 TAZ "saring-refund:8bX2…GNFm:540ef5c6…"` and
`0.01 TAZ "saring-reward:8bX2…GNFm:NO:540ef5c6…"`. `out/receipts-juror3.json` has nothing from this court.
Auditor ledger (`out/audit.json`): 3 bonds = 0.03, 2 refunds = 0.02, 2 rewards = 0.02, kept/slashed 0.01.
Explorer view (`out/public-view.json`): the payout is 5 Ironwood actions, 0 transparent inputs and outputs, and a net value
balance of 0.00025 (the fee). No address, amount or memo is visible.

Previous run (v1, no slashing, no commitments): court `HRA5oPAf…h7FM`, payout
[752e543c…aa85](https://testnet.zecblock.com/tx/752e543cd8ef2d4e35511c09afe89d89d164df4c3adb4f1dc909d64b5e03aa85).

## Limits

- Testnet only. The testnet ran NU7 (Ironwood pool, tx v6), so `zcash-devtool` is built with a local
  activation-height patch. ZecBlock is the explorer that follows that chain.
- **Conflicted jurors are picked by the operator.** MPC publishes only `excluded`. The verifier checks
  that count and that conflicted jurors were voters, but can't tell which voters they were. Fixing
  this needs MPC to output per-seat flags encrypted to each seat.
- A juror who casts a ballot with a wrong key "shows up" on chain while MPC silently ignores the
  ballot. Then `#cast != yes+no+excluded`, and payout refuses to slash anyone until that is resolved by hand.
- The demo holds every juror's keys (seat keys, wallets) on one machine. In production each juror holds
  its own key and co-signs the operator-paid seat and cast transactions.
- Publishing the operator UFVK exposes all of that operator account's history. A production version
  would use one account per court (one key per court).
- The operator still sends the payout. It can stall, but it can't redirect or skip a juror without the
  public verifier flagging it. Slashed-share dust (`slashed mod #counted` zatoshis) stays with the operator.
- A lightwalletd broadcast failure leaves a created tx in the wallet until it expires. `payout.ts` treats expired
  unmined txs as not paid, so a rerun after expiry is safe (this happened once in this run).
