# Saring verdicts over Wormhole

Before this folder existed, Saring's EVM adapters (UMA OOv3 escalation manager, Reality.eth arbitrator, Tempo market)
settled on an **EIP-712 Verdict signed by one relayer key that we hold**. That key was a centralized oracle. Anyone could catch
a lie, because the court is public on Solana, but nothing on-chain stopped one.

Now each adapter also accepts a **Wormhole VAA**. The Wormhole guardians sign a message that the `saring_wormhole` Solana
program posted after it read a resolved Saring court on-chain. The EVM contract checks the guardian signatures through the
chain's own Wormhole core bridge and checks the emitter. No Saring-held key is involved in the verdict.

## Trust model

| | Before (EIP-712 relayer) | After (Wormhole VAA) |
|---|---|---|
| Who says what the court decided | One Saring relayer key | The `saring_wormhole` program, reading the CourtAccount itself: owner must be the Saring program `3CeQ1D…fyHy`, the discriminator must match, `resolved == 1` and `pending == 0` |
| What carries it to the EVM chain | The relayer's signature | Wormhole guardian signatures over the posted message. On testnet that is guardian set 0 (one guardian, `0x13947Bd4…C638`). On mainnet it is 13 of 19. |
| What the EVM contract checks | `ecrecover == relayer`, low-s | `parseAndVerifyVM` on the real core bridge, `emitterChainId == 1` (Solana), `emitterAddress == ` the program's PDA `["emitter"]`, a 45-byte payload with type `0x01`, and the bound court `==` the payload court |
| Who can submit | Anyone (the signature is what counts) | Anyone. In our runs the disputer, a bettor, or a random account delivered it. |
| Can Saring forge a verdict? | Yes, by signing anything | Not through the message path. The emitter PDA can only sign inside `saring_wormhole`, which posts only what it read. See the limits below for upgrade authority. |

The EIP-712 path is still there (`resolve` / `rule` / `settle`) so existing integrations keep working. A deployer who wants the VAA path
only can pass `relayer = address(0)`. The fork tests do exactly that.

## Why a core message (path B) and not Queries (path A)

Wormhole Queries (`sol_account`) would have let the guardians sign the raw court account with no new Solana program. But Queries
is a **closed beta**: the testnet Query Proxy `testnet.query.wormhole.com/v1/query` needs an `X-API-Key` issued through an access
form (wormhole.com/docs/products/queries/get-started). Unauthenticated calls get `503 unconditional drop overload`. So we used the
core bridge, which is open on every testnet we need.

## Pieces

| File | What it does |
|---|---|
| `program/src/lib.rs` | `saring_wormhole`, a plain `solana-program` crate (no Anchor), deployed on devnet at `DdNYVoQVXZdWjAaYq9pnrH2fec17F1QnSXDyfnTQWdPq`. It reads the court and CPIs the core bridge (`3u8hJUVT…sjQ5`) `post_message` with finality = Finalized, signed by its PDA `["emitter"]` = `6hrzcMmM16aUh5D1YkaVvPoQ2q532Acb2PC8yU935ABq` (`0x54c231ce…6238`). Payload (45 bytes): `0x01 \| court[32] \| yes \| no \| excluded \| incomplete \| slot u64 BE`. |
| `contracts/SaringWormhole.sol` | The shared base contract: the `Verdict` struct plus `verdictFromVaa(vaa)`. `arbitrum/`, `base/` and `tempo/` import it through the remapping `saring-wormhole/` in their `foundry.toml`. |
| `contracts/SaringWormholeFixtures.sol` | The real recorded VAAs and testnet core addresses used by the fork tests. |
| `attest.ts` | Posts a court's verdict on devnet, then polls Wormholescan until the signed VAA appears and writes `out/vaa-<court>.json`. `--simulate <account>` dry-runs the program against any account; nothing lands. |
| `flow-uma.ts` | UMA OOv3 end to end on `arbitrum` or `sepolia`: deploy EM, assertTruth, bindCourt, dispute, `resolveWithVaa`, settle. |
| `flow-reality.ts` | Reality.eth v3 on Base Sepolia: deploy arbitrator, ask, answer YES, requestArbitration, bindCourt, `ruleWithVaa`, claimWinnings, withdraw. |
| `flow-tempo.ts` | Tempo Moderato: deploy SaringMarket, bet YES/NO, `settleWithVaa` (sent by a bettor), claim. |

