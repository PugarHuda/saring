# Saring web demo

Hosted at https://saring-silk.vercel.app.

Runs one dispute from the browser against Solana devnet and the Arcium devnet cluster (offset 456). The case is a real Panta market read from Solana mainnet: 5 scripted jurors (3 real holders of the market, 2 real Panta traders without a position) plus the visitor as juror #6.

This is a replay: we take a real Panta market and run it as if it were disputed (the demo market was never actually disputed). Panta positions are public on chain; Saring keeps the jury secret and keeps holder ids encrypted inside the court, so the same court works for venues with private positions.

## Panta API

`src/pantaApi.ts` talks to the Panta REST API through `api/panta.js` (key stays server-side). The page uses it three ways:

- **Market picker** ("Pick a Panta market to replay as a dispute"): Panta's catalog joined with holder counts read on chain, filtered to markets that fit the court (3–47 holders). Picking one reloads the case; locked while a run is in progress.
- **Panta market card**: title, category, phase/status, resolved, volume, YES/NO price, resolution time, oracle and `sentToUma` (Panta escalates disputes to UMA, the voters the Conflict Report measured).
- **God view cross-check**: for each juror, whether Panta's indexer lists a position in this market. The indexer sometimes misses positions that exist on chain; those show as "chain: yes · API: not indexed". Chain is the source of truth.

On explorer you will also see failed duplicate callbacks (error 6204 `AlreadyCallbackedComputation`): Arx nodes race to deliver each result and the program accepts only the first. The page links the one that succeeded.

Before running, the visitor picks their own ballot (YES/NO) and whether to also bet 0.01 SOL on the court's market. Betting gives them a position, so MPC silently drops their ballot and `excluded` goes up by one. The page shows the expected tally until the chain verdict arrives.

## Steps (25 without a bet, 28 with one)

1. Open the court (MPC)
2. Open a pari-mutuel market that settles on this court (transaction)
3. Seat 6 jurors, each with an encrypted id and secret ballot key (MPC)
4. Optional: the visitor bets 0.01 SOL (transaction)
5. Mirror the market's holders (42, plus the visitor if they bet) in batches of 6 (MPC)
6. Cast 8 ballots: 3 conflicted YES, a bribed YES then a NO that rotates the key, the briber's re-sent YES with the stale key (ignored), a clean NO, a forged YES with a guessed key (ignored), the visitor's ballot (MPC)
7. Resolve: MPC drops conflicted jurors and publishes `yes / no / excluded / incomplete` (MPC)
8. Optional: claim the bet (transaction). An incomplete verdict or a tie refunds.

MPC steps link the queue transaction and the successful callback; plain transactions link once. The last finished run (market, court id and address, verdict, links) is kept in `localStorage` under the burner's pubkey, so a reload still shows it; a saved court the current program (v3.1) can't read is dropped silently.

## Settle on Panta (mainnet simulation)

Once a court resolves, the "Settle on Panta" panel turns the chain verdict into Panta's own settlement instruction for the replayed market and simulates it on Solana mainnet from the browser (`src/pantaSettle.ts`, a port of `sdk/src/panta.ts`). Today one oracle key settles Panta disputes; Saring's verdict can replace it.

- Verdict → `yes_wins`: majority YES/NO only. A tie or an incomplete verdict is refused, with the reason shown.
- Instruction: `resolve_event` (or `resolve_event_usdc` for USDC markets), encoded from Panta's IDL (`src/idl/panta.json`, trimmed from Panta's published `balr_market` IDL). Seeded PDAs and fixed program addresses come from the IDL; `usdc_mint` and the treasury from Panta's `MarketConfig`; the seedless `vault` / `vault_authority` is read from the market's recent Panta transactions, decoded with the same IDL. The panel lists every account with its role and where it came from.
- Simulation: `simulateTransaction` with `sigVerify: false, replaceRecentBlockhash: true`. Nothing is signed or sent. The oracle is the visitor's court authority key and Panta's treasury is the fee payer, since the burner holds no mainnet SOL.
- Expected result: Panta's program accepts every account and argument and stops at its oracle check, `Unauthorized (6025)`. Only Panta's oracle key can sign the same instruction. Any other outcome (an earlier Anchor error, or a failure to resolve the accounts) is shown as it is, with the logs and compute units.

RPC: about 4–8 mainnet calls through `/api/rpc?net=mainnet` (`getSignaturesForAddress`, a few `getTransaction`, `getAccountInfo`, `simulateTransaction`), one at a time.

## Run

```bash
cd app
yarn install
yarn dev            # http://localhost:5173
yarn build          # type-checks (tsc) and writes dist/
yarn preview        # serves dist/
```

Requirements: the program `3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy` is deployed on devnet, its MXE is initialized on cluster 456, and all v3 comp defs are initialized. The UI never initializes comp defs.

## Wallet and faucet

The page creates a burner keypair and stores it in `localStorage` (one per origin). "Get devnet SOL" calls `api/faucet.js`, which sends 0.15 SOL (enough for one run, which costs about 0.10 SOL, ~0.105 with a bet) to a burner holding less than 0.12 SOL, once per 10 minutes per IP and address. The page keeps the cooldown end in `localStorage` and shows why the button is disabled. https://faucet.solana.com works too.

If a step fails, "Retry from the failed step" continues the same court. A step whose queue transaction already landed is only re-awaited, never re-sent. "Start a new court" begins again with a fresh court id and fresh keys.

## RPC

All RPC goes through `api/rpc.js`, a same-origin proxy that keeps the provider key server-side and only allows the methods the demo needs (writes only on devnet). In `yarn dev`, Vite forwards `/api` to the hosted deployment, so local dev needs no key. To use your own RPC instead:

```bash
VITE_RPC_URL=https://devnet.helius-rpc.com/?api-key=... VITE_MAINNET_RPC_URL=https://mainnet.helius-rpc.com/?api-key=... yarn dev
```

## IDL

`src/idl/` is a copy of `target/idl/blindcourt.json` and `target/types/blindcourt.ts` (`target/` is gitignored). After a rebuild of the program, copy them again:

```bash
cp target/idl/blindcourt.json target/types/blindcourt.ts app/src/idl/
```

## Browser shims

`@arcium-hq/client` imports Node's `crypto` and `fs` and default-imports `@anchor-lang/core`. `vite.config.ts` aliases them to `src/shims/`: `randomBytes` and `createHash` (sha256, sha3-256) on top of WebCrypto and `@noble/hashes`, a throwing `fs`, and anchor's browser build re-exported with a default export.
