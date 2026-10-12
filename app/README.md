# Blindcourt web demo

Runs the `tests/blindcourt.ts` scenario from the browser against Solana devnet and the Arcium devnet cluster (offset 456): open a court, seat 5 encrypted jurors, record 5 encrypted positions, cast 7 ballots (including the bribed overwrite), resolve, then read `yes / no / excluded` from the court account.

## Run

```bash
cd app
yarn install
yarn dev            # http://localhost:5173
yarn build          # type-checks (tsc) and writes dist/
yarn preview        # serves dist/
```

Requirements: the program `3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy` is deployed on devnet, its MXE is initialized on cluster 456, and all five comp defs are initialized. The UI never initializes comp defs.

## Wallet

The page creates a burner keypair and stores it in `localStorage` (one per origin, so `localhost:5173` and `localhost:4173` get different burners). Fund the shown address with devnet SOL, either with the Airdrop button or at https://faucet.solana.com. About 0.5 SOL is plenty for the 18 transactions.

If a step fails, "Retry from the failed step" continues the same court. A step whose queue transaction already landed is only re-awaited, never re-sent. "Start a new court" begins again with a fresh court id.

## RPC

The public `api.devnet.solana.com` rate-limits by IP (HTTP 429), and the demo polls each computation until it finalizes. For a live demo, use a dedicated devnet RPC:

```bash
VITE_RPC_URL=https://devnet.helius-rpc.com/?api-key=... yarn dev
```

## IDL

`src/idl/` is a copy of `target/idl/blindcourt.json` and `target/types/blindcourt.ts` (`target/` is gitignored). After a rebuild of the program, copy them again:

```bash
cp target/idl/blindcourt.json target/types/blindcourt.ts app/src/idl/
```

## Browser shims

`@arcium-hq/client` imports Node's `crypto` and `fs` and default-imports `@anchor-lang/core`. `vite.config.ts` aliases them to `src/shims/`: `randomBytes` and `createHash` (sha256, sha3-256) on top of WebCrypto and `@noble/hashes`, a throwing `fs`, and anchor's browser build re-exported with a default export.
