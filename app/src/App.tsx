import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { BN } from "@anchor-lang/core";
import {
  HONEST,
  INSIDERS,
  MARKET,
  PROGRAM_ID,
  SCRIPT,
  awaitStep,
  courtPda,
  explorerAddr,
  explorerTx,
  fetchMxePublicKey,
  loadBurner,
  makeClient,
  newComputationOffset,
  newCourtId,
  queueStep,
  readVerdict,
  type Verdict,
} from "./court";

type Status = "waiting" | "sending" | "queued" | "finalized" | "failed";
interface StepState {
  status: Status;
  offset?: BN;
  queueSig?: string;
  finalizeSig?: string;
  error?: string;
}

const fresh = (): StepState[] => SCRIPT.map(() => ({ status: "waiting" }));
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const STATUS_LABEL: Record<Status, string> = {
  waiting: "Waiting",
  sending: "Sending",
  queued: "Queued in MPC",
  finalized: "Finalized",
  failed: "Failed",
};

export default function App() {
  const burner = useMemo(loadBurner, []);
  const client = useMemo(() => makeClient(burner), [burner]);

  const [balance, setBalance] = useState<number | null>(null);
  const [programLive, setProgramLive] = useState<boolean | null>(null);
  const [steps, setSteps] = useState<StepState[]>(fresh);
  const stepsRef = useRef(steps);
  const [courtId, setCourtId] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [notice, setNotice] = useState("");

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
    stepsRef.current = fresh();
    setSteps(stepsRef.current);
    setCourtId(null);
    setVerdict(null);
    setNotice("");
  }

  const done = steps.filter((s) => s.status === "finalized").length;
  const failed = steps.some((s) => s.status === "failed");
  const current = steps.findIndex((s) => s.status === "sending" || s.status === "queued");
  const lowFunds = balance !== null && balance < 0.1;

  return (
    <main>
      <p className="kicker">Blindcourt · live on Solana devnet</p>
      <h1>A jury that cannot see who is conflicted, and still leaves them out</h1>
      <p className="dek">
        Five jurors decide a disputed prediction market. Three of them secretly traded it. Blindcourt drops them inside
        Arcium MPC and publishes only the tally. Nobody learns who was dropped.
      </p>

      <section aria-labelledby="scenario-h">
        <h2 id="scenario-h">The dispute</h2>
        <p>
          Market: <strong>“{MARKET}”</strong> The true answer is <strong>NO</strong>.
        </p>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Jurors, whether they hold a position, and their ballots</caption>
            <thead>
              <tr>
                <th scope="col">Juror</th>
                <th scope="col">Traded this market?</th>
                <th scope="col">Final ballot</th>
              </tr>
            </thead>
            <tbody>
              {INSIDERS.map((id) => (
                <tr key={id}>
                  <td>#{id}</td>
                  <td className="bad">Yes, holds a position</td>
                  <td>YES</td>
                </tr>
              ))}
              <tr>
                <td>#{HONEST[0]}</td>
                <td>No</td>
                <td>
                  NO <span className="muted">(cast YES for a briber first, then overwrote it)</span>
                </td>
              </tr>
              <tr>
                <td>#{HONEST[1]}</td>
                <td>No</td>
                <td>NO</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Only this demo page knows the table above. On chain, every juror id, trader id and ballot is a ciphertext.
        </p>

        <div className="versus">
          <article className="panel">
            <h3>A normal jury</h3>
            <p className="big bad">YES</p>
            <p className="score">3 – 2</p>
            <p className="small">
              Conflicted votes count. If the bribe holds it is 4 – 1, and the briber can check, because ballots are
              public.
            </p>
          </article>
          <article className="panel" aria-live="polite">
            <h3>Blindcourt verdict</h3>
            {verdict?.resolved ? (
              <>
                <p className="big ok">{verdict.yes > verdict.no ? "YES" : verdict.no > verdict.yes ? "NO" : "TIE"}</p>
                <p className="score">
                  {verdict.yes} – {verdict.no}
                </p>
                <dl className="tally">
                  <div>
                    <dt>yes</dt>
                    <dd>{verdict.yes}</dd>
                  </div>
                  <div>
                    <dt>no</dt>
                    <dd>{verdict.no}</dd>
                  </div>
                  <div>
                    <dt>excluded</dt>
                    <dd>{verdict.excluded}</dd>
                  </div>
                </dl>
                <p className="small">
                  Read from the court account on devnet. {verdict.excluded} jurors were excluded; their identities were
                  never revealed.
                </p>
              </>
            ) : (
              <>
                <p className="big muted">—</p>
                <p className="small">Run the dispute below. The tally appears here once the MPC resolve finalizes.</p>
              </>
            )}
          </article>
        </div>
      </section>

      <section aria-labelledby="run-h">
        <h2 id="run-h">Run the dispute on devnet</h2>

        <div className="wallet">
          <div>
            <span className="label">Burner wallet (stored in this browser)</span>
            <code className="addr">{burner.publicKey.toBase58()}</code>
          </div>
          <div className="row">
            <span>
              Balance: <strong>{balance === null ? "…" : `${balance.toFixed(3)} SOL`}</strong>
            </span>
            <button type="button" className="ghost" onClick={refreshBalance}>
              Refresh
            </button>
            <button type="button" className="ghost" onClick={() => navigator.clipboard?.writeText(burner.publicKey.toBase58())}>
              Copy address
            </button>
            <button type="button" className="ghost" onClick={airdrop}>
              Airdrop 1 SOL
            </button>
            <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">
              faucet.solana.com
            </a>
          </div>
          <p className="small muted">
            Fund this address with devnet SOL (about 0.5 SOL is plenty). It pays for 18 transactions; every computation
            fee goes to Arcium devnet.{" "}
            {programLive === false && <strong className="bad">The program is not deployed on devnet yet.</strong>}
            {programLive && <span>Program {short(PROGRAM_ID.toBase58())} is live.</span>}
          </p>
        </div>

        <div className="row actions">
          <button type="button" onClick={run} disabled={running || done === SCRIPT.length || lowFunds}>
            {running ? `Running… ${done}/${SCRIPT.length}` : failed ? "Retry from the failed step" : done ? "Continue" : "Run the dispute"}
          </button>
          {!running && done > 0 && (
            <button type="button" className="ghost" onClick={reset}>
              Start a new court
            </button>
          )}
          {lowFunds && <span className="small bad">Fund the wallet first.</span>}
          {courtId !== null && (
            <a className="small" href={explorerAddr(courtPda(burner.publicKey, courtId).toBase58())} target="_blank" rel="noreferrer">
              Court account
            </a>
          )}
        </div>
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        <p className="sr-only" aria-live="polite">
          {current >= 0 ? `${SCRIPT[current].title}: ${STATUS_LABEL[steps[current].status]}` : ""}
        </p>

        <div className="progress" aria-hidden="true">
          <div style={{ width: `${(done / SCRIPT.length) * 100}%` }} />
        </div>

        <ol className="steps">
          {SCRIPT.map((s, i) => {
            const st = steps[i];
            return (
              <li key={i} className={`step ${st.status}`}>
                <span className="dot" aria-hidden="true" />
                <div className="body">
                  <div className="title">
                    {s.title}
                    <span className="status">{STATUS_LABEL[st.status]}</span>
                  </div>
                  <div className="note">{s.note}</div>
                  {(st.queueSig || st.finalizeSig) && (
                    <div className="links">
                      {st.queueSig && (
                        <a href={explorerTx(st.queueSig)} target="_blank" rel="noreferrer">
                          queue tx {short(st.queueSig)}
                        </a>
                      )}
                      {st.finalizeSig && (
                        <a href={explorerTx(st.finalizeSig)} target="_blank" rel="noreferrer">
                          MPC callback {short(st.finalizeSig)}
                        </a>
                      )}
                    </div>
                  )}
                  {st.error && <div className="error">{st.error}</div>}
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <section aria-labelledby="explain-h">
        <h2 id="explain-h">What is hidden, what is revealed</h2>
        <div className="versus">
          <article className="panel">
            <h3>Hidden (ciphertext on chain)</h3>
            <ul>
              <li>Which juror ids sit on the jury</li>
              <li>Which traders hold a position</li>
              <li>Each juror’s ballot, and whether it was overwritten</li>
              <li>Which jurors were excluded as conflicted</li>
            </ul>
          </article>
          <article className="panel">
            <h3>Revealed</h3>
            <ul>
              <li>
                Three numbers: <code>yes</code>, <code>no</code>, <code>excluded</code>
              </li>
              <li>That each step ran, through Arcium-signed callbacks</li>
            </ul>
          </article>
        </div>
        <p>
          The conflict check needs the jury list and the holder list together, and must leak neither. Publishing the jury
          tells bribers whom to pay; publishing holders doxxes traders. So both stay encrypted in one MXE state and the
          check runs inside multi-party computation. Ballots can be overwritten by any relayer, so a bribed juror can
          show a YES receipt and quietly change it.
        </p>
        <p className="muted small">
          MVP limits: the court authority seats jurors, ids are small integers, and a second wallet evades the filter. See
          the README for the roadmap.
        </p>
      </section>

      <footer>
        <a href="https://pugarhuda.github.io/blindcourt/">Conflict Report: how often UMA voters judged markets they traded</a>
        <a href="https://github.com/PugarHuda/blindcourt">Source on GitHub</a>
        <span className="muted">Devnet demo. Not audited. No real funds.</span>
      </footer>
    </main>
  );
}
