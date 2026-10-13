# @saring/sdk

TypeScript SDK for venues that want to send prediction-market disputes to **Saring**, a
conflict-blind jury on Solana + Arcium MPC. Jurors who hold a position in the disputed market
are dropped inside MPC, and the chain never learns which jurors were dropped.

- Program: `3CeQ1DQYwXjNcr6hYwmACzUwyU1DNxWL9HtiCaVKyfHy` (devnet), Arcium cluster offset `456`
- Circuits: `init_court_v3`, `add_juror_v3`, `record_positions_v3`, `cast_v3`, `resolve_v3`

| File | What it is for |
|---|---|
| `src/index.ts` | `SaringClient`: run a court (open, seat, mirror, cast, resolve) and the built-in market |
| `src/venue.ts` | Read a verdict without a client or wallet: `readCourtVerdict`, `verdictToYesWins` |
| `src/wormhole.ts` | Saring verdict VAAs: `fetchSaringVaas`, `parseSaringVaa`, `verifySaringVaa` (guardian signatures + emitter + tally vs the live court) |
| `src/panta.ts` | Panta adapter: verdict → Panta `resolve_event(_usdc)` instruction, plus a mainnet simulation helper |
| `src/idl/` | Saring IDL and generated types (copied from `target/`), Panta `balr_market` IDL |
| `examples/` | `full-dispute.ts` (real devnet dispute), `panta-adapter.ts` (mainnet simulation) |
| `out/` | Logs and JSON from the last runs of both examples |

## Quickstart (from the release tarball)

```bash
npm i https://github.com/PugarHuda/saring/releases/download/sdk-v0.1.0/saring-sdk-0.1.0.tgz \
      @solana/web3.js @anchor-lang/core@^1.0.2 @arcium-hq/client@0.15.0
```

The tarball ships compiled `dist/` (CommonJS + `.d.ts`), so plain Node works, no TS toolchain needed.
Program: devnet. Every call below hits the real chain.

**1. Open a court** (you become its authority) and seat jurors:
```ts
import { Connection, Keypair } from "@solana/web3.js";
import { SaringClient, identityId, newBallotKey } from "@saring/sdk";
const saring = new SaringClient(new Connection("https://api.devnet.solana.com", "confirmed"), payer /* Keypair or wallet */);
const { courtId, court } = await saring.openCourt("mymarket:1234");
const key = newBallotKey();                                              // hand to the juror privately
await saring.seatJuror(courtId, await identityId(jurorWallet), key);
```

**2. Mirror the market's holders** (MPC drops any juror among them, without revealing who):
```ts
await saring.mirrorPositions(courtId, await Promise.all(holders.map(identityId))); // 6 ids per MPC call
await saring.cast(courtId, { jurorId, key, yes: false });
await saring.resolve(courtId);
```

**3. Read the verdict** (no wallet, no client):
```ts
import { readCourtVerdict, verdictToYesWins } from "@saring/sdk";
const v = await readCourtVerdict(connection, "24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb");
// { resolved: true, yes: 0, no: 1, excluded: 1, incomplete: false, outcome: "NO" }
const yesWins = verdictToYesWins(v); // false; throws on unresolved / tie / incomplete
```

**4. Verify a Wormhole VAA** of a verdict against the live court:
```ts
import { fetchSaringVaas, verifySaringVaa } from "@saring/sdk";
for (const { sequence, vaa } of await fetchSaringVaas()) {           // Wormholescan testnet, Saring emitter
  const r = await verifySaringVaa(connection, vaa);                  // throws on bad signatures, wrong emitter or tally mismatch
  console.log(sequence, r.court.toBase58(), r.verdict.outcome);
}
```
`verifySaringVaa` checks the guardian signatures (quorum, ascending indices, recovered against the guardian set the
Wormhole core bridge stores on Solana devnet, the same check `parseAndVerifyVM` runs on EVM), the emitter
(`saring_wormhole` PDA, chain 1), and that the payload tally equals the court account. `sdk/out/verify-vaas.ts` runs it
on every live VAA and checks that tampered copies are rejected. The `sdk-v0.1.0` tarball predates the signature check.
In that version, `verifySaringVaa` only parsed the VAA.
See the whole trail for any court at <https://pugarhuda.github.io/saring/court.html>.

Tested from a clean directory with the tarball: steps 3 and 4 return NO 0/1/1 for `24gQ…YGb` and verify all three
recorded VAAs (`24gQ…YGb`, `BT7f…kZhr`, `H7Bd…NKU1`).

## Build from source

```
npm run build                                 # tsc -p tsconfig.build.json -> dist/
npm pack                                      # saring-sdk-0.1.0.tgz
npx tsc -p sdk --noEmit                       # typecheck (from the repo root)
npx ts-node --transpile-only -P sdk/tsconfig.json sdk/examples/full-dispute.ts
npx ts-node --transpile-only -P sdk/tsconfig.json sdk/examples/panta-adapter.ts [court] [pantaMarket]
```
The examples need `RPC_URL` (devnet) and `MAINNET_RPC_URL`, plus a devnet keypair at `~/.config/solana/id.json`.