## Wormhole core bridges used (all checked on-chain: `chainId()`, guardian set 0 = `[0x13947Bd4…C638]`, `messageFee() == 0`)

| Chain | Wormhole chain id | Core |
|---|---|---|
| Solana devnet | 1 | `3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5` |
| Ethereum Sepolia | 10002 | `0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78` |
| Arbitrum Sepolia | 10003 | `0x6b9C8671cdDC8dEab9c719bB87cBd3e782bA6a35` |
| Base Sepolia | 10004 | `0x79A1027a6A159502049F10906D333EC57E95F083` |
| Tempo Moderato (42431) | 68 | `0xa29E8c21924834E6249bCE1FD733f24eC492018c` (listed under testnet core contracts on wormhole.com/docs/products/reference/contract-addresses) |

## Live runs (one new dispute per chain, settled by the VAA)

**Attestation (Solana devnet).** Court `24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb` resolved NO (yes 0, no 1, excluded 1).
[post tx](https://explorer.solana.com/tx/5WtYWwEuDrMmkyaQt7hfX8bdcGrqom19AbLUXnGMX43kHjcoVRTqAzXeXj3vheF2vFg9SPgvySj9H7aQJRiREy7Z?cluster=devnet),
VAA `1/54c231ce…6238/0` on [Wormholescan](https://wormholescan.io/#/tx/5WtYWwEuDrMmkyaQt7hfX8bdcGrqom19AbLUXnGMX43kHjcoVRTqAzXeXj3vheF2vFg9SPgvySj9H7aQJRiREy7Z?network=Testnet)
([API](https://api.testnet.wormholescan.io/api/v1/vaas/1/54c231cefc5bd0966f82594e4333d6211f9a1ab4740be61271fdcb2d5ceb6238/0)). Log: `out/attest.log`.
The same VAA settles every chain below. That is the point: one guardian-signed fact, verified independently by each chain's core bridge.

**Base Sepolia: Reality.eth v3.** `SaringArbitrator` [`0x384822075dc735ea7de0b8417c9b4403bb9d682a`](https://sepolia.basescan.org/address/0x384822075dc735ea7de0b8417c9b4403bb9d682a) (Sourcify exact match). Question `0x7cb90bbf…ec83`:
[deploy](https://sepolia.basescan.org/tx/0xb9c48ef91327d7563f7a579390f076929dc8b5d8bb5f2a23123d40b058823cb0),
[askQuestion](https://sepolia.basescan.org/tx/0x6dc41fd0c8e56b3645459ca418e4cfcc8ad1928abdfb6ff26447239f2d06ab8a),
[submitAnswer YES](https://sepolia.basescan.org/tx/0x2e879055c02a28887cbd92dd8bd330937f4ad5d12a054475c1691f4fbd23a6a0),
[requestArbitration](https://sepolia.basescan.org/tx/0x113e89ec74b03476f5bb7126aa78e96937e0977b1b11f86ecdee8b94a98f8499),
[bindCourt](https://sepolia.basescan.org/tx/0xbb4977e4dfd8df5c38ac5ceddfd6937963a3cd271f4d5598f2f60c466c234608),
[**ruleWithVaa** (sent by the disputer)](https://sepolia.basescan.org/tx/0xf2a1ef9c6ab80fbd75a9cf298bee115d3eaf5d4a9608ccdcde86e5c8b37d01c9),
[claimWinnings](https://sepolia.basescan.org/tx/0x40615bedc3b8d84e7ce31b6d59e40a2e2b4298b5a207cf6f290f8f18efbe1750),
[withdraw](https://sepolia.basescan.org/tx/0x76d4889acd31ac0ad16de97a8cdcb1a30675fcc693d1d80da0a8e89f7eed3ff7).
Result: `isFinalized`, `resultFor = 0x0` (NO), and the YES bond went to the disputer. The first run stopped before `ruleWithVaa` because the load-balanced RPC had not
seen `bindCourt` yet. It resumed with `ARB=… QID=…` and nothing was redeployed. Log: `out/flow-base.log`.

**Arbitrum Sepolia: UMA OOv3.** `SaringEscalationManager` [`0x6ae4c89bb75291062b204e6ba9d43952786ec56c`](https://sepolia.arbiscan.io/address/0x6ae4c89bb75291062b204e6ba9d43952786ec56c) (Sourcify exact match). Assertion `0xed57d330…e33a`:
[deploy](https://sepolia.arbiscan.io/tx/0x88bfc721f2a9af7fe906845f4376eb3bd939918090c21cb144f0db5063b86268),
[assertTruth](https://sepolia.arbiscan.io/tx/0x879173f7a313e9b120a0bbeb95fdc61cdb862be1beea8b434eefa6e0ca2327bc),
[bindCourt](https://sepolia.arbiscan.io/tx/0x95cc658f6ec33ea6b91ce7f6b15415e55b2ba058df888cc77fddd08f737c3013),
[disputeAssertion](https://sepolia.arbiscan.io/tx/0x30e9d541c2c788db0e7a5c446c80ac2cece1242170e974fbb6124fe8d85fb837),
[**resolveWithVaa**](https://sepolia.arbiscan.io/tx/0xafb717d9c06f195b4a952030c4f084ce2d316e54054750b910cf456517d95587),
[settleAssertion](https://sepolia.arbiscan.io/tx/0xaaae5ed3e9edf4ab4995f034ceb79687a4c83dd79a3217f81ac17cd320c3c3df).
Result: `AssertionSettled{disputed: true, settlementResolution: false}`. Log: `out/flow-arbitrum.log`.

**Ethereum Sepolia: UMA OOv3** (`0xFd9e2642a170aDD10F53Ee14a93FcF2F31924944`, from UMA `packages/core/networks/11155111.json`). The bond is 0.002 WETH, OOv3's minimum for whitelisted WETH `0x7b79…E7f9`.
`SaringEscalationManager` [`0x2618c1f527a513a1638b8071b4b796e7769dcda0`](https://sepolia.etherscan.io/address/0x2618c1f527a513a1638b8071b4b796e7769dcda0) (Sourcify exact match). Assertion `0x6fa0e661…3801`:
[deploy](https://sepolia.etherscan.io/tx/0x9ba1b7ffc83e5462f6a6362ddadabed954a941b7d467f75cc376fb1bd77f8b66),
[wrap](https://sepolia.etherscan.io/tx/0x16f5a3879f065e2add7d08c81dd8d00d53c09aab4e5be02bd7b30e8f589571f7),
[approve](https://sepolia.etherscan.io/tx/0x474fb250b2fb9b750d93563f901b31f8513fc618e91983e72a25570340d06ccb),
[assertTruth](https://sepolia.etherscan.io/tx/0x76d6f9bc150a13c2d9afec252ef2945303bba51243221fae0b4ce9dbdd321bd2),
[bindCourt](https://sepolia.etherscan.io/tx/0x53533e530441f3301dc6f4162dc7e6337109e023074fa9b5d31d643e5111782a),
[disputeAssertion](https://sepolia.etherscan.io/tx/0xfab551c7f7550d6a1b91425efc2fee5a27832fa5b2f74f0bd4a60e40364a67e1),
[**resolveWithVaa**](https://sepolia.etherscan.io/tx/0x914337a888d19e0cc6d96dac017234deb8f461948b921a323d0ef293de87db44),
[settleAssertion](https://sepolia.etherscan.io/tx/0x48bf0c502240376ca485e5168461860db9f53c9b2e7195999677a7fa79195399),
[unwrap](https://sepolia.etherscan.io/tx/0x601593042efd5dc929d119893e0fbd5eff606ce3ac752aff8e8797d61c92c849).
Result: `settlementResolution: false`. Total cost was about 0.0011 ETH, almost all of it the 50% of the losing 0.002 bond that UMA burns. Log: `out/flow-sepolia.log`.

**Tempo Moderato: SaringMarket.** Wormhole has a testnet core on Tempo, so this one is live too.
`SaringMarket` [`0x5780c7e56f46ae0df0e43acfc184b0c47ea0f482`](https://explore.testnet.tempo.xyz/address/0x5780c7e56f46ae0df0e43acfc184b0c47ea0f482) (Sourcify on contracts.tempo.xyz):
[deploy](https://explore.testnet.tempo.xyz/tx/0xe05e8eb3415b466e0b7a8b8fbbd0cb2a09bf85586f48c860eee6e60a5b4f150c),
[bet A 3 pathUSD YES](https://explore.testnet.tempo.xyz/tx/0x382a47b5ce71728aeaadd1a860f2b7f48bf03d6e9f68636f2800bde30c7e76e4),
[bet B 2 pathUSD NO](https://explore.testnet.tempo.xyz/tx/0x99ff9ff52ea319ebbf5f540fba35b319513530550f121c460596f050651a0687),
[**settleWithVaa** (sent by bettor B)](https://explore.testnet.tempo.xyz/tx/0x93b87af3d4c0ac42db03178eb91672c962f01e3e32542af06063574d51b5bddc) giving outcome No,
[claim B +5 pathUSD](https://explore.testnet.tempo.xyz/tx/0xd8b751302525261128ade2af948ea98d1978fec8fc4d3777df4a8a8bfb916b0c). Log: `out/flow-tempo.log`.

## Tests

- **Foundry, 31/31** (`out/forge-test-{arbitrum,base,tempo}.log`). Each adapter has fork tests against the **real core bridge** of its chain with the **real recorded VAA**:
  - positive: full UMA OOv3 flow (Arbitrum fork) / full Reality.eth flow (Base fork) / market payout (Tempo fork), all with `relayer = address(0)`. The decoded verdict is checked, and a second submission reverts.
  - tampered payload: one tally byte flipped reverts with `BadVaa("VM signature invalid")`.
  - wrong emitter: a genuine guardian-signed devnet VAA from another Solana program (`out/foreign-vaa-1222.json`) reverts `WrongEmitter`, and so does our VAA on a contract that expects another emitter.
  - wrong court: the VAA's court differs from the bound court, so it reverts `WrongCourt`.
  - Every older EIP-712 test still passes.
- **Wrong owner / not resolved: enforced on Solana, before any VAA can exist.** `cargo test` (`out/cargo-test.log`) covers good court, unresolved, pending,
  wrong owner, and bad discriminator. On devnet (`out/attest.log`, simulated, nothing lands):
  - the payer wallet (owned by System) gives `InvalidAccountData`;
  - unresolved Saring court `4xvqbCPm…WfVV` gives `custom program error: 0x1`;
  - the resolved court succeeds.
  - so does the fresh v3.2 court `3W2eB4oT…81FR`. v3.2 only appends `pending_computation` after the fields the program reads, so the same binary handles both layouts.

## Commands

```bash
cd ~/blindcourt/wormhole && npm install
(cd program && cargo test && cargo build-sbf)                 # deployed: solana program deploy target/deploy/saring_wormhole.so -u devnet
npx tsx attest.ts <court>                                     # post on devnet + wait for VAA -> out/vaa-<court>.json
npx tsx attest.ts --simulate <account>                        # show the program's refusal, free
(cd ../arbitrum/contracts && forge test); (cd ../base/contracts && forge test); (cd ../tempo/contracts && forge test)
npx tsx flow-reality.ts [court]                               # Base Sepolia
npx tsx flow-uma.ts arbitrum [court]                          # Arbitrum Sepolia
npx tsx flow-uma.ts sepolia [court]                           # Ethereum Sepolia (key ~/.saring-eth)
npx tsx flow-tempo.ts [court]                                 # Tempo Moderato
```

## Limits (stated plainly)

- **Testnet guardians.** On testnet, one guardian signs. The security we inherit is Wormhole's: 13 of 19 guardians on mainnet.
- **Upgrade authorities.** `saring_wormhole` and the Saring program `3CeQ1D…fyHy` are both upgradeable by our devnet wallet `3eDPfx…SLtQ`. Someone holding that
  key could deploy code that posts a false message. Removing this means running `solana program set-upgrade-authority <id> --final` (irreversible) or moving
  the authority to a multisig. We have not done it while the Saring program is still being upgraded.
- **Court binding is still an owner action.** `bindCourt` (UMA, Reality.eth) is owner-only, because the assertion or question id exists only after creation.
  It is public, and a disputer should check `CourtBound` before disputing. The Tempo market has no binding: its id is the court itself.
- **Finality and fees.** A VAA needs Solana finality (about 15 s) plus guardian observation. On devnet it appeared within a minute. Each post pays rent for the
  message account, plus the core fee, which is 0 on devnet. Anyone can pay; the payer has no say over the content.
- **Replays.** A VAA is a fact about a resolved court, which is final, so replaying it for the same court changes nothing. Each dispute is settled at most once
  (`AlreadyResolved` / `AlreadyRuled` / `MarketClosed`).

## Known issues (security review, 2026-10-13)

Found in review; the deployed contracts were not redeployed. Full write-up: `research/56-security-review.md` in the workspace.

- **The relayer key can still rule, and it can front-run the VAA (High).** Four of the five Wormhole deployments were built
  with a non-zero relayer: `relayer()` is `0x1f80…e682` on Base `0x3848…682a`, Arbitrum `0x6ae4…6c` and Sepolia `0x2618…dcda0`,
  and `0x1cc1…c5ec` on Tempo `0x5780…f482`. `resolve` / `rule` / `settle` accept any verdict that key signs, for any bound
  court, before the court has resolved, and whoever rules first wins (`AlreadyResolved` / `AlreadyRuled` / `MarketClosed`).
  On those four, "no Saring key in the verdict" holds only if that key is never used. Only Tempo `0x4df7…5eae` (and any
  HyperCourt deployed with `relayer = 0`) is VAA-only. Fix: redeploy with `relayer = address(0)`, or delete the EIP-712 entry
  points.
- **The payload names the court, not the question (Medium, trust).** The 45-byte payload carries no market or question hash,
  so the owner's `bindCourt` is the only link between a dispute and a court. Courts are permissionless on Solana (anyone can
  `create_court`, seat themselves and resolve), so a valid VAA exists for any court an attacker runs. The contracts are safe
  only while the owner binds honestly, and nothing stops one court from being bound to several disputes. Fix: payload v2
  appends `sha256(market)` and the court authority, and `bindCourt` stores the expected hash and checks it.
- **Off-chain readers did not check guardian signatures.** `sdk/src/wormhole.ts verifySaringVaa` only parsed the VAA.
  Fixed: it now checks quorum signatures against the guardian set stored by the Solana core bridge
  (`sdk/out/verify-vaas.ts` runs it on every live VAA and on tampered copies). `docs/court.html` now shows only events from
  the deployed Saring contracts. Before, any contract emitting a look-alike `Settled`/`Ruled` for the court showed as "settled".
