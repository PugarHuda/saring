# Saring web demo

Hosted at https://saring-silk.vercel.app.

Runs one dispute from the browser against Solana devnet and the Arcium devnet cluster (offset 456). The case is a real Panta market read from Solana mainnet: 5 scripted jurors (3 real holders of the market, 2 real Panta traders without a position) plus the visitor as juror #6.

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

MPC steps link the queue transaction and the successful callback; plain transactions link once. The last finished run (court id, verdict, links) is kept in `localStorage`, so a reload still shows it.

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

The page creates a burner keypair and stores it in `localStorage` (one per origin). "Get devnet SOL" calls `api/faucet.js`, which sends 0.12 SOL (enough for one run, which costs about 0.08 SOL) to a burner holding less than 0.1 SOL, once per 10 minutes per IP and address. https://faucet.solana.com works too.

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
