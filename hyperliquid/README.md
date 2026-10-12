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
