import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { BN } from "@anchor-lang/core";
import {
  PROGRAM_ID,
  awaitStep,
  courtPda,
  explorerAddr,
  explorerMainnetAddr,
  explorerTx,
  fetchMxePublicKey,
  loadBurner,
  loadScenario,
  makeClient,
  newComputationOffset,
  newCourtId,
  queueStep,
  pantaMarketUrl,
  readVerdict,
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

const fresh = (script: ScriptStep[]): StepState[] => script.map(() => ({ status: "waiting" }));
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const STATUS_LABEL: Record<Status, string> = {
  waiting: "Waiting",
  sending: "Sending",
  queued: "Computing in MPC",
  finalized: "Finalized",
  failed: "Failed",
};

const REPORT = "https://pugarhuda.github.io/blindcourt/";
const REPO = "https://github.com/PugarHuda/blindcourt";

/** Each juror's ballots in order, derived from the scripted casts (nothing hardcoded). */
function ballots(sc: Scenario) {
  const by = new Map<string, boolean[]>();
  for (const st of sc.steps) if (st.action.kind === "cast") by.set(st.action.wallet, [...(by.get(st.action.wallet) ?? []), st.action.yes]);
  return by;
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

  const [balance, setBalance] = useState<number | null>(null);
  const [programLive, setProgramLive] = useState<boolean | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [scenarioErr, setScenarioErr] = useState("");
  const [steps, setSteps] = useState<StepState[]>([]);
  const stepsRef = useRef(steps);
  const [courtId, setCourtId] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [godView, setGodView] = useState(false);

  const patch = (i: number, p: Partial<StepState>) => {
    stepsRef.current = stepsRef.current.map((s, j) => (j === i ? { ...s, ...p } : s));
    setSteps(stepsRef.current);
  };

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
    loadScenario()
      .then((sc) => {
        stepsRef.current = fresh(sc.steps);
        setSteps(stepsRef.current);
        setScenario(sc);
      })
      .catch((e) => setScenarioErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(loadCase, [loadCase]);

  useEffect(() => {
    refreshBalance();
    client.connection
      .getAccountInfo(PROGRAM_ID)
      .then((a) => setProgramLive(!!a?.executable))
      .catch(() => setProgramLive(null));
  }, [client, refreshBalance]);

  async function airdrop() {
    setNotice("Requesting 1 devnet SOL…");
    try {
      const sig = await client.connection.requestAirdrop(burner.publicKey, LAMPORTS_PER_SOL);
      await client.connection.confirmTransaction(sig, "confirmed");
      setNotice("Airdrop received.");
    } catch {
      setNotice("The devnet faucet refused (it is often rate-limited). Use faucet.solana.com with the address above.");
    }
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
        let offset = s.offset;
        // A step whose queue tx landed is only re-awaited, never re-sent (re-seating a juror would double-count).
        if (!s.queueSig || !offset) {
          offset = newComputationOffset();
          patch(i, { status: "sending", offset, error: undefined });
          const queueSig = await queueStep(client, id, mxePub, SCRIPT[i].action, offset);
          patch(i, { queueSig });
        }
        patch(i, { status: "queued", error: undefined });
        const finalizeSig = await awaitStep(client, offset);
        patch(i, { status: "finalized", finalizeSig });
      }
      setVerdict(await readVerdict(client, id));
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
    stepsRef.current = fresh(SCRIPT);
    setSteps(stepsRef.current);
    setCourtId(null);
    setVerdict(null);
    setNotice("");
  }

  const done = steps.filter((s) => s.status === "finalized").length;
  const failed = steps.some((s) => s.status === "failed");
  const current = steps.findIndex((s) => s.status === "sending" || s.status === "queued");
  const lowFunds = balance !== null && balance < 0.1;
  const votes = scenario ? ballots(scenario) : new Map<string, boolean[]>();
  const finalYes = [...votes.values()].filter((b) => b[b.length - 1]).length;
  const bribedYes = [...votes.values()].filter((b) => b[0]).length; // if every first ballot (the bribe receipt) held
  const conflicted = scenario?.jurors.filter((j) => j.conflicted).length ?? 0;
  const outcome = verdict?.resolved ? (verdict.yes > verdict.no ? "YES" : verdict.no > verdict.yes ? "NO" : "TIE") : null;

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
          <a href={REPORT}>Conflict Report</a>
        </nav>
        <div className="nav-cta">
          <a className="pill ghost" href={REPO}>
            GitHub
          </a>
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
              and publishes only the tally. Nobody, not even the court, learns who was dropped.
            </p>
            <div className="cta-row">
              <a className="pill big" href="#run">
                Run a dispute on devnet
              </a>
              <a className="pill ghost big" href={REPORT}>
                Read the Conflict Report
              </a>
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
                <a href={pantaMarketUrl(scenario.market)} target="_blank" rel="noreferrer">
                  <strong>“{scenario.question}”</strong>
                </a>{" "}
                {scenario.holderCount} wallets hold a position (read from Solana mainnet via Panta’s program). The jurors
                below are real Panta traders; their ballots are scripted, since we don’t hold their keys. On chain every
                juror id, position and ballot is a ciphertext.
              </p>
            ) : (
              <p role="status">
                {scenarioErr ? (
                  <>
                    Could not read the Panta market from Solana mainnet
                    {/(403|429)/.test(scenarioErr)
                      ? ". The public RPC refused the request; set VITE_MAINNET_RPC_URL to a dedicated mainnet RPC."
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
                <caption className="sr-only">Jurors, whether they hold a position, and their final ballots</caption>
                <thead>
                  <tr>
                    <th scope="col">Juror wallet</th>
                    <th scope="col">Conflict</th>
                    <th scope="col">Final ballot</th>
                  </tr>
                </thead>
                <tbody>
                  {scenario
                    ? scenario.jurors.map((j) => {
                        const b = votes.get(j.wallet) ?? [];
                        const last = b[b.length - 1];
                        return (
                          <tr key={j.wallet}>
                            <td>
                              <a href={explorerMainnetAddr(j.wallet)} target="_blank" rel="noreferrer">
                                {short(j.wallet)}
                              </a>
                            </td>
                            <td>
                              {godView ? (
                                <span className={`tag ${j.conflicted ? "conflicted" : "clean"}`}>
                                  {j.conflicted ? "Conflicted" : "Clean"}
                                </span>
                              ) : (
                                <span className="tag sealed">Encrypted</span>
                              )}
                            </td>
                            <td>
                              {last === undefined ? "None" : last ? "YES" : "NO"}
                              {b.length > 1 && b[0] !== last && (
                                <span className="muted">after a bribed {b[0] ? "YES" : "NO"}, silently overwritten</span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    : [0, 1, 2, 3, 4].map((i) => (
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
                {scenario ? (
                  <>
                    <p className={`word ${finalYes * 2 > votes.size ? "bad" : "ok"}`}>
                      {finalYes * 2 > votes.size ? "YES" : finalYes * 2 < votes.size ? "NO" : "TIE"}
                    </p>
                    <p className="score">
                      {finalYes} – {votes.size - finalYes}
                    </p>
                    <p className="fine">
                      Conflicted votes count. If the bribe holds it is {bribedYes} – {votes.size - bribedYes}, and the
                      briber can check, because ballots are public.
                    </p>
                  </>
                ) : (
                  <p className="word pending">?</p>
                )}
              </article>
              <article className={`glass verdict blind ${outcome ? "resolved" : ""}`} aria-live="polite">
                <h3>Saring</h3>
                {verdict?.resolved ? (
                  <>
                    <p className={`word ${outcome === "NO" ? "ok" : "bad"}`}>{outcome}</p>
                    <p className="score">
                      {verdict.yes} – {verdict.no}
                    </p>
                    <dl className="tally">
                      <div>
                        <dt>Yes</dt>
                        <dd>{verdict.yes}</dd>
                      </div>
                      <div>
                        <dt>No</dt>
                        <dd>{verdict.no}</dd>
                      </div>
                      <div>
                        <dt>Excluded</dt>
                        <dd>{verdict.excluded}</dd>
                      </div>
                    </dl>
                    <p className="fine">
                      Read from the court account on devnet. {verdict.excluded} jurors were excluded; their identities
                      were never revealed.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="word pending">?</p>
                    <p className="fine">
                      Not run yet. Run the dispute below; the tally is read from the court account once the MPC resolve
                      finalizes.
                    </p>
                  </>
                )}
              </article>
            </div>
          </div>
        </section>

        <section id="run" className="block" aria-labelledby="run-h">
          <div className="block-head">
            <h2 id="run-h">Run the dispute on devnet</h2>
            <p>
              {scenario ? `${SCRIPT.length} steps. ` : ""}Each step is a real devnet transaction that queues an Arcium MPC computation and waits
              for its signed callback.
            </p>
          </div>

          <div className="run-grid">
            <aside className="glass wallet" aria-label="Burner wallet">
              <h3>Burner wallet</h3>
              <p className="fine">Stored in this browser. Fund it with about 0.5 devnet SOL.</p>
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
                <button type="button" className="pill ghost sm" onClick={airdrop}>
                  Airdrop 1 SOL
                </button>
              </div>
              <a className="fine" href="https://faucet.solana.com" target="_blank" rel="noreferrer">
                Or use faucet.solana.com
              </a>

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
                {!running && done > 0 && (
                  <button type="button" className="pill ghost" onClick={reset}>
                    Start a new court
                  </button>
                )}
              </div>
              {lowFunds && <p className="fine bad">Balance is under 0.1 SOL. Fund the wallet first.</p>}
              {courtId !== null && (
                <a className="fine" href={explorerAddr(courtPda(burner.publicKey, courtId).toBase58())} target="_blank" rel="noreferrer">
                  Court account on Explorer
                </a>
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

            <div className="timeline-wrap">
              <p className="sr-only" aria-live="polite">
                {current >= 0 ? `${SCRIPT[current].title}: ${STATUS_LABEL[steps[current].status]}` : ""}
              </p>
              {!scenario && <p className="glass tl-card fine">The steps appear once the Panta market is read from mainnet.</p>}
              <ol className="timeline">
                {SCRIPT.map((s, i) => {
                  const st = steps[i];
                  return (
                    <li key={i} className={`tl ${st.status}`}>
                      <span className="node" aria-hidden="true">
                        {i + 1}
                      </span>
                      <div className="glass tl-card">
                        <div className="tl-top">
                          <span className="tl-title">{s.title}</span>
                          <span className="badge">{STATUS_LABEL[st.status]}</span>
                        </div>
                        <p className="tl-note">{s.note}</p>
                        {(st.queueSig || st.finalizeSig) && (
                          <p className="tl-links">
                            {st.queueSig && (
                              <a href={explorerTx(st.queueSig)} target="_blank" rel="noreferrer">
                                Queue tx {short(st.queueSig)}
                              </a>
                            )}
                            {st.finalizeSig && (
                              <a href={explorerTx(st.finalizeSig)} target="_blank" rel="noreferrer">
                                MPC callback {short(st.finalizeSig)}
                              </a>
                            )}
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
                <li>Each juror’s ballot, and whether it was overwritten</li>
                <li>Which jurors were excluded as conflicted</li>
              </ul>
            </article>
            <article className="glass reveal open">
              <h3>Published</h3>
              <ul>
                <li>
                  Three numbers: <code>yes</code>, <code>no</code>, <code>excluded</code>
                </li>
                <li>That each step ran, through Arcium-signed callbacks</li>
              </ul>
              <p className="fine">
                Any relayer can overwrite a ballot, so a bribed juror can show a YES receipt and quietly change it.
              </p>
            </article>
          </div>
          <p className="fine limits">
            MVP limits: the court authority seats jurors, ids are small integers, and a second wallet evades the filter.
            The README has the roadmap.
          </p>
        </section>
      </main>

      <footer className="foot">
        <div className="foot-links">
          <a href={REPORT}>Conflict Report: how often UMA voters judged markets they traded</a>
          <a href={REPO}>Source on GitHub</a>
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
