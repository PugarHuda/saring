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

## Status

- **Foundry: 6/6 pass** (`out/forge-test.log`). One of them, `test_fork_realOOv3`, forks Arbitrum Sepolia and runs the full
  assert, dispute, Saring ruling, and settle sequence against the **real deployed OOv3**. It checks `getAssertionResult == false`
  and that the disputer receives 150 DBT (2 × 100 bond minus 50 burned to UMA's Store). The other tests use a test-only mock OO and cover:
  YES→1e18, NO→0, tie and incomplete→0, unbound or wrong court, wrong signer, tampered tally, high-s, double resolve, only-OO `requestPrice`, and only-owner bind.
- **`flow.ts` rehearsed on an anvil fork of Arbitrum Sepolia** against the real OOv3 and the real Solana devnet court `24gQ…YGb`.
  Every step succeeded, and `AssertionSettled{disputed:true, settlementResolution:false, bondRecipient: disputer}` paid the disputer +150 DBT.
- **Live testnet run: waiting on testnet ETH.** The deployer `0x1cE80de3835Ee1e32264DbADe102aB62c78AB394` has 0 ETH on Arbitrum
  Sepolia. Every faucet we tried needs a captcha, a login or a mainnet balance:
  https://www.alchemy.com/faucets/arbitrum-sepolia, https://faucets.chain.link/arbitrum-sepolia,
  https://faucet.quicknode.com/arbitrum/sepolia. Another option is to bridge Sepolia ETH at https://bridge.arbitrum.io. **0.005 ETH is enough.** Then run
  `npx tsx flow.ts`. Tx links are written to `out/flow.log` and `out/state.json`.

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

- Trust is the same as on Tempo: one relayer key signs, and one owner key binds court to assertion. Both actions are public on-chain, and the
  verdict is public on Solana, so anyone can catch a lie, but nothing prevents it. Removing that trust (for example k-of-n relayers, or ed25519 verification
  in Stylus) is future work.
- The court is bound after the assertion exists, because the assertionId is only known then. A disputer should check `CourtBound` before disputing.
- Being "UMA on Arbitrum" is not unique to Arbitrum. What we add on Arbitrum is unplugging the DVM for a conflict-screened jury on the chain where Kleros v2
  and Precog already live.
