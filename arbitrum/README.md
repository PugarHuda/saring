# Saring on Arbitrum: a UMA OOv3 escalation manager

UMA's Optimistic Oracle V3 lets an assertion name an **escalation manager**. If that manager's
`getAssertionPolicy` returns `arbitrateViaEscalationManager = true`, a disputed assertion is not sent to
UMA's DVM. OOv3 asks the manager instead: `requestPrice` when the assertion is disputed, `getPrice` when
it is settled. `SaringEscalationManager` fills that slot with a Saring court, a conflict-blind jury on
Solana devnet whose MPC tally drops votes from jurors who hold a position. This is the same problem our
Conflict Report measures in UMA's own DVM votes.

| Piece | What it does |
|---|---|
| `contracts/src/SaringEscalationManager.sol` | Implements `EscalationManagerInterface` (policy: arbitrate via EM, keep the oracle result, anyone may dispute). `requestPrice` accepts calls only from OOv3 and parses the assertionId from OOv3's stamp (`assertionId:<hex>,ooAsserter:<hex>`). The owner (the Saring operator) binds a court to the assertion. `resolve()` checks the relayer's **EIP-712 Verdict**, which is the same type, `ecrecover` check and high-s rejection as `tempo/contracts/src/SaringMarket.sol`. `getPrice` is `view` because OOv3 reaches it by STATICCALL, and it reverts until a ruling exists. |
| `flow.ts` | Live end to end. It deploys the EM, mints 200 DBT (UMA `TestnetERC20`, `allocateTo`), calls `assertTruth(..., escalationManager = EM, bond 100 DBT)`, `bindCourt`, and `disputeAssertion`. The relayer then reads the court on Solana (`sdk/src/venue.ts readCourtVerdict`, which refuses unresolved courts and accounts the Saring program doesn't own) and signs the verdict; the script calls `resolve()`, then `settleAssertion`. |
| `lib.ts` | Keys, clients, and the Solana read plus EIP-712 signing. `base/lib.ts` is the same file. |

Addresses (Arbitrum Sepolia, chain 421614), from UMA's `packages/core/networks/421614.json` and checked on-chain:
OOv3 `0x1037A21a30aEfF90c269b01c3933eB9a5285d9b8` (13.6 KB of code). The bond currency is `TestnetERC20` "DBT" at
`0x689FF0D2c17ECbB01477420aB18482A8DAd45186`, which is OOv3's `defaultCurrency`, so it is whitelisted; anyone can mint it with `allocateTo`.
`getMinimumBond` is 100e18, `burnedBondPercentage` is 50%, and the identifier is `ASSERT_TRUTH`.

**Verdict mapping:** a YES majority returns `getPrice = 1e18`, so the assertion is true and the asserter takes the bonds. NO, a tie, or an
incomplete conflict check returns 0, so the assertion is false and the disputer takes the bonds. An OOv3 assertion can only be true or false, so
"can't decide" counts as "not proven".

## Wormhole path (no Saring key in the verdict)

`SaringEscalationManager` also has `resolveWithVaa(assertionId, vaa)`. Anyone may submit a Wormhole VAA that the
`saring_wormhole` program posted on Solana devnet after reading the resolved court on-chain. The contract checks the guardian
signatures through the Arbitrum Sepolia core bridge `0x6b9C8671cdDC8dEab9c719bB87cBd3e782bA6a35`, the emitter (Solana, PDA
`0x54c231ce…6238`), and the bound court. The constructor is now `(oo, relayer, wormhole, emitter)`. The EIP-712 `resolve()` is unchanged.
**Live:** [`0x6ae4c89bb75291062b204e6ba9d43952786ec56c`](https://sepolia.arbiscan.io/address/0x6ae4c89bb75291062b204e6ba9d43952786ec56c) (Sourcify exact match). A new assertion was disputed and
[resolved by VAA](https://sepolia.arbiscan.io/tx/0xafb717d9c06f195b4a952030c4f084ce2d316e54054750b910cf456517d95587), then
[settled](https://sepolia.arbiscan.io/tx/0xaaae5ed3e9edf4ab4995f034ceb79687a4c83dd79a3217f81ac17cd320c3c3df) false.
The same contract also runs on Ethereum Sepolia against UMA's OOv3 there. See [`../wormhole/README.md`](../wormhole/README.md) for the trust model, all tx links and tests.
Foundry is now 10/10, including fork tests with the real VAA for the positive case, a tampered payload, a wrong emitter and a wrong court.
The older EIP-712 deployment `0xd96e40e3…` below is kept as history.

## Kleros v2 adapter: `SaringArbitratorV2` (IArbitratorV2)

Why Arbitrum: Kleros v2 and Precog live here. `SaringArbitratorV2` implements Kleros v2's own arbitrator standard,
`IArbitratorV2` (vendored from kleros/kleros-v2 `contracts/src/arbitration/interfaces/`, with the same events and signatures:
`createDispute`, `arbitrationCost`, `currentRuling`, `DisputeCreation`, `Ruling`, `RulingExecuted`). Any `IArbitrableV2` written
for KlerosCore can point at it and get its ruling from a Saring court. The verdict arrives as a Wormhole VAA, checked by the
same `SaringWormhole.verdictFromVaa` as `resolveWithVaa` above (guardian signatures via the core bridge, the Solana emitter PDA, and the 45-byte payload).

- Binary disputes only (`_numberOfChoices == 2`). Ruling 1 = YES majority, 2 = NO majority, 0 = refused (a tie, or an incomplete conflict check; a tie also sets `tied`). There are no appeals, so `overridden` is always false.
- The fee is a flat ETH `arbitrationCost`, forwarded to the operator. The ERC20 overloads revert with `TokenNotAccepted`, which is what KlerosCore does for a token it has not accepted.
- The operator calls `bindCourt(disputeID, court)` once the Saring court is open on Solana. Anyone may then call `ruleWithVaa(disputeID, vaa)`, which pushes the ruling into `arbitrable.rule()`.
- `SaringEscrow` is a minimal `IArbitrableV2`. A payer locks ETH for a payee, and either party can dispute by paying `arbitrationCost`. Ruling 1 pays the payee, 2 refunds the payer, and 0 splits the amount.

**Live on Arbitrum Sepolia** (both Sourcify exact match): `SaringArbitratorV2` [`0xc2b4805d…5ba5`](https://sepolia.arbiscan.io/address/0xc2b4805da6899d788b179f12eb19136bd73f5ba5),
`SaringEscrow` [`0x31ee6aaa…6766`](https://sepolia.arbiscan.io/address/0x31ee6aaa1d24b0b18bbb4cf22c879a22fcea6766).
`flow-kleros.ts` used court `24gQ…YGb` (resolved NO) and its recorded VAA:
[deploy arbitrator](https://sepolia.arbiscan.io/tx/0xb659f59d7fdbf24deae251a3fbd734bdaeb38d3ad44800506f5ca5be264110bd),
[deploy escrow](https://sepolia.arbiscan.io/tx/0x309659d408062f02893b15c433a24d9fcd0fcce9b1568ab856c084d3c3ce4712),
[open 0.0001 ETH deal](https://sepolia.arbiscan.io/tx/0x32bccc1fbbb2043a4c8ea319f8a439c958a7182ab227263d22220c9a4cda9c83),
[dispute → createDispute](https://sepolia.arbiscan.io/tx/0xa8c952b2654df3ea2681362af7ad5092e103c7bae776861f4b3a27e3227e9df3),
[bindCourt](https://sepolia.arbiscan.io/tx/0x45c87523614febe1046b5a683df279647d64d54fd72125f18232bf5aceeddc37),
[ruleWithVaa → rule(0, 2) → payer refunded](https://sepolia.arbiscan.io/tx/0x4a9da88971511f607a2d45a18866e6dd7dd5ceb2cbab5f78d65226352e18eeea).
`currentRuling(0)` returned `(2, false, false)` and the escrow ended empty. The whole run cost 0.000042 ETH in gas (`out/flow-kleros.log`).
Foundry: 7/7 pass (`out/forge-test-kleros.log`). The fork tests use the real VAA and the real core bridge. They cover the full flow, a tampered VAA,
a wrong emitter (a genuine VAA from another emitter, and our VAA against an arbitrator expecting a different emitter) and a wrong court. Unit tests with a mock bridge cover YES, tie, incomplete and the reject paths.

```bash
(cd contracts && forge test --match-contract SaringArbitratorV2Test)
RPC_URL_EVM=http://127.0.0.1:8545 npx tsx flow-kleros.ts   # anvil-fork rehearsal (see Commands)
npx tsx flow-kleros.ts [court]                             # live; needs ../wormhole/out/vaa-<court>.json
```

## Status

- **Foundry: 6/6 pass** (`out/forge-test.log`). One of them, `test_fork_realOOv3`, forks Arbitrum Sepolia and runs the full
  assert, dispute, Saring ruling, and settle sequence against the **real deployed OOv3**. It checks `getAssertionResult == false`
  and that the disputer receives 150 DBT (2 × 100 bond minus 50 burned to UMA's Store). The other tests use a test-only mock OO and cover:
  YES→1e18, NO→0, tie and incomplete→0, unbound or wrong court, wrong signer, tampered tally, high-s, double resolve, only-OO `requestPrice`, and only-owner bind.
- **`flow.ts` rehearsed on an anvil fork of Arbitrum Sepolia** against the real OOv3 and the real Solana devnet court `24gQ…YGb`.
  Every step succeeded, and `AssertionSettled{disputed:true, settlementResolution:false, bondRecipient: disputer}` paid the disputer +150 DBT.
- **Live on Arbitrum Sepolia.** `SaringEscalationManager` is at [`0xd96e40e336363f856ce264176da6c24bf23803b4`](https://sepolia.arbiscan.io/address/0xd96e40e336363f856ce264176da6c24bf23803b4)
  (source verified on Sourcify, exact match: https://repo.sourcify.dev/421614/0xd96e40e336363f856ce264176da6c24bf23803b4). The run used the real OOv3 and the real devnet court `24gQ…YGb`, which resolved NO
  (yes 0, no 1, 1 conflicted juror excluded). Assertion `0x57ca4c55…d75e`:
  [deploy](https://sepolia.arbiscan.io/tx/0x683afb1efd3914ae4b05666598be9524d64057c86fc9adc523bec305c255f5c6),
  [assertTruth](https://sepolia.arbiscan.io/tx/0x5cf652873226c9d06dd7a6539e3f2d6ca6cb2465737b08daa011db08b6d1a800),
  [bindCourt](https://sepolia.arbiscan.io/tx/0x161d976f662f7f3c7cc5cdc1ad2e1bfac2803861846f9c35fc27276f8f187a6a),
  [disputeAssertion](https://sepolia.arbiscan.io/tx/0xc1198c693e0f6eaeb42feb997d60ab77db0d05ebf3c17f400eb43323d35adc6e),
  [resolve (Saring verdict)](https://sepolia.arbiscan.io/tx/0x47d123956b20235728e45363a7f72d5b9c1c36d79ceb67cb6826775f24da3324),
  [settleAssertion](https://sepolia.arbiscan.io/tx/0x60761025882c3d693c27867d0e5e8d14876642233477104ab39fec89c47cdf72).
  OOv3 emitted `AssertionSettled{disputed:true, settlementResolution:false, bondRecipient: disputer}`, `getAssertionResult` returned false, and the disputer received +150 DBT.
  The full log is in `out/flow.log` and `out/state.json`.

## Commands

```bash
cd ~/blindcourt/arbitrum
npm install                                         # viem, tsx (Solana deps come from the repo root)
(cd contracts && forge install foundry-rs/forge-std --no-git && forge build && forge test)
npx tsx flow.ts [court]                             # live; default court 24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb (resolved NO)
# dry run on a fork (no ETH needed):
anvil --fork-url https://sepolia-rollup.arbitrum.io/rpc &
cast rpc anvil_setBalance 0x1cE80de3835Ee1e32264DbADe102aB62c78AB394 0x16345785D8A0000
RPC_URL_EVM=http://127.0.0.1:8545 npx tsx flow.ts   # logs to out/*.fork.* (gitignored)
```

Keys are in `~/.saring-evm/keys.json` (mode 0600, outside the repo, never printed). The roles are deployer, disputer and relayer. Only the deployer needs
gas. It pays the dispute bond on the disputer's behalf, and OOv3 credits the `disputer` argument.

## Limits

- *EIP-712 path only.* The Wormhole path above removes the relayer key; its own limits are listed in `../wormhole/README.md`.
- Trust is the same as on Tempo: one relayer key signs, and one owner key binds court to assertion. Both actions are public on-chain, and the
  verdict is public on Solana, so anyone can catch a lie, but nothing prevents it. Removing that trust (for example k-of-n relayers, or ed25519 verification
  in Stylus) is future work.
- The court is bound after the assertion exists, because the assertionId is only known then. A disputer should check `CourtBound` before disputing.
- Being "UMA on Arbitrum" is not unique to Arbitrum. What we add on Arbitrum is unplugging the DVM for a conflict-screened jury on the chain where Kleros v2
  and Precog already live.