## Usage

```ts
import { Connection, Keypair } from "@solana/web3.js";
import { SaringClient, identityId, newBallotKey } from "@saring/sdk";

const saring = new SaringClient(new Connection(DEVNET_RPC, "confirmed"), keypairOrWallet);
const { courtId, court } = await saring.openCourt("panta:3wdVRLDi…");           // you become the court authority
const key = newBallotKey();                                                     // give it to the juror, privately
await saring.seatJuror(courtId, await identityId(jurorWallet), key);
await saring.mirrorPositions(courtId, await Promise.all(holders.map(identityId))); // 6 ids per MPC call
await saring.cast(courtId, { jurorId, key, yes: false });                        // anyone can relay a ballot
const verdict = await saring.resolve(courtId);   // { yes, no, excluded, incomplete, outcome, queueSig, callbackSig }
```

On the venue side, with no client:

```ts
import { readCourtVerdict, verdictToYesWins } from "@saring/sdk";
const v = await readCourtVerdict(connection, courtAddress); // owner checked == Saring program
const yesWins = verdictToYesWins(v);                         // throws on unresolved / tie / incomplete
```

## API

### `new SaringClient(connection, signer, clusterOffset = 456)`
`signer` is a `Keypair`, or any `{ publicKey, signTransaction }` (wallet adapter).
Every transaction is confirmed by polling `getSignatureStatuses` over HTTP; Anchor's websocket
confirmation hangs on some RPC providers.

MPC steps send the queue transaction, wait for the Arcium callback
(`awaitComputationFinalization`, 300 s timeout), and return `{ queueSig, callbackSig }`.
`callbackSig` is the oldest **successful** transaction on the computation account besides the
queue tx: Arx nodes race to deliver it, and the late duplicates fail with
`AlreadyCallbackedComputation`. If the callback logs a `ComputationAbortedEvent`, the step throws
`MpcAbortedError` (the court state did not change).

| Method | Circuit / instruction | Notes |
|---|---|---|
| `openCourt(question, courtId?)` → `{courtId, court, queueSig, callbackSig}` | `init_court_v3` | question ≤ 64 UTF-8 bytes; court PDA `["court", authority, id u32 LE]` |
| `seatJuror(courtId, jurorId, key)` | `add_juror_v3` | `(id, key)` encrypted client-side (x25519 + RescueCipher to the MXE key). Authority only |
| `mirrorPositions(courtId, ids[])` → `MpcResult[]` | `record_positions_v3` | batches of 6, padded with 0. Authority only |
| `cast(courtId, {jurorId, key, newKey?, yes}, authority?)` | `cast_v3` | counts only with the seat's current key; non-zero `newKey` rotates it. Any payer |
| `resolve(courtId)` → `MpcResult & Verdict` | `resolve_v3` | Authority only. Locks the court |
| `resetPending(courtId)` | `reset_pending` | releases a stuck lock after ~300 slots |
| `readVerdict(court)` / `waitForVerdict(court, timeoutMs)` | – | `{resolved, yes, no, excluded, incomplete, outcome}` |
| `createMarket(court)`, `bet(court, yes, lamports)`, `claim(court)` | market | pari-mutuel pool settled by the verdict; tie or incomplete refunds |
| `courtAddress(courtId, authority?)`, `mxePublicKey()`, `send(tx)` | – | helpers |

Free functions: `identityId(wallet)` (same as `panta/panta.ts`: first 4 bytes LE of SHA-256(pubkey), never 0),
`newBallotKey()`, `newCourtId()`, `courtAddress`, `marketAddress`, `vaultAddress`.

`outcome` is `"YES" | "NO" | "TIE" | "INCOMPLETE" | null`, by the same rule as the program's `claim`.

### `venue.ts`
- `readCourtVerdict(connection, courtAddress, programId?)`: fetches the account, refuses one not owned by the
  Saring program, decodes `CourtAccount` with the IDL's `BorshAccountsCoder` (discriminator checked).
- `verdictToYesWins(verdict)`: `true`/`false`, or throws on unresolved, tie, or incomplete.
- `decodeCourt(data)`, `toVerdict(court)`.

### `panta.ts`
- `buildPantaSettleIx(connection, { event, oracle, verdict, instruction? })` → `{ instruction, name, yesWins, accounts, vaultSource }`.
  `instruction` is `"resolve_event"` (default) or `"submit_oracle_result"`; the `_usdc` variant is picked automatically.
- `simulatePantaIx(connection, ix, feePayer)`: `simulateTransaction` with `sigVerify: false, replaceRecentBlockhash: true`;
  returns `err`, logs, and the parsed Anchor error.
- `readPantaEvent`, `readPantaConfig`, `discoverPantaVaults`, `pantaMarketConfig`, `pantaReviewRequest`.

