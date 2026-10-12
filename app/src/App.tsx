import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type AnchorHTMLAttributes } from "react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { BN } from "@anchor-lang/core";
import {
  DEFAULT_CHOICE,
  PROGRAM_ID,
  awaitStep,
  buildSteps,
  courtPda,
  explorerAddr,
  explorerMainnetAddr,
  explorerTx,
  fetchMxePublicKey,
  finalBallots,
  isMpc,
  loadBurner,
  loadScenario,
  makeClient,
  newComputationOffset,
  newCourtId,
  queueStep,
  pantaMarketUrl,
  readBet,
  readVerdict,
  type Choice,
  type Scenario,
  type ScriptStep,
  type Verdict,
} from "./court";

// three.js is heavy: load it after first paint so the page is usable immediately.
const Blob = lazy(() => import("./Blob"));

type Status = "waiting" | "sending" | "queued" | "finalized" | "failed";
interface StepState {
  status: Status;
  offset?: BN;
  queueSig?: string;
  finalizeSig?: string;
  error?: string;
}
type Bet = Awaited<ReturnType<typeof readBet>>;

const fresh = (script: ScriptStep[]): StepState[] => script.map(() => ({ status: "waiting" }));
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const sol = (lamports: number) => `${+(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
const word = (yes: number, no: number) => (yes > no ? "YES" : no > yes ? "NO" : "TIE");
const STATUS_LABEL: Record<Status, string> = {
  waiting: "Waiting",
  sending: "Sending",
  queued: "Computing in MPC",
  finalized: "Finalized",
  failed: "Failed",
};

const REPORT = "https://pugarhuda.github.io/saring/";
const REPO = "https://github.com/PugarHuda/saring";
const RUN_COST = 0.08; // SOL, plus the bet if any
const FAUCET_COOLDOWN_MS = 10 * 60_000; // matches app/api/faucet.js
const LAST_KEY = "saring.last.v1";

/** External link: always a new tab, no referrer. */
const Ext = (p: AnchorHTMLAttributes<HTMLAnchorElement>) => <a target="_blank" rel="noreferrer" {...p} />;

/** The last finished run, so a reload still shows its verdict and explorer links. */
interface Last {
  courtId: number;
  choice: Choice;
  verdict: Verdict;
  bet: Bet;
  steps: Pick<StepState, "status" | "queueSig" | "finalizeSig">[];
}
function loadLast(): Last | null {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? "null");
  } catch {
    return null;
  }
}
function saveLast(l: Last | null) {
  try {
    if (l) localStorage.setItem(LAST_KEY, JSON.stringify(l));
    else localStorage.removeItem(LAST_KEY);
  } catch {
    /* storage blocked: the result just won't survive a reload */
  }
}

/** Normal jury: every juror's latest ballot counts, no key check. Saring: counted ballots minus conflicted jurors. */
function tallies(sc: Scenario) {
  const latest = new Map<string, boolean>();
  for (const s of sc.steps) if (s.action.kind === "cast") latest.set(s.action.wallet, s.action.yes);
  const counted = finalBallots(sc.steps);
  const expected = { yes: 0, no: 0, excluded: 0 };
  for (const j of sc.jurors) {
    if (j.conflicted) expected.excluded++;
    else if (counted.has(j.wallet)) expected[counted.get(j.wallet) ? "yes" : "no"]++;
  }
  const normalYes = [...latest.values()].filter(Boolean).length;
  return { normal: { yes: normalYes, no: latest.size - normalYes }, expected };
}

/** Mirrors the program's claim(): ties, incomplete verdicts and empty winning pools refund. */
function payout(v: Verdict, b: NonNullable<Bet>) {
  const yesWins = v.yes > v.no;
  const winPool = yesWins ? b.yesPool : b.noPool;
  if (v.incomplete || v.yes === v.no || winPool === 0) return b.amount;
  return b.yes === yesWins ? Math.floor((b.amount * (b.yesPool + b.noPool)) / winPool) : 0;
}

// Every figure here is copied from the Conflict Report (docs/index.html).
const STATS = [
  { n: "60.4%", l: "of UMA voters control a Polymarket wallet", s: "3,742 of 6,197 voters", pos: "p-tl" },
  { n: "20.4%", l: "of disputes had a voter holding a position", s: "834 of 4,093 disputes", pos: "p-tr" },
  { n: "65.7%", l: "of disputes in ≥ $1M markets had one", s: "423 of 644 disputes", pos: "p-bl" },
  { n: "0", l: "outcomes shown to be flipped", s: "The gap: nothing filters these voters", pos: "p-br" },
];

export default function App() {
  const burner = useMemo(loadBurner, []);
  const client = useMemo(() => makeClient(burner), [burner]);
  const last = useMemo(loadLast, []);

  const [balance, setBalance] = useState<number | null>(null);
  const [programLive, setProgramLive] = useState<boolean | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [scenarioErr, setScenarioErr] = useState("");
  const [choice, setChoice] = useState<Choice>(last?.choice ?? DEFAULT_CHOICE);
  const choiceRef = useRef(choice);
  const [steps, setSteps] = useState<StepState[]>([]);
  const stepsRef = useRef(steps);
  const [courtId, setCourtId] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [bet, setBet] = useState<Bet>(null);
  const [notice, setNotice] = useState("");
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [godView, setGodView] = useState(false);
  const verdictRef = useRef<HTMLElement>(null);

  const setStepStates = (s: StepState[]) => {
    stepsRef.current = s;
    setSteps(s);
  };
  const patch = (i: number, p: Partial<StepState>) => setStepStates(stepsRef.current.map((s, j) => (j === i ? { ...s, ...p } : s)));

  const refreshBalance = useCallback(async () => {
    try {
      setBalance((await client.connection.getBalance(burner.publicKey)) / LAMPORTS_PER_SOL);
    } catch {
      setBalance(null);
    }
  }, [client, burner]);

  const SCRIPT = scenario?.steps ?? [];

  const loadCase = useCallback(() => {
    setScenarioErr("");
    loadScenario(burner.publicKey, choiceRef.current)
      .then((sc) => {
        // Restore the last finished run if it matches this script.
        if (last && last.steps.length === sc.steps.length) {
          setStepStates(last.steps.map((s) => ({ ...s })));
          setCourtId(last.courtId);
          setVerdict(last.verdict);
          setBet(last.bet);
        } else setStepStates(fresh(sc.steps));
        setScenario(sc);
      })
      .catch((e) => setScenarioErr(e instanceof Error ? e.message : String(e)));
  }, [burner, last]);
  useEffect(loadCase, [loadCase]);

  useEffect(() => {
    refreshBalance();
    client.connection
      .getAccountInfo(PROGRAM_ID)
      .then((a) => setProgramLive(!!a?.executable))
      .catch(() => setProgramLive(null));
  }, [client, refreshBalance]);

  // Leaving mid-run abandons a half-built court.
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  const started = steps.some((s) => s.status !== "waiting");

  function choose(c: Choice) {
    if (!scenario || running || started) return;
    choiceRef.current = c;
    setChoice(c);
    const sc = { ...scenario };
    sc.steps = buildSteps(sc, c);
    setStepStates(fresh(sc.steps));
    setScenario(sc);
  }

  // Our own devnet faucet (app/api/faucet.js): enough SOL for one run.
  async function airdrop() {
    setFaucetBusy(true);
    setNotice("Requesting devnet SOL…");
    try {
      const r = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: burner.publicKey.toBase58() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setNotice(`Received ${j.sol ?? 0.12} devnet SOL. You can run the dispute.`);
    } catch (e) {
      setNotice(`The faucet said: ${(e as Error).message}. You can also use faucet.solana.com with the address above.`);
    }
    // The server rate-limits for 10 minutes either way; don't let the button invite retries.
    setTimeout(() => setFaucetBusy(false), FAUCET_COOLDOWN_MS);
    refreshBalance();
  }

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(burner.publicKey.toBase58());
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setNotice("Copy failed. Select the address and copy it manually.");
    }
  }

  async function run() {
    setRunning(true);
    setNotice("");
    const id = courtId ?? newCourtId();
    setCourtId(id);
    try {
      const mxePub = await fetchMxePublicKey(client);
      for (let i = 0; i < SCRIPT.length; i++) {
        const s = stepsRef.current[i];
        if (s.status === "finalized") continue;
        const action = SCRIPT[i].action;
        if (!isMpc(action)) {
          // Plain transaction: confirmed when queueStep returns, no callback.
          patch(i, { status: "sending", error: undefined });
          patch(i, { status: "finalized", queueSig: await queueStep(client, id, mxePub, action, newComputationOffset()) });
          continue;
        }
        let offset = s.offset;
        // A step whose queue tx landed is only re-awaited, never re-sent (re-seating a juror would double-count).
        if (!s.queueSig || !offset) {
          offset = newComputationOffset();
          patch(i, { status: "sending", offset, error: undefined });
          patch(i, { queueSig: await queueStep(client, id, mxePub, action, offset) });
        }
        patch(i, { status: "queued", error: undefined });
        patch(i, { status: "finalized", finalizeSig: await awaitStep(client, offset) });
      }
      const v = await readVerdict(client, id);
      const b = choiceRef.current.bet !== null ? await readBet(client, id) : null;
      setVerdict(v);
      setBet(b);
      saveLast({
        courtId: id,
        choice: choiceRef.current,
        verdict: v,
        bet: b,
        steps: stepsRef.current.map(({ status, queueSig, finalizeSig }) => ({ status, queueSig, finalizeSig })),
      });
      // On a narrow screen the verdict sits far above the timeline.
      if (window.matchMedia("(max-width: 1020px)").matches) verdictRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (e) {
      const i = stepsRef.current.findIndex((s) => s.status === "sending" || s.status === "queued");
      const msg = e instanceof Error ? e.message : String(e);
      if (i >= 0) patch(i, { status: "failed", error: msg });
      else setNotice(msg);
    } finally {
      setRunning(false);
      refreshBalance();
    }
  }

  function reset() {
    if (scenario) {
      const sc = { ...scenario };
      sc.steps = buildSteps(sc, choiceRef.current); // fresh secret keys for the new court
      setScenario(sc);
      setStepStates(fresh(sc.steps));
    }
    setCourtId(null);
    setVerdict(null);
    setBet(null);
    setNotice("");
    saveLast(null);
  }

  const done = steps.filter((s) => s.status === "finalized").length;
  const failed = steps.some((s) => s.status === "failed");
  const current = steps.findIndex((s) => s.status === "sending" || s.status === "queued");
  const need = RUN_COST + (choice.bet !== null ? 0.01 : 0);
  const lowFunds = balance !== null && balance < need && done < SCRIPT.length;
  const t = scenario ? tallies(scenario) : null;
  const conflicted = scenario?.jurors.filter((j) => j.conflicted).length ?? 0;
  const resolved = !!verdict?.resolved;
  const shown = resolved ? verdict! : t?.expected;
  const outcome = resolved ? (verdict!.incomplete ? "VOID" : word(verdict!.yes, verdict!.no)) : null;

  return (
    <div className="frame">
      <a className="skip" href="#run">
        Skip to the live demo
      </a>
      <header className="nav">
        <a className="brand" href="#top">
          <span className="mark" aria-hidden="true" />
          Saring
        </a>
        <nav aria-label="Sections" className="links">
          <a href="#case">The case</a>
          <a href="#run">Live demo</a>
          <a href="#privacy">Privacy</a>
          <Ext href={REPORT}>Conflict Report</Ext>
        </nav>
        <div className="nav-cta">
          <Ext className="pill ghost" href={REPO}>
            GitHub
          </Ext>
          <a className="pill" href="#run">
            Run on devnet
          </a>
        </div>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="hero-h">
          <div className="hero-copy">
            <p className="status-chip">
              <span className={`led ${programLive ? "on" : programLive === false ? "off" : ""}`} aria-hidden="true" />
              {programLive === null
                ? "Checking the devnet program…"
                : programLive
                  ? `Program ${short(PROGRAM_ID.toBase58())} is live on devnet`
                  : "Program not found on devnet"}
            </p>
            <h1 id="hero-h">Disputes decided by people with no stake in the outcome</h1>
            <p className="lede">
              Saring checks every juror against every market position inside Arcium MPC, drops the conflicted ones,
              and publishes only the tally. The chain never learns who was dropped.
            </p>
            <div className="cta-row">
              <a className="pill big" href="#run">
                Run a dispute on devnet
              </a>
              <Ext className="pill ghost big" href={REPORT}>
                Read the Conflict Report
              </Ext>
            </div>
          </div>

          <div className="stage">
            <div className="orb" aria-hidden="true" />
            <Suspense fallback={null}>
              <Blob />
            </Suspense>
            <ul className="stats" aria-label="From the Conflict Report on UMA votes in Polymarket disputes">
              {STATS.map((s) => (
                <li key={s.pos} className={`glass stat ${s.pos}`}>
                  <span className="n">{s.n}</span>
                  <span className="l">{s.l}</span>
                  <span className="s">{s.s}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="case" className="block" aria-labelledby="case-h">
          <div className="block-head">
            <h2 id="case-h">
              {scenario
                ? `One real market, ${scenario.jurors.length} jurors, ${conflicted} of them hold a position`
                : "One real market, one jury"}
            </h2>
            {scenario ? (
              <p>
                The disputed Panta market asks{" "}
                <Ext href={pantaMarketUrl(scenario.market)}>
                  <strong>“{scenario.question}”</strong>
                </Ext>{" "}
                {scenario.holderCount} wallets have a position in it ({scenario.openHolderCount} still open), read from
                Solana mainnet via Panta’s program. Five jurors are real Panta traders whose ballots are scripted, since
                we don’t hold their keys. The sixth is you. On chain every juror id, position and ballot is a ciphertext.
              </p>
            ) : (
              <p role="status">
                {scenarioErr ? (
                  <>
                    Could not read the Panta market from Solana mainnet
                    {/(403|429)/.test(scenarioErr)
                      ? ". The mainnet RPC is busy right now; try again in a moment."
                      : `: ${scenarioErr.slice(0, 160)}`}{" "}
                    <button type="button" className="pill ghost sm" onClick={loadCase}>
                      Try again
                    </button>
                  </>
                ) : (
                  "Reading the disputed Panta market and its holders from Solana mainnet…"
                )}
              </p>
            )}
          </div>

          <div className="case-grid">
            <div className="glass roster">
              <div className="god">
                <button
                  type="button"
                  className={`switch ${godView ? "on" : ""}`}
                  aria-pressed={godView}
                  onClick={() => setGodView((v) => !v)}
                  disabled={!scenario}
                >
                  <span className="knob" aria-hidden="true" />
                  God view
                </button>
                <span className="fine">
                  {godView
                    ? "Showing who holds this market. The chain never sees this; only MPC compares the lists."
                    : "Reveal who holds this market. The chain never sees it."}
                </span>
              </div>
              <table>
                <caption className="sr-only">Jurors, whether they hold a position, and their final counted ballots</caption>
                <thead>
                  <tr>
                    <th scope="col">Juror wallet</th>
                    <th scope="col">Conflict</th>
                    <th scope="col">Counted ballot</th>
                  </tr>
                </thead>
                <tbody>
                  {scenario
                    ? scenario.jurors.map((j) => {
                        const casts = SCRIPT.flatMap((s) => (s.action.kind === "cast" && s.action.wallet === j.wallet ? [s.action] : []));
                        const counted = casts.filter((c) => c.counts);
                        const final = counted[counted.length - 1];
                        const ignored = casts.length - counted.length;
                        return (
                          <tr key={j.wallet} className={j.you ? "you" : undefined}>
                            <td>
                              <Ext href={explorerMainnetAddr(j.wallet)}>{j.you ? `You · ${short(j.wallet)}` : short(j.wallet)}</Ext>
                            </td>
                            <td>
                              {godView ? (
                                <span className={`tag ${j.conflicted ? "conflicted" : "clean"}`}>
                                  {j.conflicted ? (j.you ? "Conflicted: you bet" : "Conflicted") : "Clean"}
                                </span>
                              ) : (
                                <span className="tag sealed">Encrypted</span>
                              )}
                            </td>
                            <td>
                              {final === undefined ? "None" : final.yes ? "YES" : "NO"}
                              {counted.length > 1 && counted[0].yes !== final?.yes && (
                                <span className="muted">after a bribed {counted[0].yes ? "YES" : "NO"}, silently overwritten</span>
                              )}
                              {ignored > 0 && (
                                <span className="muted">
                                  {ignored === 1 ? "a ballot" : `${ignored} ballots`} with a wrong key ignored inside MPC
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    : [0, 1, 2, 3, 4, 5].map((i) => (
                        <tr key={i} className="skeleton" aria-hidden="true">
                          <td>········</td>
                          <td>···</td>
                          <td>···</td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>

            <div className="versus">
              <article className="glass verdict">
                <h3>A normal jury</h3>
                {t ? (
                  <>
                    <p className={`word ${t.normal.yes > t.normal.no ? "bad" : "ok"}`}>{word(t.normal.yes, t.normal.no)}</p>
                    <p className="score">
                      {t.normal.yes} – {t.normal.no}
                    </p>
                    <p className="fine">
                      Every juror’s latest ballot counts and nothing checks keys: the conflicted votes, the briber’s
                      re-sent YES and the forged YES all land, and the briber can verify the ballot they paid for.
                    </p>
                  </>
                ) : (
                  <p className="word pending">?</p>
                )}
              </article>
              <article ref={verdictRef} className={`glass verdict blind ${resolved ? "resolved" : ""}`} aria-live="polite">
                <h3>Saring{resolved ? "" : " · Expected"}</h3>
                {shown ? (
                  <>
                    <p className={`word ${resolved ? (outcome === "NO" ? "ok" : "bad") : "pending"}`}>
                      {outcome ?? word(shown.yes, shown.no)}
                    </p>
                    <p className="score">
                      {shown.yes} – {shown.no}
                    </p>
                    <dl className="tally">
                      <div>
                        <dt>Yes</dt>
                        <dd>{shown.yes}</dd>
                      </div>
                      <div>
                        <dt>No</dt>
                        <dd>{shown.no}</dd>
                      </div>
                      <div>
                        <dt>Excluded</dt>
                        <dd>{shown.excluded}</dd>
                      </div>
                      <div>
                        <dt>Incomplete</dt>
                        <dd>{resolved && verdict!.incomplete ? "Yes" : "No"}</dd>
                      </div>
                    </dl>
                    {resolved && verdict!.incomplete && <p className="bad">Incomplete: market refunds.</p>}
                    {resolved && bet && (
                      <p className="payout">
                        You bet {sol(bet.amount)} on {bet.yes ? "YES" : "NO"}. Pools: YES {sol(bet.yesPool)}, NO{" "}
                        {sol(bet.noPool)}. Payout {sol(payout(verdict!, bet))}
                        {bet.claimed ? ", claimed." : ", not claimed yet."}
                      </p>
                    )}
                    <p className="fine">
                      {resolved
                        ? `Read from the court account on devnet. ${verdict!.excluded} jurors were excluded; their identities were never revealed.`
                        : "Expected from the script: conflicted jurors (and you, if you bet) are dropped, wrong-key ballots ignored. Run the dispute to read the real tally from chain."}
                    </p>
                    {resolved && courtId !== null && (
                      <Ext className="fine" href={explorerAddr(courtPda(burner.publicKey, courtId).toBase58())}>
                        Court account on Explorer
                      </Ext>
                    )}
                  </>
                ) : (
                  <p className="word pending">?</p>
                )}
              </article>
            </div>
          </div>
        </section>

        <section id="run" className="block" aria-labelledby="run-h">
          <div className="block-head">
            <h2 id="run-h">Run the dispute on devnet</h2>
            <p>
              {scenario ? `${SCRIPT.length} steps, about 2–4 minutes. ` : "About 2–4 minutes. "}MPC steps queue an Arcium
              computation and wait for its signed callback; market steps are plain devnet transactions.
            </p>
          </div>

          <div className="run-grid">
            <div className="side">
              <fieldset className="glass seat" disabled={!scenario || running || started}>
                <legend className="sr-only">Your seat</legend>
                <h3>Your seat: juror #6</h3>
                <div className="field">
                  <span className="field-label" id="vote-l">
                    Your vote
                  </span>
                  <div className="seg" role="radiogroup" aria-labelledby="vote-l">
                    {[true, false].map((v) => (
                      <label key={String(v)}>
                        <input type="radio" name="vote" checked={choice.vote === v} onChange={() => choose({ ...choice, vote: v })} />
                        <span>{v ? "YES" : "NO"}</span>
                      </label>
                    ))}
                  </div>
                  <p className="fine">Encrypted in this browser and seated with your own secret key.</p>
                </div>
                <div className="field">
                  <span className="field-label" id="bet-l">
                    Also bet 0.01 SOL on this market
                  </span>
                  <div className="seg" role="radiogroup" aria-labelledby="bet-l">
                    {([null, true, false] as const).map((b) => (
                      <label key={String(b)}>
                        <input type="radio" name="bet" checked={choice.bet === b} onChange={() => choose({ ...choice, bet: b })} />
                        <span>{b === null ? "Don’t bet" : b ? "YES" : "NO"}</span>
                      </label>
                    ))}
                  </div>
                  <p className="fine">If you bet, you hold a position, so MPC silently drops your ballot (excluded goes up by one).</p>
                </div>
                {t && (
                  <p className="fine">
                    Expected Saring tally: <strong>{t.expected.yes} – {t.expected.no}</strong>, {t.expected.excluded} excluded.
                  </p>
                )}
                {started && !running && <p className="fine">Locked for this court. Start a new court to change it.</p>}
              </fieldset>

              <aside className="glass wallet" aria-label="Burner wallet">
                <h3>Burner wallet</h3>
                <p className="fine">
                  Stored in this browser. Get devnet SOL gives this wallet 0.12 SOL, enough for one run (~0.08 SOL).
                </p>
                <code className="addr">{burner.publicKey.toBase58()}</code>
                <p className="balance">
                  <span className="fine">Balance</span>
                  <strong>{balance === null ? "…" : `${balance.toFixed(3)} SOL`}</strong>
                </p>
                <div className="btn-row">
                  <button type="button" className="pill ghost sm" onClick={refreshBalance}>
                    Refresh
                  </button>
                  <button type="button" className="pill ghost sm" onClick={copyAddress}>
                    {copied ? "Copied" : "Copy address"}
                  </button>
                  <button type="button" className="pill ghost sm" onClick={airdrop} disabled={faucetBusy}>
                    Get devnet SOL
                  </button>
                </div>
                <Ext className="fine" href="https://faucet.solana.com">
                  Or use faucet.solana.com
                </Ext>

                <div className="run-actions">
                  <button type="button" className="pill big" onClick={run} disabled={!scenario || running || done === SCRIPT.length || lowFunds}>
                    {!scenario
                      ? "Loading the case…"
                      : running
                        ? `Running ${done}/${SCRIPT.length}`
                        : failed
                          ? "Retry from the failed step"
                          : done === SCRIPT.length
                            ? "Dispute resolved"
                            : done
                              ? "Continue"
                              : "Run the dispute"}
                  </button>
                  {!running && started && (
                    <button type="button" className="pill ghost" onClick={reset}>
                      Start a new court
                    </button>
                  )}
                </div>
                {lowFunds && <p className="fine bad">Balance is under {need.toFixed(2)} SOL. Fund the wallet first.</p>}
                {courtId !== null && (
                  <Ext className="fine" href={explorerAddr(courtPda(burner.publicKey, courtId).toBase58())}>
                    Court account on Explorer
                  </Ext>
                )}
                {notice && (
                  <p className="notice" role="status">
                    {notice}
                  </p>
                )}
                <div
                  className="meter"
                  role="progressbar"
                  aria-label="Steps finalized"
                  aria-valuemin={0}
                  aria-valuemax={SCRIPT.length}
                  aria-valuenow={done}
                >
                  <div style={{ width: `${SCRIPT.length ? (done / SCRIPT.length) * 100 : 0}%` }} />
                </div>
              </aside>
            </div>

            <div className="timeline-wrap">
              <p className="sr-only" aria-live="polite">
                {current >= 0 ? `${SCRIPT[current].title}: ${STATUS_LABEL[steps[current].status]}` : ""}
              </p>
              {!scenario && <p className="glass tl-card fine">The steps appear once the Panta market is read from mainnet.</p>}
              <ol className="timeline">
                {SCRIPT.map((s, i) => {
                  const st = steps[i];
                  const mpc = isMpc(s.action);
                  const a = s.action;
                  const key = a.kind === "cast" ? (!a.counts ? "Ignored inside MPC" : a.newKey ? "Key rotated inside MPC" : null) : null;
                  return (
                    <li key={i} className={`tl ${st.status}`}>
                      <span className="node" aria-hidden="true">
                        {i + 1}
                      </span>
                      <div className="glass tl-card">
                        <div className="tl-top">
                          <span className="tl-title">{s.title}</span>
                          <span className="badge">{mpc || st.status !== "finalized" ? STATUS_LABEL[st.status] : "Confirmed"}</span>
                        </div>
                        <p className="tl-note">{s.note}</p>
                        <p className="tl-tags">
                          <span className={`kind ${mpc ? "mpc" : "tx"}`}>{mpc ? "MPC" : "Transaction"}</span>
                          {key && <span className="kind key">{key}</span>}
                        </p>
                        {(st.queueSig || st.finalizeSig) && (
                          <p className="tl-links">
                            {st.queueSig && (
                              <Ext href={explorerTx(st.queueSig)}>
                                {mpc ? "Queue tx" : "Transaction"} {short(st.queueSig)}
                              </Ext>
                            )}
                            {st.finalizeSig && <Ext href={explorerTx(st.finalizeSig)}>MPC callback {short(st.finalizeSig)}</Ext>}
                          </p>
                        )}
                        {st.error && <p className="tl-error">{st.error}</p>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>
        </section>

        <section id="privacy" className="block" aria-labelledby="privacy-h">
          <div className="block-head">
            <h2 id="privacy-h">What stays hidden, what gets published</h2>
            <p>
              The conflict check needs the jury list and the holder list together, and must leak neither. Publishing the
              jury tells bribers whom to pay; publishing holders exposes traders. So both stay encrypted in one MXE state
              and the check runs inside multi-party computation.
            </p>
          </div>
          <div className="versus">
            <article className="glass reveal">
              <h3>Hidden, ciphertext on chain</h3>
              <ul>
                <li>Which juror ids sit on the jury</li>
                <li>Which traders hold a position</li>
                <li>Each juror’s ballot and secret key, and whether the ballot was overwritten</li>
                <li>Which jurors were excluded as conflicted</li>
              </ul>
            </article>
            <article className="glass reveal open">
              <h3>Published</h3>
              <ul>
                <li>
                  The tally: <code>yes</code>, <code>no</code>, <code>excluded</code> and an <code>incomplete</code> flag
                </li>
                <li>That each step ran, through Arcium-signed callbacks</li>
                <li>Bets in the court’s market, which settles on the tally</li>
              </ul>
              <p className="fine">
                A ballot only counts with the seat’s current secret key, and a juror can rotate it silently, so a key
                handed to a briber is worthless.
              </p>
            </article>
          </div>
          <p className="fine limits">
            MVP limits: the court authority seats jurors and relays positions, so it knows both lists; ids and keys are
            32-bit; a second wallet evades the filter.
          </p>
        </section>
      </main>

      <footer className="foot">
        <div className="foot-links">
          <Ext href={REPORT}>Conflict Report: how often UMA voters judged markets they traded</Ext>
          <Ext href={REPO}>Source on GitHub</Ext>
        </div>
        <p className="powered">
          <span>Powered by</span>
          <strong>Arcium</strong>
          <strong>Solana</strong>
          <strong>Panta</strong>
        </p>
        <p className="fine">Devnet demo. Not audited. No real funds.</p>
      </footer>
    </div>
  );
}
