# Threat model

Scope: program v3.1 (`programs/blindcourt/src/lib.rs`), circuits `*_v3` (`encrypted-ixs/src/lib.rs`), clients and Vercel functions as of commit `0fd102e`. Component details are in [ARCHITECTURE.md](ARCHITECTURE.md). This is a devnet MVP and has not been audited.

## Assets

| # | Asset | Where | Property needed |
|---|---|---|---|
| A1 | Jury membership (which ids sit on the court) | MXE state slots 48–55 | Confidentiality from chain observers and bribers |
| A2 | Position-holder set | MXE state slots 0–47 | Confidentiality: traders aren't doxxed |
| A3 | Individual ballots | slots 56–63 | Confidentiality; receipt-freeness |
| A4 | Seat ballot keys | slots 64–71, juror's device | Confidentiality; only the current key authorizes a ballot |
| A5 | Which jurors were excluded | never output | Confidentiality |
| A6 | Verdict `(yes, no, excluded, incomplete)` | `CourtAccount` | Integrity; written at most once |
| A7 | Market funds | vault PDA lamports | Integrity: only rightful payouts, never more than the pool |
| A8 | Court liveness | `pending` / `resolving` flags | Availability |
| A9 | Helius RPC key, Panta API key, faucet secret | Vercel env | Confidentiality; quota |

## Actors

| Actor | Capabilities | Trust |
|---|---|---|
| **Court authority** | Creates the court; is the only one who can `add_juror`, `record_positions`, `resolve` and `reset_pending`. Relays seat and position ciphertexts. | **Trusted** for jury selection, completeness of the position mirror, and timing of resolve. Knows the jury list and the holder list (it encrypts or relays both), but not ballot keys that jurors encrypted themselves, and not ballots. |
| **Juror** | Holds a seat id and secret key; casts and rotates through any relayer. | Untrusted; may be bribed. |
| **Briber / coercer** | Pays jurors, demands keys or "receipts", watches the chain. | Adversary |
| **External attacker** | Anyone with a Solana wallet: can send `cast`, `create_market`, `bet`, `init_*_comp_def`, and hit the Vercel endpoints. | Adversary |
| **Bettor** | Bets on and claims from the settlement market. | Untrusted; may also be a juror. |
| **Relayer** | Pays fees for someone else's `cast`. | Untrusted; learns only that some cast happened. |
| **Arx nodes (Arcium MXE)** | Run the MPC, fetch circuits, sign callbacks. | **Honest majority** (Cerberus backend) for confidentiality and correctness; liveness depends on the cluster. |
| **Vercel / Helius / GitHub** | Host the proxy, RPC, and circuit files. | Trusted for availability only. A swapped circuit file fails the hash check. |

## Trust assumptions

1. **Arcium MXE**: no coalition of Arx nodes beyond the protocol threshold colludes, and outputs are correct and signed. `verify_output` checks the signature against the cluster account. If this fails, every confidentiality property (A1–A5) is lost.
2. **Authority** seats only legitimate jurors, mirrors every position holder (including market bettors) before resolve, and doesn't leak the jury list. This is the biggest trust gap in the MVP (see L1).
3. **Identity**: one wallet = one person. `id = SHA-256(wallet)[0..4]`.
4. **Clients** use a CSPRNG for keys, x25519 secrets and nonces (`crypto.getRandomValues`, `crypto.randomBytes`).
5. **Circuit integrity**: `circuit_hash!` pins SHA-256 of each `.arcis`. Nodes reject other bytes.

## Threats (STRIDE)

Status: **M** mitigated in code · **P** partially mitigated · **A** accepted / documented limit · **Q** open question for auditors.

