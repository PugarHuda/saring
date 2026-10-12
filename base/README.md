# Saring on Base: a Reality.eth v3 arbitrator, and real Limitless holders

Two pieces, both aimed at prediction markets on Base:

1. **`SaringArbitrator`** is a Reality.eth v3 arbitrator. Kleros fills this slot for Seer and Precog. With Saring in it, a disputed question
   goes to a Saring court: a conflict-blind jury on Solana devnet whose MPC tally drops votes from jurors who hold a position.
2. **`limitless-holders.ts`** reads the **real holders** of a Limitless Exchange market on Base mainnet. Limitless is the largest
   prediction market on Base, and its `manual` markets are resolved by the Limitless team. These holders are the addresses Saring would
   screen out of the jury.

| Piece | What it does |
|---|---|
| `contracts/src/SaringArbitrator.sol` | `requestArbitration(qid, max_previous)` takes the fee (`getDisputeFee`) and calls `realitio.notifyOfArbitrationRequest`. The owner (the Saring operator) binds a court to the question. `rule(...)` checks the relayer's **EIP-712 Verdict** (same type, `ecrecover` check and high-s rejection as `tempo/contracts/src/SaringMarket.sol`) and calls `realitio.assignWinnerAndSubmitAnswerByArbitrator`, so Reality.eth credits the last answerer if they were right and the requester if not. YES maps to `0x…01`, NO to `0x…00`, and a tie or incomplete check to **INVALID `0xff…ff`**, which is Reality.eth's own "invalid" answer. |
| `flow.ts` | Live end to end. It deploys the arbitrator, then calls `askQuestion` (template 0 bool, arbitrator = Saring). The deployer calls `submitAnswer` YES with a bond. The disputer calls `requestArbitration` and pays the fee. Then the script binds the court, the relayer reads the Solana court and signs, and it calls `rule`. Reality.eth finalizes, and the disputer calls `claimWinnings` and `withdraw`. |
| `limitless-holders.ts` | Calls `CTFExchange.getCtf()` to get the Gnosis CTF, collects the market's ERC-1155 `TransferSingle`/`TransferBatch` logs, and confirms each address with `CTF.balanceOfBatch` at the latest block. |
| `lib.ts` | A copy of `arbitrum/lib.ts`: keys, clients, Solana read, EIP-712 signing. |

Reality.eth v3 on Base Sepolia (chain 84532) is the official deployment
`0x86b653Dc9aa6d7311109276925927087573f91CB`, taken from `reality-eth-monorepo/packages/contracts/chains/deployments/84532/ETH/RealityETH-3.0.json`.
Its code is on-chain (16.9 KB) and template 0 exists, so we did not deploy our own copy.

## Real Limitless holders (Base mainnet, block 52512197): done

Market: "Bills vs. Rams" (`bills-vs-rams-1791332408841`). It has `automationType = manual`, which means it is admin-resolved, and on 2026-10-12 it was the manual market with the most volume.
The condition is `0x14b2…ab32`. The exchange is `0x05c748E2…3fa5`, and its `getCtf()` returns `0xC9c98965297Bc527861c898329Ee280632B76e18`. We found 42 transfers of the market's
positions across the 7 fills, and 6 addresses touched them. These 5 addresses hold shares now:

