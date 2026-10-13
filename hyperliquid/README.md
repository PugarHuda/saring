# Saring x Hyperliquid (HIP-4 outcome markets)

A Saring court on Solana devnet for a **live Hyperliquid mainnet HIP-4 outcome**, with the outcome's
**real holders** read from HyperCore and mirrored into the court, encrypted. The verdict is turned into
the exact `settleOutcome` action a HIP-4 deployer would send. That action is **not submitted** (see Limits).

## What's real

| Piece | Source | Real? |
|---|---|---|
| Questions / outcomes | `POST https://api.hyperliquid.xyz/info {"type":"outcomeMeta"}` (mainnet) | live: 325 outcomes, 37 questions, 3 deployers on 2026-10-12 |
| Holder discovery | `{"type":"recentTrades","coin":"#<enc>"}` per side, `enc = 10*outcome + side`; each trade lists `users:[a,b]` | live |
| Holder confirmation | `{"type":"spotClearinghouseState","user":addr}`, outcome side appears as coin `"+<enc>"` with non-zero `total` | live, per address |
| Court, jurors, mirror, ballots, verdict | Saring program on Solana devnet + Arcium MPC (`sdk/src`) | real devnet txs |
| HyperCore settlement | `outcomeDeploy` / `settleOutcome` payload built from the verdict | printed, **not sent** |

`tokenDetails` rejects outcome tokens (no spot token index), and there is no holder-list endpoint, so
holders = trade counterparties whose live spot state shows a non-zero `+<enc>` balance. This finds
active holders, not every holder ever (only the last trades per side are returned).

### Identity for EVM addresses
Saring's `identityId` is the first 4 bytes (LE) of SHA-256 over the wallet's raw public key bytes (32-byte
Solana pubkey), never 0. For Hyperliquid addresses, `evmIdentityId` (hl.ts) is the same construction
over the **20 raw address bytes** (case-insensitive). A juror whose HL address holds a position
therefore collides with their own mirrored position inside MPC and nowhere else.

## Commands

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; cd ~/blindcourt; set -a; . ./.env.local; set +a
TS="npx ts-node --transpile-only -P tsconfig.json"
$TS hyperliquid/hl.ts questions          # list HIP-4 questions        -> out/questions.json
$TS hyperliquid/hl.ts holders 391        # holders of question #391    -> out/holders-q391.json/.log
$TS hyperliquid/court.ts 391 8659        # court for outcome 8659      -> out/court-<court>.json, court-q391-o8659.log
```

## Result (2026-10-12)

Question **#391 Ballon d'Or 2026** (venue `out`, template `awardWinner`, deadline 2026-11-05).
Court target: outcome **8659 "Lamine Yamal"** (`#86590` Yes / `#86591` No).

- 160 recent trades across the question's 18 sides, 31 counterparties, **18 confirmed holders** (`out/holders-q391.log`).
  Every holder of any outcome in the question is mirrored as conflicted: question outcomes are linked
  through negate/merge, so a Mbappe-YES holder has a stake in whether Yamal wins.