| ID | STRIDE | Threat | Mitigation | Residual | Status |
|---|---|---|---|---|---|
| T-1 | Spoofing | Anyone overwrites a juror's ballot. The id is public, since anyone can hash a known wallet. | Per-seat secret key, checked inside `cast_v3`. Wrong keys are silent no-ops. | Keys are 31-bit: guessing takes ~2^30 casts on average, each needing an MPC computation and the lock. Widen to ≥ 64 bits for mainnet. | M (v3) |
| T-2 | Spoofing | Framing: an attacker grinds a wallet whose 32-bit id equals an honest juror's id, then gets that wallet mirrored as a holder (by betting, or trading on the venue). The honest juror is excluded. | None on chain. Grinding 2^32 SHA-256 is cheap. | Real. Widen ids, and bind ids to attested identities. | A |
| T-3 | Spoofing | A second wallet evades the conflict filter. | None (wallet-level identity). | Lower bound only; plan is Solana Attestation Service. | A |
| T-4 | Tampering | A concurrent computation overwrites the state (lost update). | `pending` lock on every mutating queue ix, released by every callback including aborts. | See T-8 for `reset_pending`. | M (v3) |
| T-5 | Tampering | Second verdict, or resolve racing itself. | `resolving` flag set at queue time. Callback `require!(!resolved)`. `lock()` and `bet` reject `resolving`. | — | M (v3, v3.1) |
| T-6 | Tampering | Duplicate seating gives one id two ballots. | `add_juror_v3` ignores an id that is already seated, and `id==0` / `key==0`. | — | M (v3) |
| T-7 | Tampering | Silent slot overflow means a conflicted juror escapes the filter. | Overflow flag `F` → `incomplete=true` → market refunds. | Capacity is 48 holders / 8 jurors. | M (v3) |
| T-8 | Tampering | `reset_pending` releases the lock while the original computation is only slow, not dead. Its late callback then overwrites the result of the next computation, or clears `pending` under it. | Only the authority can call it, and only after 300 slots (~2 min). | A slow-but-alive computation still causes a lost update. Fix: store the queued `computation_offset` and have callbacks ignore any computation that isn't the current one. | Q |
| T-9 | Tampering | `resolve` doesn't take `pending`. It passes `court.nonce` as a plaintext at queue time but reads the state **by account reference**. If an in-flight `cast` callback rewrites `state`/`nonce` before the resolve computation reads the account, the MPC may decrypt new ciphertexts with the old nonce. | `resolving` blocks new queues after resolve. The clients always wait for each callback before resolving. | Depends on when Arcium snapshots `.account(...)` args: at queue time (safe) or at execution (garbage tally or abort). **Not verified.** Simple fix: `require!(!court.pending)` in `resolve`, which reintroduces T-13's delay vector. | Q |
| T-10 | Tampering | A bettor joins the market but isn't mirrored, so a juror-bettor isn't excluded. | Authority mirrors bettors. `MAX_BETTORS = 6` keeps holders + bettors within 48. Bets stop once `resolving` is set. | Mirroring isn't enforced on chain. Positions opened after the last `record_positions` escape the filter. | A |
| T-11 | Tampering | Vault drain or over-payout. | Payout uses `u128` with floor division; refunds pay exactly the stake; `claimed` flag; `has_one` bettor/court checks; vault PDA pinned by seeds and bump. | Rounding dust stays in the vault for good. Bet account rent is never returned. | M |
| T-12 | Tampering | Vault drops below rent exemption (tiny first bet, or the final claim leaves dust). | `create_market` pre-funds `minimum_balance(0)`, and payouts never touch it. | — | M (v3.1) |
| T-13 | DoS | Anyone spams `cast` to hold `pending` and block `add_juror` / `record_positions`. | `resolve` doesn't need the lock, so the verdict can't be blocked. | Seating and mirroring can be delayed. The attacker pays an MPC fee per cast. | P |
| T-14 | DoS | Aborted computation leaves `pending` stuck. | `aborted()` clears `pending` on a failed `verify_output`. `reset_pending` after 300 slots if the callback never lands. | Interacts with T-8. | M (v3.1) |
| T-15 | DoS | Using a court before `init_court` lands (zero state isn't a valid ciphertext). | `ready` flag is required by `lock()` and `resolve`. | If the init computation aborts, the court stays `ready=0` for good; the authority opens a new id. | M (v3.1) |
| T-16 | DoS | A swarm of dust bettors overflows the holder set and forces a refund. | Minimum stake 0.001 SOL; at most 6 distinct bettors. | 6 slots can be taken by a griefer for 0.006 SOL, which locks out real bettors. | M/A (v3.1) |
| T-17 | DoS | Nobody resolves. | None: no quorum or deadline. The authority decides when to resolve. | Funds stay locked until the authority resolves. | A |
| T-18 | Info disclosure | The tally leaks individual exclusions in tiny juries (e.g. `excluded = 1` with 1 known bettor). | None beyond the aggregate. | Larger padded juries; optionally reveal only the winning side. | A |
| T-19 | Info disclosure | A chain observer learns the jury or ballots from transaction metadata. | Every arg is a fresh-x25519 ciphertext. `cast` can be relayed by anyone. `BallotEvent` carries only the court. | Casting from the juror's own wallet shows the juror's activity and timing, so use a relayer. The authority's `add_juror` count is public, which reveals jury size. | P |
| T-20 | Info disclosure | The authority knows both the jury list and the holder list. | None in the MVP. | See L1. | A |
| T-21 | Elevation | A non-authority seats jurors, records positions, resolves or resets. | `add_juror`, `resolve` and `reset_pending` derive the court PDA from the signer. `record_positions` checks `payer == authority` + `has_one`. | — | M |
| T-22 | Elevation | A forged MPC callback writes an arbitrary state or verdict. | `verify_output(cluster, computation)`. Callback accounts are fixed at queue time. | Relies on Arcium. | M |
| T-23 | Tampering | A swapped circuit file at the release URL. | `circuit_hash!` pins SHA-256, and nodes reject mismatches. CI re-checks the published assets. | Replacing the file is still a liveness attack. | M |
| T-24 | Spoofing (web) | The RPC proxy's allowlist is bypassed by non-object batch entries (`null`, `0`, `""`). | `isObj` check on every entry. | — | M (d5202ee) |
| T-25 | DoS / abuse (web) | Other sites or scripts burn the Helius quota through `/api/rpc`. | `Origin` allowlist; 900 req/min per IP; batch ≤ 5; getProgramAccounts locked to Panta + filters. | Requests **without** an `Origin` header (scripts) are allowed. Counters are per serverless instance, not global. `sendTransaction` relays any devnet tx. | P (v3.1) |
| T-26 | DoS / abuse (web) | Faucet drained by concurrent or repeated requests. | Cooldown set before the first `await`; in-flight set; per-IP + per-address 10-minute cooldown; balance gate (< 0.12 SOL). | Per-instance memory; IP comes from `x-forwarded-for`. Devnet SOL only. | P (d5202ee, v3.1) |
| T-27 | Repudiation | Disputing what a callback did. | `VerdictEvent`, `BallotEvent`, `ComputationAbortedEvent`, `BetEvent` and `ClaimEvent` are emitted. The client links the queue tx and the successful callback tx. | `awaitStep` picks "the oldest successful signature after the queue tx", a heuristic that can show the wrong callback link (UI only). | A |

## Bribery and receipt-freeness

The goal is that a briber can't verify they got what they paid for.

1. **A ballot is authorized by the seat key, not by the wallet.** `cast_v3` accepts a ballot only if `(id, key)` matches a seat's current key. Juror ids are public-ish (`SHA-256(wallet)` prefix); the key exists only in the juror's device and, encrypted, in MXE state.
2. **Invalid ballots look the same as valid ones.** The program always queues, the callback always writes a fresh ciphertext and emits the same `BallotEvent`, and no success bit is ever revealed. Neither the briber nor anyone else can tell an accepted ballot from an ignored one.
3. **Key rotation defeats key-selling.** A juror casts the briber's YES (the "receipt"), then casts NO with `new_key = k1`, then hands over the old key `k0`. Anything the briber sends with `k0` is a silent no-op, and checking it is impossible by (2). This is MACI's key-change idea, with the MPC in place of MACI's coordinator, so no single party can decrypt the ballots.
4. **What the tally reveals.** Only aggregate `(yes, no, excluded, incomplete)`. A briber who paid *all* conflict-free jurors learns from the final tally how many defected, but not which ones.

Limits of this argument:

- **Race on a handed-over current key.** If a juror hands over a key that is still current, the briber can cast *and rotate* first, locking the juror out. Receipt-freeness holds when the juror rotates **before** handing over a key, and the briber can't tell whether that happened.
- **Briber-generated seat.** If the briber creates the seat ciphertext (chooses `key` itself) and the juror never learns it, the briber owns the seat outright. Preventing this needs registration the juror does personally (attested self-registration), not cryptography alone.
- **Chain metadata.** If the juror casts from their own wallet, the briber sees extra `cast` transactions from that wallet after the "receipt" and can infer a re-vote. Jurors should cast through a relayer, which is any payer.
- **The authority knows the jury** (L1). A corrupt authority can tell bribers exactly whom to pay. Unverifiability still holds against the authority, because it doesn't know keys that jurors encrypted themselves.
- **Not built: secret sortition.** See the README for why a post-vote random draw was rejected.

## Privacy leakage analysis

| Data | Public on chain | Known to authority | Known only inside MPC |
|---|---|---|---|
| Court exists, market text (≤ 64 B), authority pubkey | yes | yes | — |
| Number of `add_juror`, `record_positions` and `cast` calls, and their timing | yes | yes | — |
| Juror ids, seat keys | no (ciphertext) | ids yes; keys only if the authority encrypted them | yes |
| Holder ids | no (ciphertext) | yes (it reads them from the venue, which is public anyway) | yes |
| Individual ballots, which ballots were accepted | no | no | yes |
| Which jurors were excluded | **never revealed** | can compute it (knows both lists) | yes |
| `yes`, `no`, `excluded`, `incomplete` | yes, after resolve | yes | — |
| Bets: bettor pubkey, side, amount; pools | **yes** (`BetEvent`, `BetAccount`) | yes | — |
| Payouts | yes (`ClaimEvent`) | yes | — |

Inferences an observer can still make:

- `excluded` combined with public bets: if exactly one bettor is known and `excluded = 1`, that bettor *may* be the juror, but other holders can't be ruled out.
- The size of the jury (number of `add_juror` calls) and the size of the mirrored holder set (roughly 6 × the number of `record_positions` calls, padded with zeros).
- Holder positions on the venue are public anyway. What stays secret is **which juror** matches which holder.

## Known limitations (summary)

L1 the authority seats jurors and relays positions, so it knows both lists. · L2 mirroring of bettors and positions is not enforced on chain. · L3 32-bit ids and keys (T-1, T-2). · L4 wallet-level identity (T-3). · L5 positions opened after mirroring escape the filter. · L6 cast spam delays seating and mirroring (T-13). · L7 no quorum or deadline (T-17). · L8 bet account rent is never reclaimed. · L9 `excluded` leaks for tiny juries (T-18). · L10 `awaitStep` callback-signature heuristic (T-27). · L11 per-instance rate limits (T-25, T-26). Open questions for auditors: T-8, T-9.