| Holder | YES | NO |
|---|---|---|
| [0xa606d5a8…1fBD](https://basescan.org/address/0xa606d5a85A6dA3743F5E27aE1844847C39ED1fBD) | 273.00 | 0 |
| [0xD9dAb863…E966](https://basescan.org/address/0xD9dAb863691eCa0726A917170da0F834011bE966) | 0 | 267.19 |
| [0xF94ef760…226E](https://basescan.org/address/0xF94ef760884b0605E433853Aed17DA574160226E) | 0.15 | 5.81 |
| [0x3Eda6446…fc28](https://basescan.org/address/0x3Eda6446d3f458E8ce2b9C433C59D719E331fc28) | 0 | 4.94 |
| [0xc6382C0D…0Fd4](https://basescan.org/address/0xc6382C0D832f165c0225d178aF0a1717adC00Fd4) | 4.79 | 0 |

The full output is in `out/limitless-holders.log`, and the same data is in `out/state.json`.

**Where the logs come from:** the free public Base RPCs would not serve a full `eth_getLogs` scan of the CTF since the market opened (about 240k blocks and about 150k
logs from every Limitless market). `mainnet.base.org` returns "request limit reached", publicnode asks for an archive token, and drpc caps the range.
So by default the script takes every fill tx hash that `api.limitless.exchange` lists for the market and reads the `TransferSingle`/`TransferBatch`
logs from those receipts on-chain (`base.drpc.org`). Holdings are then confirmed with `balanceOfBatch`. If you set `BASE_RPC=<archive rpc>`, the script does the
full `getLogs` scan instead, which also catches transfers that happen outside Limitless.

## Wormhole path (no Saring key in the verdict)

`SaringArbitrator` also has `ruleWithVaa(questionId, vaa, lastHistoryHash, lastAnswer, lastAnswerer)`. Anyone may submit a Wormhole VAA
that the `saring_wormhole` program posted on Solana devnet after reading the resolved court on-chain. The contract checks the guardian
signatures through the Base Sepolia core bridge `0x79A1027a6A159502049F10906D333EC57E95F083`, the emitter (Solana, PDA `0x54c231ce…6238`),
and the bound court. The constructor is now `(realitio, relayer, fee, wormhole, emitter)`. The EIP-712 `rule()` is unchanged.
**Live:** [`0x384822075dc735ea7de0b8417c9b4403bb9d682a`](https://sepolia.basescan.org/address/0x384822075dc735ea7de0b8417c9b4403bb9d682a) (Sourcify exact match). A new question was answered YES, sent to arbitration,
[ruled by VAA](https://sepolia.basescan.org/tx/0xf2a1ef9c6ab80fbd75a9cf298bee115d3eaf5d4a9608ccdcde86e5c8b37d01c9) (submitted by the disputer) to `resultFor = 0x0`, and the bond was
[claimed](https://sepolia.basescan.org/tx/0x40615bedc3b8d84e7ce31b6d59e40a2e2b4298b5a207cf6f290f8f18efbe1750).
See [`../wormhole/README.md`](../wormhole/README.md) for the trust model, all tx links and tests. Foundry is now 9/9, including fork tests with the
real VAA for the positive case, a tampered payload, a wrong emitter and a wrong court. The older EIP-712 deployment `0xd96e40e3…` below is kept as history.

## Status of the arbitrator

- **Foundry: 5/5 pass** (`out/forge-test.log`). One of them, `test_fork_realRealityETH`, forks Base Sepolia and runs the whole sequence against the
  **real Reality.eth v3**: ask, answer YES with a bond, request arbitration, Saring NO ruling. It asserts `isFinalized`, `resultFor == 0`, and that `claimWinnings`
  credits the wrong answerer's bond to the requester. The other tests use a test-only mock Reality and cover: answer mapping (YES/NO/tie/incomplete),
  fee too low, double request, unbound or wrong court, wrong signer, tampered tally, high-s, double ruling, only-owner, and fee withdrawal.
- **`flow.ts` rehearsed on an anvil fork of Base Sepolia** against the real Reality.eth and the real Solana devnet court `24gQ…YGb`
  (resolved NO). Every step succeeded, `resultFor = 0x0`, and the disputer claimed and withdrew the bond.
- **Live on Base Sepolia.** `SaringArbitrator` is at [`0xd96e40e336363f856ce264176da6c24bf23803b4`](https://sepolia.basescan.org/address/0xd96e40e336363f856ce264176da6c24bf23803b4)
  (source verified on Sourcify, exact match: https://repo.sourcify.dev/84532/0xd96e40e336363f856ce264176da6c24bf23803b4). The run used the real Reality.eth v3 and the real devnet court `24gQ…YGb`, which resolved NO.
  Question `0xf68230ab…00ae`:
  [deploy](https://sepolia.basescan.org/tx/0xe2c9364eae9ce772032346c183b607815668bba72bf02cc529e886aab540a431),
  [askQuestion](https://sepolia.basescan.org/tx/0x52b7261a9cdffe908c4e8cf242e4170b2a9486c498975bc1db04477c56747991),
  [submitAnswer YES](https://sepolia.basescan.org/tx/0xa6d3d9a896cb7f404776d81f3bd6787e81f340f819a8576a8ff90f41981e6862),
  [requestArbitration](https://sepolia.basescan.org/tx/0x4962b80d211e77ec41176817f2b6cd4abf1e5a680ad5fec4759a07deb11f3b21),
  [bindCourt](https://sepolia.basescan.org/tx/0x097ba9088a82b43538901f625e5d0b8a2182d9f3cdcf98b9ad97379d91a9bf10),
  [rule (Saring verdict)](https://sepolia.basescan.org/tx/0x5878e40b55faecdaf3b3c5b8b5f491f03227247d3556a2b1c7350ed1e57fd47e),
  [claimWinnings](https://sepolia.basescan.org/tx/0x3b6f72890b64b7bc5612ffc9beb018e5f38da3819bf9df7817949c74fc27d030),
  [withdraw](https://sepolia.basescan.org/tx/0x808b6613e0c1e2565856edf9812fe33ff52d9f79625efd565a709a7f6fec45f8).
  After the ruling, `isFinalized` is true and `resultFor` is `0x0` (NO). The claim credited the YES answerer's 0.00002 ETH bond to the disputer, and `withdraw` paid it out.
  Note: `sepolia.base.org` is load-balanced, and the first run's `resultFor` read right after `rule` reached a node that had not seen the block yet.
  `flow.ts` now waits for `isFinalized`, and `RESUME=1 npx tsx flow.ts` finished the payout without redeploying. The "balance 0 ETH" line in `out/flow.log` comes from the same lag;
  the withdraw tx shows the 0.00002 ETH transfer.

## Commands

```bash
cd ~/blindcourt/base
npm install
(cd contracts && forge install foundry-rs/forge-std --no-git && forge build && forge test)
npx tsx limitless-holders.ts [market-slug]          # Base mainnet, read-only
npx tsx flow.ts [court]                             # live Base Sepolia; default court 24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb
# dry run on a fork (no ETH needed):
anvil --fork-url https://sepolia.base.org --port 8546 &
cast rpc anvil_setBalance 0x1cE80de3835Ee1e32264DbADe102aB62c78AB394 0x16345785D8A0000 --rpc-url http://127.0.0.1:8546
RPC_URL_EVM=http://127.0.0.1:8546 npx tsx flow.ts
```

Keys are in `~/.saring-evm/keys.json` (mode 0600, outside the repo, never printed). The roles are deployer, disputer and relayer. The deployer sends 0.001 ETH
to the disputer for gas and the arbitration fee.

## Limits

- *EIP-712 path only.* The Wormhole path above removes the relayer key; its own limits are listed in `../wormhole/README.md`.
- Trust is the same as on Tempo: one relayer key signs the verdict, and one owner key binds the court to the question. Both actions are public, and the court's
  verdict on Solana is public, so a lie can be detected but not prevented.
- `rule` must be given the question's latest history entry, as Reality.eth requires. `flow.ts` knows it because there is exactly one answer.
  With several answers, a relayer reads it from `LogNewAnswer`.
- The Limitless holders are read and printed here, but not yet mirrored into a Saring court (`record_positions_v3`). Panta's pipeline does that step on Solana.