- Court `FoRHmrnMrhHieiCCW51GwuQHGpXzvbNzDbRR6inzPQBv` (label `hl:out:q391:o8659`),
  [open tx](https://explorer.solana.com/tx/rRLyzgG87SdTxynbe3RBPTPXuTjch4B1ktuoaAnLEx67cpKpVqzUCLxXgkU8bCRinc2bvsC9GjD98husDLjmCr4?cluster=devnet).
- Jurors: **A = real HL holder `0x27343233ae52bc46d85138bdaf566d6a1960f947`** (holds `+86571`, `+86591`, `+86601`, `+86641`),
  B and C = fresh EVM addresses confirmed live to hold no outcome tokens.
- 18 holder identities mirrored encrypted in 3 MPC batches.
- Scripted ballots: A votes YES, B and C vote NO.
- **Verdict: yes 0, no 2, excluded 1, incomplete false -> NO**
  ([resolve tx](https://explorer.solana.com/tx/5vskW3KgJ9WYKgkzy8773i3tF7aFpUwqvviLNYodNyAjm8oCkNCVwKz7wF5nfNSw3BN31t8uCjTU6xZCHNFgGfNX?cluster=devnet)).
  The holder's ballot was dropped inside MPC; the chain only shows the count.
- Devnet SOL spent: 0.053.

HyperCore settlement a deployer would submit (**not submitted: requires the deployer's settleOutcome permission**):

```json
{ "type": "outcomeDeploy", "venue": "out",
  "operation": { "settleOutcome": { "outcome": 8659, "settleFraction": "0", "details": "",
    "nameAndDescription": ["template:awardCandidate", "candidate:Lamine Yamal|subject:Lamine Yamal (FC Barcelona, Spain)"],
    "sideNames": ["Yes", "No"] } } }
```

Mapping: YES -> `"1"`, NO -> `"0"`, tie/incomplete -> `"0.5"` for a **standalone** outcome. HIP-4 docs
allow question outcomes to settle only to `"0"` or `"1"`, so for a question outcome (like 8659) a
tie/incomplete verdict yields no action (re-run or escalate).

## Limits

- **No settlement.** `settleOutcome` can only be sent by the venue's deployer or a sub-deployer it granted
  via `setSubDeployers`. Mainnet HIP-4 deployment is permissioned (3 deployers); we are none of them.
  Our own testnet venue would need testnet USDC, and the testnet faucet only serves addresses that have
  deposited on mainnet; the user declined a real-money mainnet deposit. So no `settledOutcome` proof.
- The ballots are scripted and the Ballon d'Or is undecided; the verdict demonstrates the mechanism, not a call.
- Holder discovery covers recent-trade counterparties only; the court holds at most 42 mirrored positions.
- One relayer key would hold the settle permission in production: it settles what the MPC verdict says,
  and the deployer can revoke it.

## Permissionless fallback on HyperEVM (`hyperevm/`, `fallback.ts`)

If the HIP-4 settle grant or the 100 HYPE stake (`README-testnet-settle.md`) never comes through, this path still
puts the verdict on Hyperliquid testnet and acts on HyperCore, with no permission from anyone. It needs about 0.02 faucet HYPE on
`0x71Ea…` (HyperEVM, chain 998). The faucet is https://faucet.quicknode.com/hyperliquid/testnet, and it uses a human bot-check.

`hyperevm/src/SaringHyperCourt.sol`:
- `open(outcome, court, inQuestion)` binds a HIP-4 outcome id to a Saring court.
- `dispute(outcome, claimYes)` takes a HYPE bond and bridges it to **the contract's own HyperCore spot account**:
  native HYPE sent to `0x2222…2222` credits `msg.sender` on Core. The disputer must already exist on Core
  (precompile `0x…0810`), so the refund cannot get stuck.
- `settle(outcome, verdict, sig)` takes the same EIP-712 `Verdict` the relayer signs for `tempo/`.
  `settleWithVaa(outcome, vaa)` takes a guardian-signed VAA from the `saring_wormhole` emitter instead, so no Saring key
  is involved. Wormhole core is live on HyperEVM testnet at `0xBB73cB66C26740F31d1FabDC6b7A46a038A300dd`
  (guardian set 0, Wormhole chain 47). The contract reuses `wormhole/contracts/SaringWormhole.sol` unchanged.
- On settlement the contract stamps the HyperCore L1 block (`0x…0809`) and the HYPE oracle price (`0x…0807`, perp 135).
  It checks its Core HYPE balance (`spotBalance` `0x…0801`, token 1105). If the disputer was right, or the
  verdict is void, it returns the bond **on HyperCore** through CoreWriter `0x3333…3333` action 6 `spotSend(disputer, 1105, wei)`.
  Otherwise the bond stays on the contract's Core account for juror rewards. Juror payout is not built yet.
- `settleFraction(outcome)` returns 1e18 for YES and 0 for NO. A tie or an incomplete verdict returns 0.5e18 for a standalone
  outcome and reverts for a question outcome, because question outcomes settle only to 0 or 1. A HIP-4 deployer's keeper copies
  this value into `outcomeDeploy settleOutcome`.

The spotBalance read precompile reverts for outcome-token encodings, so the contract does not read HIP-4 positions.
It does read USDC/HYPE balances, the L1 block number, the oracle price and coreUserExists. All four were checked live against testnet with
`cast call --override-code`.

```
cd hyperliquid/hyperevm && forge build && forge test   # 10 tests, incl. real VAA vs real Wormhole core on a HyperEVM testnet fork
cd .. && npx tsx fallback.ts status | wait | run
```
`run` does the following. (1) It funds a separate disputer address, which bridges 0.001 HYPE to Core to create its account. (2) It deploys the contract and opens outcome 8659 for court
`FoRH…zPQBv`. (3) The disputer posts a 0.01 HYPE bond claiming NO. (4) It reads the devnet verdict with `sdk/src/venue.ts`, signs it and settles. (5) It
confirms the CoreWriter spotSend on HyperCore through `info spotClearinghouseState` of the disputer. (6) It settles demo outcome 0
from the recorded VAA of court `24gQ…`. Tx links and the HyperCore before/after are written to `hyperevm/deployments/testnet.json`.

## Known issues (security review, 2026-10-13)

- **One disputer per outcome lets anyone squat the dispute slot risk-free (Low).** `dispute` accepts a bond of 1e10 wei (one
  Core unit), and only the first disputer counts. Once the court resolves on Solana, the verdict is public before anyone relays
  the VAA. Anyone can then dispute on the known-winning side with a dust bond, get it back, and lock out a real disputer. Fix:
  set a minimum bond, and close disputes at a deadline set in `open`.
- **The relayer fallback depends on the deploy argument.** Deploy with `relayer = address(0)` for the VAA-only trust model.
  See `wormhole/README.md`.
- `spotSend` through CoreWriter is asynchronous. `BondReturnedOnCore` is emitted when the action is queued, not when HyperCore
  executes it, so check the disputer's Core balance before treating a refund as done.
