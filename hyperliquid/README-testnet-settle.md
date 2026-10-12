# Saring -> HIP-4 settleOutcome on Hyperliquid testnet

**Status (2026-10-12 22:20 WIB): code ready, signing proven against the live node, not yet settled.**
Our address cannot deploy or settle yet. It has 0 testnet USDC, 0 HYPE, no stake and no grant.
`settle.ts watch` polls every 5 minutes until 13 Oct 12:30 WIB. It runs deploy and settle as soon as either path below opens.

Our testnet deployer address (testnet only, its key in `~/.saring-hl/key` never touches mainnet):
**`0x71Ea955866b658A0bD7f093660Bf698CE1Ccf137`**

## Who can settle (verified live)

Only the outcome's deployer can send `outcomeDeploy settleOutcome`, or an address that deployer granted
via `setSubDeployers`. Example on testnet: venue `dfq` (deployer `0x027f…972a`) grants
`[registerStandaloneOutcomeFromTemplate, settleOutcome]` to `0x512b…1209`. So there are two paths:

| Path | What has to happen | settle.ts |
|---|---|---|
| **(a) Sub-deployer grant** (what we asked for on the Hyperliquid Discord) | An existing testnet deployer grants `0x71Ea…` `registerStandaloneOutcomeFromTemplate` + `settleOutcome` | `access()` finds the grant in `outcomeMeta.deployers[].subDeployers`. We deploy and settle in **their** venue. No funds needed. |
| **(b) Own deployer** | 100 HYPE staked. All 97 testnet deployers have >= 100.0, and undelegated stake counts. | `setup`: buy ~100.5 HYPE on `@1035` (~3,300-3,450 USDC), `cDeposit`, `activateOutcomeDeployer {venueName:"srng"}` |

Path (b) needs testnet USDC. The `claimDrip` faucet pays only addresses that exist on mainnet, and only once per address
(`"Cannot claim drip because user 0x71ea… does not exist on mainnet."`). We do not use multiple wallets to farm the faucet.

## What runs (`npx tsx hyperliquid/settle.ts …`)

- `dryrun`: signs `activateOutcomeDeployer`, `registerStandaloneOutcomeFromTemplate` and `settleOutcome`, then recovers the EIP-712 signer.
- `dryrun live`: posts those actions to testnet `/exchange` while we are unfunded, so nothing can execute. The node
  echoes the address it recovered from our msgpack and signature. Result on 2026-10-12:
  `"User or API Wallet 0x71ea955866b658a0bd7f093660bf698ce1ccf137 does not exist."` for both `outcomeDeploy` actions, and
  `"Must deposit before performing actions. User: 0x71ea…"` for `activateOutcomeDeployer`. The node recovers our address,
  so the action encoding and signing are correct byte for byte.
- `deploy`: `outcomeDeploy registerStandaloneOutcomeFromTemplate`, a testnet mirror of mainnet #391 outcome 8659
  (Lamine Yamal wins the Ballon d'Or 2026). It is standalone so that a tie or incomplete verdict can settle to 0.5.
- `settle <court>`: reads the Saring court `FoRHmrnMrhHieiCCW51GwuQHGpXzvbNzDbRR6inzPQBv` verdict on Solana devnet
  (resolved NO, 0-2, 1 excluded) and sends `settleOutcome` with `settleFraction` YES=1 / NO=0 / tie=0.5. It confirms through
  `settledOutcome` and writes `out/testnet-settle-<outcome>.json` with explorer tx links.
- `watch`: the poller described above. Its log is at `out/watch.log`, which is not committed.

Signing: L1 actions use EIP-712 `Agent{source:"b",connectionId}` on domain `Exchange/1/1337`, where
`connectionId = keccak(msgpack(action) || nonce || 0x00)`. This is implemented by `@nktkas/hyperliquid/signing`, and the
dry-run checks it independently with viem `recoverTypedDataAddress`. `cDeposit` is user-signed
(`HyperliquidTransaction:CDeposit`, `hyperliquidChain:"Testnet"`, `signatureChainId:"0x66eee"`).

## HyperEVM (chain 998) as an alternative: evaluated, not built

- **Faucet HYPE toward the 100 HYPE stake: not reachable.** The HyperEVM faucets drip roughly 0.1-1 HYPE per 12-24 h per address
  (Alchemy 0.1-0.2 HYPE and needs 0.01 mainnet HYPE; QuickNode shows its amount only after a browser bot-check; Chainstack ~1 HYPE/24 h).
  Native HYPE sent to `0x2222…2222` does reach HyperCore spot and could then be staked with `cDeposit`. But 100 HYPE at <= 1 HYPE/day
  takes about 100 days, and the ~15 h left before 13 Oct 13:59 WIB allow at most 2 claims (<= 2 HYPE). We did not claim: every
  faucet needs a browser bot-check or a login, and we do not automate around those.
- **Holder mirroring inside a HyperEVM contract: not possible today.** Gas is cheap (testnet `eth_gasPrice` is 0.1 gwei, so
  deploying a verdict receiver costs well under 0.01 HYPE). But the spotBalance read precompile `0x…0801` does not expose outcome tokens.
  Live `eth_call` for holder `0x047a…d413`, which holds `+112410` = 418.0 per `spotClearinghouseState`:
  token `0` (USDC) returns a balance, while tokens `112410`, `112411`, `11241` and `100000112410` revert with `PrecompileError`.
  Outcome sides have no spot token index (`tokenDetails` rejects them too), and `PrecompileLib` has no outcome read.
  CoreWriter action 17 can split, merge or negate outcomes, but it cannot read balances or settle. A HyperEVM contract could
  therefore only store relayer-attested holder data, which is the same trust model as `tempo/`, so we did not duplicate it.
