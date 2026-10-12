import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type AnchorHTMLAttributes } from "react";
import { LAMPORTS_PER_SOL, type PublicKey } from "@solana/web3.js";
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
  listDisputableMarkets,
  loadBurner,
  loadScenario,
  makeClient,
  MAX_HOLDERS,
  newComputationOffset,
  newCourtId,
  PANTA_MARKET,
  queueStep,
  pantaMarketUrl,
  readBet,
  readVerdict,
  type Choice,
  type MarketOption,
  type Scenario,
  type ScriptStep,
  type Verdict,
} from "./court";
import { marketDetail, walletPositions } from "./pantaApi";
import Multichain from "./Multichain";
import { PANTA_PROGRAM_ID, buildPantaSettle, simulatePantaSettle, verdictToYesWins, type PantaSettle, type SimResult } from "./pantaSettle";

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

// Panta's API returns some numbers as strings ("31.00"); null/"" means not reported.
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const usdc = (v: unknown) => (num(v) === null ? "n/a" : `$${num(v)!.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
const cents = (v: unknown) => `${Math.round(num(v)! * 100)}¢`;
const PANTA = "https://panta.market";
// ponytail: a stalled proxy request would leave a loading line forever; give up after 60 s so "Try again" shows.
const withTimeout = <T,>(p: Promise<T>, ms = 60_000) =>
  Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error("timed out, the RPC is busy")), ms))]);

const REPORT = "https://pugarhuda.github.io/saring/";
const REPO = "https://github.com/PugarHuda/saring";
const RUN_COST = 0.1; // SOL; a bet adds 0.01 (the run itself is ~0.105 with one)
const FAUCET_SOL = 0.15; // matches GRANT in app/api/faucet.js
const FAUCET_ENOUGH = 0.12; // the faucet refuses wallets holding this much (ENOUGH in app/api/faucet.js)
const FAUCET_COOLDOWN_MS = 10 * 60_000; // matches app/api/faucet.js
// Program v3.1: courts saved under older keys can't be read any more, so they're simply ignored.
const lastKey = (burner: string) => `saring.last.v3.1.${burner}`;
const faucetKey = (burner: string) => `saring.faucetUntil.${burner}`;

/** External link: always a new tab, no referrer. */
const Ext = (p: AnchorHTMLAttributes<HTMLAnchorElement>) => <a target="_blank" rel="noreferrer" {...p} />;

/** The last finished run, so a reload still shows its verdict and explorer links. */
interface Last {
  market: string;
  /** Court account address (devnet), for the record. */
  court: string;
  courtId: number;
  choice: Choice;
  verdict: Verdict;
  bet: Bet;
  steps: Pick<StepState, "status" | "queueSig" | "finalizeSig">[];
}
/** Keyed by burner pubkey: a saved verdict from another burner is never shown. */
function loadLast(burner: string): Last | null {
  try {
    return JSON.parse(localStorage.getItem(lastKey(burner)) ?? "null");
  } catch {
    return null;
  }
}
function saveLast(burner: string, l: Last | null) {
  try {
    if (l) localStorage.setItem(lastKey(burner), JSON.stringify(l));
    else localStorage.removeItem(lastKey(burner));
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
function payout(v: Verdict, b: NonNullable<Bet>): { kind: "refund" | "win" | "lose"; amount: number } {
  const yesWins = v.yes > v.no;
  const winPool = yesWins ? b.yesPool : b.noPool;
  if (v.incomplete || v.yes === v.no || winPool === 0) return { kind: "refund", amount: b.amount };
  return b.yes === yesWins
    ? { kind: "win", amount: Math.floor((b.amount * (b.yesPool + b.noPool)) / winPool) }
    : { kind: "lose", amount: b.amount };
}

// Every figure here is copied from the Conflict Report (docs/index.html).
const STATS = [
  { n: "60.4%", l: "of UMA voters control a Polymarket wallet", s: "3,743 of 6,198 voters", pos: "p-tl" },
  { n: "20.2%", l: "of disputes had a voter holding a position", s: "834 of 4,121 disputes", pos: "p-tr" },
  { n: "65.7%", l: "of disputes in ≥ $1M markets had one", s: "423 of 644 disputes", pos: "p-bl" },
  { n: "0", l: "outcomes shown to be flipped", s: "The gap: nothing filters these voters", pos: "p-br" },
];

export default function App() {
  const burner = useMemo(loadBurner, []);
  const client = useMemo(() => makeClient(burner), [burner]);
  const me = burner.publicKey.toBase58();
  const last = useMemo(() => loadLast(me), [me]);

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
  // Cooldown end, persisted so a reload doesn't invite a retry the server will refuse.
  const [faucetUntil, setFaucetUntil] = useState(() => {
    try {
      return Number(localStorage.getItem(faucetKey(me))) || 0;
    } catch {
      return 0;
    }
  });
  const [now, setNow] = useState(Date.now);
  const [copied, setCopied] = useState(false);
  const [godView, setGodView] = useState(false);
  const verdictRef = useRef<HTMLElement>(null);
  // Default: the demo market, or the market of this burner's saved run so its verdict shows again.
  const [market, setMarket] = useState(last?.market ?? PANTA_MARKET);
  const marketRef = useRef(market);
  const [options, setOptions] = useState<MarketOption[] | null>(null);
  const [optionsErr, setOptionsErr] = useState("");
  const optionsAsked = useRef(false);
  // Panta API's view of each juror wallet: market ids it lists, or "error". Cached across markets.
  const [apiPos, setApiPos] = useState<Record<string, string[] | "error">>({});
  const apiPosRef = useRef(apiPos);

  // Dev-only: lets a local check open the Settle on Panta panel without a 3-minute devnet run.
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __saringVerdict?: typeof setVerdict }).__saringVerdict = setVerdict;
  }, []);

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
    const m = marketRef.current;
    withTimeout(loadScenario(burner.publicKey, choiceRef.current, m))
      .then((sc) => {
        if (m !== marketRef.current) return; // the visitor picked another market meanwhile
        // Restore the last finished run if it matches this market and script.
        const last = loadLast(me);
        if (last && last.market === m && last.steps.length === sc.steps.length) {
          setStepStates(last.steps.map((s) => ({ ...s })));
          setCourtId(last.courtId);
          setVerdict(last.verdict);
          setBet(last.bet);
          // A court the current program can't read (e.g. made before v3.1) is dropped silently.
          readVerdict(client, last.courtId).catch(() => {
            if (loadLast(me)?.courtId !== last.courtId) return;
            saveLast(me, null);
            setStepStates(fresh(sc.steps));
            setCourtId(null);
            setVerdict(null);
            setBet(null);
          });
        } else setStepStates(fresh(sc.steps));
        setScenario(sc);
      })
      .catch((e) => m === marketRef.current && setScenarioErr(e instanceof Error ? e.message : String(e)));
  }, [burner, client, me]);
  useEffect(loadCase, [loadCase]);

  // The market list costs a mainnet scan, so it waits until the first case has loaded.
  const loadOptions = useCallback(() => {
    optionsAsked.current = true;
    setOptionsErr("");
    withTimeout(listDisputableMarkets())
      .then(setOptions)
      .catch((e) => setOptionsErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    if (scenario && !optionsAsked.current) loadOptions();
  }, [scenario, loadOptions]);

  function pickMarket(id: string) {
    if (running || id === marketRef.current) return;
    marketRef.current = id;
    setMarket(id);
    setScenario(null);
    setStepStates([]);
    setCourtId(null);
    setVerdict(null);
    setBet(null);
    setNotice("");
    loadCase();
  }

  // Tick the faucet cooldown label while it runs.
  useEffect(() => {
    if (faucetUntil <= now) return;
    const id = setTimeout(() => setNow(Date.now()), Math.min(30_000, faucetUntil - now));
    return () => clearTimeout(id);
  }, [faucetUntil, now]);

  // God view cross-check: ask Panta's indexer about each juror, one at a time, cached.
  const jurors = scenario?.jurors;
  useEffect(() => {
    if (!godView || !jurors) return;
    let stop = false;
    (async () => {
      for (const j of jurors) {
        if (stop) return;
        if (j.you || Array.isArray(apiPosRef.current[j.wallet])) continue; // errors retry on the next toggle
        let v: string[] | "error";
        try {
          v = (await withTimeout(walletPositions(j.wallet), 20_000)).positions.map((p) => p.marketId);
        } catch {
          v = "error";
        }
        apiPosRef.current = { ...apiPosRef.current, [j.wallet]: v };
        setApiPos(apiPosRef.current);
      }
    })();
    return () => {
      stop = true;
    };
  }, [godView, jurors]);

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
      setNotice(`Received ${j.sol ?? FAUCET_SOL} devnet SOL. You can run the dispute.`);
    } catch (e) {
      setNotice(`The faucet said: ${(e as Error).message}. You can also use faucet.solana.com with the address above.`);
    }
    // The server rate-limits for 10 minutes either way; don't let the button invite retries.
    const until = Date.now() + FAUCET_COOLDOWN_MS;
    try {
      localStorage.setItem(faucetKey(me), String(until));
    } catch {
      /* storage blocked: the cooldown just won't survive a reload */
    }
    setFaucetUntil(until);
    setNow(Date.now());
    setFaucetBusy(false);
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
      saveLast(me, {
        market: marketRef.current,
        court: courtPda(burner.publicKey, id).toBase58(),
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
    saveLast(me, null);
  }

  const done = steps.filter((s) => s.status === "finalized").length;
  const failed = steps.some((s) => s.status === "failed");
  const current = steps.findIndex((s) => s.status === "sending" || s.status === "queued");
  const need = RUN_COST + (choice.bet !== null ? 0.01 : 0);
  const lowFunds = balance !== null && balance < need && done < SCRIPT.length;
  const coolMin = Math.ceil((faucetUntil - now) / 60_000);
  const faucetWhy =
    coolMin > 0
      ? `Available again in ${coolMin} min`
      : balance !== null && balance >= FAUCET_ENOUGH
        ? "This wallet already has enough"
        : "";
  const t = scenario ? tallies(scenario) : null;
  const conflicted = scenario?.jurors.filter((j) => j.conflicted).length ?? 0;
  const resolved = !!verdict?.resolved;
  const shown = resolved ? verdict! : t?.expected;
  const outcome = resolved ? (verdict!.incomplete ? "VOID" : word(verdict!.yes, verdict!.no)) : null;

  /** Chain (source of truth) vs what Panta's indexer lists for this juror in this market. */
  function crossCheck(j: Scenario["jurors"][number]) {
    if (j.you) return <span className="muted">n/a: your bet is on devnet</span>;
    const v = apiPos[j.wallet];
    if (v === undefined) return <span className="muted">Checking…</span>;
    if (v === "error") return <span className="muted">API unavailable</span>;
    const api = v.includes(scenario!.market);
    const chain = j.conflicted;
    return (
      <span className={`tag ${chain === api ? "" : "sealed"}`}>
        chain: {chain ? "yes" : "no"} · API: {api ? "yes" : chain ? "not indexed" : "no"}
      </span>
    );
  }

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
          <a href="#live">Live mainnet</a>
          <a href="#multichain">Multichain</a>
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
          <div className="glass picker">
            <div className="picker-top">
              <label htmlFor="market-pick" className="field-label">
                Pick a Panta market to replay as a dispute
              </label>
              <Ext className="fine" href={PANTA}>
                Powered by Panta
              </Ext>
            </div>
            <select
              id="market-pick"
              value={market}
              disabled={running}
              aria-describedby="market-pick-hint"
              onChange={(e) => pickMarket(e.target.value)}
            >
              {(options ?? []).some((o) => o.marketId === market) ? null : (
                <option value={market}>{scenario?.question ?? (market === PANTA_MARKET ? "Demo market" : short(market))}</option>
              )}
              {options?.map((o) => (
                <option key={o.marketId} value={o.marketId}>
                  {`${o.title.length > 60 ? `${o.title.slice(0, 59)}…` : o.title} · ${o.holders} holders${
                    o.panta ? ` · ${o.panta.phase}/${o.panta.status} · ${usdc(o.panta.volumeUsdc)}` : ""
                  }${o.marketId === PANTA_MARKET ? " · demo" : ""}`}
                </option>
              ))}
            </select>
            <p id="market-pick-hint" className="fine" role="status">
              {running
                ? "Locked while a dispute is running."
                : optionsErr
                  ? "Could not list Panta markets right now. "
                  : options
                    ? `${options.length} markets fit the court (3–${MAX_HOLDERS} holders). Holder counts come from Panta’s program on mainnet; phase, status and volume from the Panta API.`
                    : "Listing Panta markets that fit the court…"}
              {optionsErr && !running && (
                <button type="button" className="pill ghost sm" onClick={loadOptions}>
                  Try again
                </button>
              )}
            </p>
          </div>

          <div className="block-head">
            <h2 id="case-h">
              {scenario
                ? `One real market, ${scenario.jurors.length} jurors, ${conflicted} of them hold a position`
                : "One real market, one jury"}
            </h2>
            {scenario ? (
              <div className="case-copy">
                <p>
                  <strong>We replay a real Panta market as if it were disputed.</strong> The market asks{" "}
                  <Ext href={pantaMarketUrl(scenario.market)}>
                    <strong>“{scenario.question}”</strong>
                  </Ext>{" "}
                  {scenario.holderCount} wallets have a position in it ({scenario.openHolderCount} still open), read from
                  Solana mainnet via Panta’s program. Five jurors are real Panta traders whose ballots are scripted, since
                  we don’t hold their keys. The sixth is you.
                </p>
                <p className="secret">
                  <strong>What is secret:</strong> Panta positions are public on chain — Saring keeps the jury secret,
                  and keeps holder ids encrypted inside the court so the same court works for venues with private
                  positions.
                </p>
              </div>
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
                  "Reading the Panta market and its holders from Solana mainnet…"
                )}
              </p>
            )}
          </div>

          {scenario && (
            <article className="glass panta-card" aria-labelledby="panta-h">
              <div className="picker-top">
                <h3 id="panta-h">Panta market</h3>
                <p className="tl-links">
                  <Ext href={pantaMarketUrl(scenario.market)}>Explorer (mainnet) {short(scenario.market)}</Ext>
                  <Ext href={PANTA}>panta.market</Ext>
                </p>
              </div>
              {scenario.panta ? (
                <dl className="facts">
                  <div className="wide">
                    <dt>Title</dt>
                    <dd>{scenario.question}</dd>
                  </div>
                  <div>
                    <dt>Category</dt>
                    <dd>{scenario.panta.category ?? "n/a"}</dd>
                  </div>
                  <div>
                    <dt>Phase / status</dt>
                    <dd>
                      {scenario.panta.phase} / {scenario.panta.status}
                    </dd>
                  </div>
                  <div>
                    <dt>Resolved</dt>
                    <dd>{scenario.panta.resolved ? "Yes" : "No"}</dd>
                  </div>
                  <div>
                    <dt>Volume (USDC)</dt>
                    <dd>{usdc(scenario.panta.volumeUsdc)}</dd>
                  </div>
                  {num(scenario.panta.yesPrice) !== null && num(scenario.panta.noPrice) !== null && (
                    <div>
                      <dt>YES / NO price</dt>
                      <dd>
                        {cents(scenario.panta.yesPrice)} / {cents(scenario.panta.noPrice)}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Resolution time</dt>
                    <dd>
                      {num(scenario.panta.resolutionTime) === null
                        ? "n/a"
                        : new Date(num(scenario.panta.resolutionTime)! * 1000).toLocaleString()}
                    </dd>
                  </div>
                  <div>
                    <dt>Oracle</dt>
                    <dd>{scenario.panta.oracle ?? "n/a"}</dd>
                  </div>
                  <div>
                    <dt>Sent to UMA</dt>
                    <dd>{scenario.panta.sentToUma == null ? "n/a" : scenario.panta.sentToUma ? "Yes" : "No"}</dd>
                  </div>
                </dl>
              ) : (
                <p className="fine">
                  The Panta API returned no details for this market right now. The on-chain read above is the source of
                  truth.
                </p>
              )}
              <p className="fine">Panta escalates disputes to UMA — the voters our Conflict Report measured.</p>
            </article>
          )}

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
                  <strong>Explainer only — the chain never sees this.</strong>{" "}
                  {godView
                    ? "Showing who holds this market (only MPC compares the lists), cross-checked against the Panta API. Chain is the source of truth."
                    : "Reveal who holds this market."}
                </span>
              </div>
              <table>
                <caption className="sr-only">Jurors, whether they hold a position, and their final counted ballots</caption>
                <thead>
                  <tr>
                    <th scope="col">Juror wallet</th>
                    <th scope="col">Conflict</th>
                    <th scope="col">Counted ballot</th>
                    {godView && <th scope="col">Panta API</th>}
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
                            {godView && <td>{crossCheck(j)}</td>}
                          </tr>
                        );
                      })
                    : [0, 1, 2, 3, 4, 5].map((i) => (
                        <tr key={i} className="skeleton" aria-hidden="true">
                          <td>········</td>
                          <td>···</td>
                          <td>···</td>
                          {godView && <td>···</td>}
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
                        {sol(bet.noPool)}.{" "}
                        {(() => {
                          const p = payout(verdict!, bet);
                          if (p.kind === "lose") return `Lost ${sol(p.amount)}.`;
                          return `${p.kind === "refund" ? "Refunded" : "Payout"} ${sol(p.amount)}${bet.claimed ? ", claimed." : ", not claimed yet."}`;
                        })()}
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

          {resolved && scenario && (
            <SettleOnPanta key={`${scenario.market}:${verdict!.yes}:${verdict!.no}:${verdict!.incomplete}`} market={scenario.market} verdict={verdict!} oracle={burner.publicKey} />
          )}
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
                  Stored in this browser. Get devnet SOL gives this wallet {FAUCET_SOL} SOL, enough for one run (~0.10 SOL).
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
                  <button type="button" className="pill ghost sm" onClick={airdrop}
                    disabled={faucetBusy || !!faucetWhy}
                    aria-describedby={faucetWhy ? "faucet-why" : undefined}
                  >
                    Get devnet SOL
                  </button>
                  {faucetWhy && !faucetBusy && (
                    <span id="faucet-why" className="fine">
                      {faucetWhy}
                    </span>
                  )}
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
                {/* Always mounted so screen readers announce changes. */}
                <p className={notice ? "notice" : "sr-only"} role="status" aria-live="polite">
                  {notice}
                </p>
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
              <p className="fine tl-hint">
                On explorer you will also see failed duplicate callbacks (error 6204 AlreadyCallbackedComputation): Arx
                nodes race to deliver each result and the program accepts only the first. Our links point to the one
                that succeeded.
              </p>
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

        <PantaLive />

        <Multichain />

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

/**
 * After a verdict: builds Panta's real settlement instruction for the replayed market and
 * simulates it on mainnet (unsigned). Panta's program runs it up to its oracle check.
 */
function SettleOnPanta({ market, verdict, oracle }: { market: string; verdict: Verdict; oracle: PublicKey }) {
  const mapped = verdictToYesWins(verdict);
  const [built, setBuilt] = useState<PantaSettle | null>(null);
  const [buildErr, setBuildErr] = useState("");
  const [sim, setSim] = useState<SimResult | null>(null);
  const [simErr, setSimErr] = useState("");
  const [busy, setBusy] = useState(false);
  const yesWins = "yesWins" in mapped ? mapped.yesWins : null;

  const build = useCallback(() => {
    if (yesWins === null) return;
    setBuildErr("");
    withTimeout(buildPantaSettle(market, yesWins, oracle))
      .then(setBuilt)
      .catch((e) => setBuildErr(e instanceof Error ? e.message : String(e)));
  }, [market, yesWins, oracle]);
  useEffect(build, [build]);

  async function simulate() {
    if (!built) return;
    setBusy(true);
    setSimErr("");
    try {
      setSim(await withTimeout(simulatePantaSettle(built)));
    } catch (e) {
      setSimErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const ae = sim?.anchorError;
  return (
    <article className="glass settle" aria-labelledby="settle-h">
      <div className="picker-top">
        <h3 id="settle-h">Settle on Panta</h3>
        <Ext className="fine" href={explorerMainnetAddr(PANTA_PROGRAM_ID.toBase58())}>
          Panta program {short(PANTA_PROGRAM_ID.toBase58())} on Explorer
        </Ext>
      </div>
      <p className="settle-why">Today one oracle key settles Panta disputes; Saring’s verdict can replace it.</p>
      <p className="fine">
        Verdict {verdict.yes}–{verdict.no}
        {verdict.incomplete ? ", incomplete" : ""} →{" "}
        {yesWins === null ? <strong className="bad">no settlement</strong> : <code>yes_wins = {String(yesWins)}</code>}
      </p>
      {"refuse" in mapped ? (
        <p className="notice">{mapped.refuse}</p>
      ) : buildErr ? (
        <p className="notice" role="status">
          Could not build the instruction: {buildErr.slice(0, 200)}{" "}
          <button type="button" className="pill ghost sm" onClick={build}>
            Try again
          </button>
        </p>
      ) : !built ? (
        <p className="fine" role="status">
          Building Panta’s instruction from its IDL and the market’s mainnet history…
        </p>
      ) : (
        <>
          <p className="fine">
            <code>{built.name}(yes_wins: {String(built.yesWins)})</code> on <code>{short(PANTA_PROGRAM_ID.toBase58())}</code>, data{" "}
            <code>{built.dataHex}</code>. Fee payer in simulation: Panta’s treasury{" "}
            <code>{short(built.feePayer.toBase58())}</code> (signatures are not checked).
          </p>
          <div className="settle-table" tabIndex={0} role="region" aria-label="Instruction accounts (scrolls sideways)">
            <table>
              <caption className="sr-only">Accounts of Panta’s {built.name} instruction</caption>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Address</th>
                  <th scope="col">Role</th>
                  <th scope="col">Resolved from</th>
                </tr>
              </thead>
              <tbody>
                {built.accounts.map((a) => (
                  <tr key={a.name}>
                    <td>
                      <code>{a.name}</code>
                    </td>
                    <td>
                      <Ext href={explorerMainnetAddr(a.address)}>{short(a.address)}</Ext>
                    </td>
                    <td>{[a.signer && "signer", a.writable ? "writable" : "read-only"].filter(Boolean).join(", ")}</td>
                    <td className="muted-cell">{a.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="btn-row">
            <button type="button" className="pill" onClick={simulate} disabled={busy}>
              {busy ? "Simulating on mainnet…" : sim ? "Simulate again" : "Simulate on mainnet"}
            </button>
          </div>
          <div role="status" aria-live="polite">
            {simErr && <p className="notice">Simulation request failed: {simErr.slice(0, 200)}</p>}
            {sim && (
              <div className="settle-result">
                <p className={ae?.code === 6025 || sim.err === null ? "ok" : "bad"}>
                  {sim.err === null
                    ? "Panta’s program accepted the instruction end to end in simulation."
                    : ae?.code === 6025
                      ? "Panta’s program accepted every account and argument and stopped at its oracle check (Unauthorized 6025): only Panta’s oracle key can sign this. Signed by Panta, Saring’s verdict settles this market."
                      : ae
                        ? `Panta’s program stopped at ${ae.name} (${ae.code}): ${ae.msg}. It did not reach the oracle check, so this run does not show the verdict plugging in.`
                        : `The simulation failed before Panta’s program judged it: ${JSON.stringify(sim.err)}.`}
                </p>
                <p className="fine">
                  Compute units: {sim.unitsConsumed ?? "n/a"} · simulated on Solana mainnet, nothing signed or sent.
                </p>
                <details>
                  <summary>Program logs ({sim.logs.length})</summary>
                  <pre className="logs">{sim.logs.join("\n")}</pre>
                </details>
              </div>
            )}
          </div>
        </>
      )}
    </article>
  );
}

// ---------- Live: Panta on mainnet, via Solami (app/api/panta-live.js) ----------

interface LiveItem {
  id: string;
  kind: string;
  t: number;
  market: string;
  src: "rpc" | "grpc";
  walletShort?: string;
  side?: string | null;
  sig?: string;
}
interface LiveMetrics {
  txsScanned: number;
  windowFrom: number | null;
  newPositions24h: number;
  newPositions7d: number;
  uniqueWallets7d: number;
  marketsTouched7d: number;
  disputes: number;
  resolutions: number;
  liveUpdates: number;
}
type LivePhase = "idle" | "backfill" | "connecting" | "live" | "reconnecting" | "offline";

const LIVE_URL: string = import.meta.env.VITE_PANTA_LIVE_URL || "/api/panta-live";
const KIND_LABEL: Record<string, string> = {
  "new-position": "New position",
  trade: "Trade",
  "position-account": "Position changed",
  dispute: "Dispute",
  resolution: "Resolved",
  "oracle-result": "Oracle result",
  "dispute-settled": "Dispute settled",
};
const PHASE_LABEL: Record<LivePhase, string> = {
  idle: "Connects when this section is on screen",
  backfill: "Backfilling through Solami RPC",
  connecting: "Opening the Solami gRPC stream",
  live: "Live: Solami Yellowstone gRPC",
  reconnecting: "Reconnecting",
  offline: "Offline",
};
const titleCache = new Map<string, Promise<string | null>>(); // Panta API market titles, once per market
const liveTime = (t: number) =>
  new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function PantaLive() {
  const ref = useRef<HTMLElement>(null);
  const [inView, setInView] = useState(false);
  const [phase, setPhase] = useState<LivePhase>("idle");
  const [detail, setDetail] = useState("");
  const [items, setItems] = useState<LiveItem[]>([]);
  const [metrics, setMetrics] = useState<LiveMetrics | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});

  // Connect only while the section is (nearly) on screen.
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { rootMargin: "200px" });
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!inView) return;
    const es = new EventSource(LIVE_URL);
    const on = <T,>(name: string, f: (d: T) => void) =>
      es.addEventListener(name, (e) => f(JSON.parse((e as MessageEvent).data)));
    on<{ phase: LivePhase; detail?: string }>("status", (d) => {
      setPhase(d.phase);
      setDetail(d.detail ?? "");
    });
    on<{ items: LiveItem[] }>("items", ({ items: add }) =>
      setItems((cur) => {
        const ids = new Set(cur.map((i) => i.id));
        return [...cur, ...add.filter((i) => !ids.has(i.id))].sort((a, b) => b.t - a.t).slice(0, 120);
      })
    );
    on<LiveMetrics>("metrics", setMetrics);
    on("bye", () => setPhase("reconnecting"));
    es.onerror = () => setPhase(es.readyState === EventSource.CLOSED ? "offline" : "reconnecting");
    return () => es.close();
  }, [inView]);

  // Market titles from the Panta API, for the rows near the top.
  useEffect(() => {
    for (const m of new Set(items.slice(0, 40).map((i) => i.market))) {
      if (titleCache.has(m)) continue;
      const p = marketDetail(m).then((d) => d.title ?? null, () => null);
      titleCache.set(m, p);
      p.then((t) => t && setTitles((cur) => ({ ...cur, [m]: t })));
    }
  }, [items]);

  const tiles: [string, number | undefined][] = [
    ["New positions, 24h", metrics?.newPositions24h],
    ["New positions, 7d", metrics?.newPositions7d],
    ["Unique wallets, 7d", metrics?.uniqueWallets7d],
    ["Markets touched, 7d", metrics?.marketsTouched7d],
    ["Disputes", metrics?.disputes],
    ["Resolutions", metrics?.resolutions],
    ["Live updates (gRPC)", metrics?.liveUpdates],
  ];

  return (
    <section id="live" className="block" aria-labelledby="live-h" ref={ref}>
      <div className="block-head">
        <h2 id="live-h">Live: Panta on Solana mainnet (via Solami)</h2>
        <p>
          Every row is read from mainnet through <strong>Solami</strong>: recent Panta transactions over Solami RPC, then
          Panta’s transactions and position accounts as they land, over Solami’s Yellowstone gRPC stream.
        </p>
      </div>
      <p className={`live-status ${phase}`} role="status">
        <span className="dot" aria-hidden="true" />
        {PHASE_LABEL[phase]}
        {detail && <span className="muted">· {detail}</span>}
      </p>
      <ul className="live-tiles" aria-label="Panta metrics on mainnet">
        {tiles.map(([label, n]) => (
          <li key={label} className="glass">
            <span className="n">{n ?? "–"}</span>
            <span className="l">{label}</span>
          </li>
        ))}
      </ul>
      {metrics?.windowFrom && (
        <p className="fine live-window">
          Window: the last {metrics.txsScanned} successful Panta transactions (since {liveTime(metrics.windowFrom)}), plus
          everything streamed since this section opened.
        </p>
      )}
      <div className="glass live-feed" tabIndex={0} role="region" aria-label="Panta events, newest first">
        {items.length === 0 ? (
          <p className="muted live-empty">
            {phase === "offline" ? "The live feed is unavailable right now." : "Loading Panta activity…"}
          </p>
        ) : (
          <ol>
            {items.map((i) => (
              <li key={i.id} className={`live-row k-${i.kind}`}>
                <time dateTime={new Date(i.t).toISOString()}>{liveTime(i.t)}</time>
                <span className="tag">{KIND_LABEL[i.kind] ?? i.kind}</span>
                <span className="live-what">
                  <Ext href={pantaMarketUrl(i.market)}>{titles[i.market] ?? short(i.market)}</Ext>
                  <span className="muted">
                    {i.side && ` · ${i.side}`}
                    {i.walletShort && ` · ${i.walletShort}`}
                    {" · "}
                    {i.sig ? (
                      <Ext href={`https://explorer.solana.com/tx/${i.sig}`}>{i.src === "grpc" ? "gRPC" : "RPC"} tx</Ext>
                    ) : (
                      "gRPC account"
                    )}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <p className="fine live-note">
        Each new position here would be mirrored into an open Saring court; a dispute opens one automatically
        (panta/watch.ts).
      </p>
    </section>
  );
}