How the accounts are resolved: the instruction and its args are encoded from Panta's IDL. Anchor's
resolver derives the PDAs whose seeds the IDL gives (`market_config`, `creator_fee_vault_usdc`, and the
vault's associated token accounts) and fills the fixed program addresses. `usdc_mint` is read from Panta's
`MarketConfig`. The IDL gives **no seeds** for `vault` (SOL markets) or `vault_authority` (USDC markets,
a per-market `TokenVault` account). 970 guessed seed combinations did not match, so the adapter reads that
account from the market's own past Panta instructions, decoded with the same IDL (`vaultSource` is
the transaction it came from).

## Venue integration: Panta

```
Panta (mainnet)                                   Saring (devnet today)
dispute_resolved_event(proposed_yes_wins)
  -> ReviewRequest ["review_request", event]
  -> MarketDisputed {event, bond}          ==>    openCourt("panta:<event>")
                                                   mirrorPositions(every UserPosition holder of <event>)
                                                   seatJuror x k  ->  cast ...  ->  resolve
                                                   CourtAccount {yes, no, excluded, incomplete}
                                           <==    readCourtVerdict -> verdictToYesWins
resolve_event_usdc(yes_wins)  (buildPantaSettleIx)
  -> EventResolved, ResolutionDisputeSettled {disputer_correct, ...}
```

`panta/watch.ts` covers the left-to-right half (watching for disputes and opening a court).
This SDK covers the court and the way back: verdict → Panta instruction.

## Results from the last run

See `out/full-dispute.log`, `out/court.json`, `out/panta-adapter.log` (SOL market), `out/panta-adapter-usdc.log` (USDC market), `out/panta-simulation*.json`.

**`full-dispute.ts` (devnet, 106 s, 0.066 SOL including court rent):** court
`24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb` for Panta market `3wdVRLDiMeuWRjGcFq2FZgAyCLhswTwNSKEHgNFRSZNB`.
It seated 3 jurors (one holds a position in the market; two are Panta traders with no position there) and
mirrored all 42 holders in 7 encrypted batches. Ballots: the holder voted YES, a clean juror voted NO, and the
other clean juror sent YES with a wrong key. Verdict: **yes=0 no=1 excluded=1 incomplete=false → NO**. The
holder's ballot was dropped inside MPC and the wrong-key ballot was ignored. A 0.001 SOL NO bet in the built-in
market was claimed back in full.

**`panta-adapter.ts` (mainnet simulation, nothing signed or sent).** The NO verdict becomes `yes_wins=false`.

| Run | Markets | Result |
|---|---|---|
| A: `resolve_event`, oracle = our operator key | `Hh6G6x7z…` (SOL), `2ypz5gkf…` (USDC) | fails `Unauthorized (6025)` at `resolve_event.rs:37` / `resolve_event_usdc.rs:46`: the oracle check |
| B: `resolve_event`, oracle = Panta admin[0], unsigned | same | passes authorization, fails `OracleResultNotSubmitted (6097)`: no proposed result on these markets yet |
| C: `submit_oracle_result`, oracle = Panta admin[0], unsigned | same | **succeeds** in simulation (emits `OracleResultSubmitted`) |

Our key is rejected only by Panta's oracle authorization. With the key Panta itself uses, the same accounts and
encoding pass every check up to Panta's own state machine. On these markets that means proposing first, then
resolving after the dispute window. In A, Panta's treasury is the fee payer because our key holds no mainnet
SOL; signatures are not verified in simulation.

## Limits

- **Panta must accept the signer.** `resolve_event` requires Panta's `oracle` (relayer or admin; an admin
  on the dispute path). We hold no Panta key, so the instruction was only **simulated** on mainnet, and
  nothing settled there. For Panta to adopt this, their oracle operator signs `yes_wins` from
  `verdictToYesWins`, or Panta adds the court's authority as a resolver.
- **Cross-chain trust.** The court runs on devnet, Panta on mainnet. The bridge is whoever reads the
  devnet `CourtAccount` and signs on mainnet. That is a trusted relay until the program is deployed on
  mainnet next to Panta and checked by CPI or account read.
- **Seedless vault accounts.** `vault` / `vault_authority` are discovered from the market's transaction
  history. A market with no Panta instruction in its last 50 transactions that names it can't be resolved
  this way (pass a larger `scan`, or Panta could publish the seeds).
- **Authority powers.** The court authority seats jurors and mirrors positions (it stands in for sortition
  and an identity attestation). Juror identity is wallet-derived (`identityId`); one person with many wallets
  is not handled.
- **Capacity.** 48 identity slots per court (holders plus at most 6 bettors in the built-in market). If they
  overflow, the verdict comes back `incomplete` and `verdictToYesWins` refuses it.
- **Liveness.** Each MPC step takes seconds to minutes on devnet. An aborted computation throws
  `MpcAbortedError` and leaves state unchanged; a lost callback needs `resetPending` after ~300 slots.
- Compiled `dist/` is not shipped. `main` points at the `.ts` sources.
