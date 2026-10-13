import React from "react";
import {
  AbsoluteFill, Audio, Composition, Img, Sequence, interpolate, registerRoot, spring,
  staticFile, useCurrentFrame, useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/Manrope";
import scenes from "./scenes.json";

const { fontFamily } = loadFont("normal", { weights: ["400", "600", "700", "800"], subsets: ["latin"] });
const FPS = 30;
const PAD = 0.45; // silence after each clip
const LEAD = 0.5; // silence before the first clip
const TAIL = 2.2; // hold on the last slide
const C = { void: "#06040c", plum: "#120c24", ink: "#f5f3fb", muted: "#b2abca", dim: "#8a83a6", gold: "#f1cf8e", ice: "#9fc4ff", lilac: "#bba6ff", ok: "#8fe6b8", line: "rgba(255,255,255,.13)" };

type Cue = { from: number; to: number; text: string };
type Scene = { id: string; audio: string; dur: number; cues: Cue[] };
const S = scenes as Scene[];

// Scene timeline in frames.
const timeline = (() => {
  let at = 0;
  return S.map((s, i) => {
    const lead = i === 0 ? LEAD : 0;
    const len = Math.ceil((lead + s.dur + PAD + (i === S.length - 1 ? TAIL : 0)) * FPS);
    const t = { ...s, start: at, len, lead };
    at += len;
    return t;
  });
})();
const TOTAL = timeline.reduce((a, s) => a + s.len, 0);

// Long edge-tts cues are split into short caption chunks, timed by character share.
const chunks = (cues: Cue[]) =>
  cues.flatMap((c) => {
    const words = c.text.split(/\s+/);
    const n = Math.ceil(words.length / 9);
    const per = Math.ceil(words.length / n);
    const parts = Array.from({ length: n }, (_, k) => words.slice(k * per, (k + 1) * per).join(" "));
    const total = parts.reduce((a, p) => a + p.length, 0);
    let t = c.from;
    return parts.map((p) => {
      const d = ((c.to - c.from) * p.length) / total;
      const r = { from: t, to: t + d, text: p };
      t += d;
      return r;
    });
  });

const Caption: React.FC<{ cues: Cue[]; lead: number }> = ({ cues, lead }) => {
  const f = useCurrentFrame();
  const t = f / FPS - lead;
  const c = chunks(cues).find((x) => t >= x.from && t < x.to + 0.12);
  if (!c) return null;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 64, display: "flex", justifyContent: "center" }}>
      <div style={{ maxWidth: 1500, background: "rgba(11,8,22,.82)", border: `1px solid ${C.line}`, borderRadius: 18, padding: "16px 30px", color: C.ink, fontSize: 40, fontWeight: 600, lineHeight: 1.3, textAlign: "center", letterSpacing: "-0.01em" }}>
        {c.text}
      </div>
    </div>
  );
};

const Bg: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ background: `radial-gradient(1300px 820px at 78% 30%, rgba(110,80,220,.28), transparent 60%), linear-gradient(160deg, ${C.plum}, ${C.void} 70%)`, fontFamily, color: C.ink }}>
    {children}
  </AbsoluteFill>
);

const SlideImg: React.FC<{ src: string; len: number; zoomTo?: number; origin?: string }> = ({ src, len, zoomTo = 1.05, origin = "50% 50%" }) => {
  const f = useCurrentFrame();
  const scale = interpolate(f, [0, len], [1, zoomTo]);
  return <Img src={staticFile(src)} style={{ width: 1920, height: 1080, transform: `scale(${scale})`, transformOrigin: origin }} />;
};

// 1: the hook question, word by word, then the title slide.
const Hook: React.FC<{ len: number }> = ({ len }) => {
  const f = useCurrentFrame();
  const words = "Would you let a judge rule on a case they bet on?".split(" ");
  const qOut = interpolate(f, [100, 118], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill>
      <Sequence from={100}><SlideImg src="slides/s01.png" len={len - 100} /></Sequence>
      <AbsoluteFill style={{ background: C.void, opacity: qOut, justifyContent: "center", alignItems: "center", fontFamily }}>
        <div style={{ fontSize: 88, fontWeight: 800, letterSpacing: "-0.04em", maxWidth: 1400, textAlign: "center", lineHeight: 1.1 }}>
          {words.map((w, i) => {
            const o = interpolate(f, [8 + i * 4, 16 + i * 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            return <span key={i} style={{ opacity: o, color: w === "bet" ? C.gold : C.ink, display: "inline-block", transform: `translateY(${(1 - o) * 24}px)`, marginRight: 22 }}>{w}</span>;
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// 2: kinetic numbers, each landing on its spoken cue.
const Problem: React.FC<{ cues: Cue[]; lead: number }> = ({ cues, lead }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cueAt = (k: number) => Math.round(((cues[Math.min(k, cues.length - 1)]?.from ?? 0) + lead) * fps);
  const stats = [
    { at: 0, value: 4121, fmt: (v: number) => Math.round(v).toLocaleString("en-US"), label: "UMA disputes on Polymarket markets", sub: "Jan 2025 to Oct 2026", color: C.ink },
    { at: cueAt(1), value: 20.2, fmt: (v: number) => v.toFixed(1) + "%", label: "had a voter holding a position in that market", sub: "834 of 4,121: one in five", color: C.gold },
    { at: cueAt(2), value: 65.7, fmt: (v: number) => v.toFixed(1) + "%", label: "in markets with ≥ $1M volume", sub: "423 of 644: two in three", color: C.ice },
    { at: cueAt(3), value: 0, fmt: () => "0", label: "outcomes flip if they are removed", sub: "the gap: nothing filters them", color: C.lilac },
  ];
  const floor = spring({ frame: f - cueAt(4), fps, config: { damping: 200 } });
  return (
    <Bg>
      <div style={{ position: "absolute", left: 120, top: 100, fontSize: 22, fontWeight: 700, letterSpacing: "0.16em", color: C.lilac }}>THE PROBLEM · CONFLICT REPORT</div>
      <div style={{ position: "absolute", left: 120, top: 145, fontSize: 64, fontWeight: 800, letterSpacing: "-0.035em", maxWidth: 1600 }}>Nobody checks whether the voters bet on the market.</div>
      <div style={{ position: "absolute", left: 120, right: 120, top: 340, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 28 }}>
        {stats.map((s, i) => {
          const p = spring({ frame: f - s.at, fps, config: { damping: 18, stiffness: 120 } });
          const count = interpolate(f - s.at, [0, 30], [0, s.value], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          return (
            <div key={i} style={{ opacity: p, transform: `translateY(${(1 - p) * 60}px) scale(${0.9 + 0.1 * p})`, background: "rgba(24,18,44,.62)", border: `1px solid ${C.line}`, borderRadius: 28, padding: "36px 34px", height: 400 }}>
              <div style={{ fontSize: 104, fontWeight: 800, letterSpacing: "-0.04em", color: s.color, lineHeight: 1 }}>{s.fmt(count)}</div>
              <div style={{ fontSize: 28, color: C.muted, marginTop: 22, lineHeight: 1.35 }}>{s.label}</div>
              <div style={{ fontSize: 21, color: C.dim, marginTop: 14 }}>{s.sub}</div>
            </div>
          );
        })}
      </div>
      <div style={{ position: "absolute", left: 120, top: 790, fontSize: 32, fontWeight: 700, color: C.gold, opacity: floor }}>And these numbers are a floor.</div>
    </Bg>
  );
};

// 7: the chain grid, cards landing one by one, depth bars filling.
const CHAINS = [
  { n: "Solana + Arcium", d: "The court: encrypted jury, holders, ballots; MPC tally; settlement market", depth: 5, live: "LIVE", core: true },
  { n: "Tempo", d: "Paid dispute: MPP 402, fee-sponsored settle", depth: 4, live: "LIVE" },
  { n: "Zcash", d: "Shielded juror bonds, no-show slashed", depth: 3, live: "LIVE" },
  { n: "Ethereum L1", d: "70/70 votes proven against block headers", depth: 3, live: "LIVE" },
  { n: "Arbitrum", d: "UMA OOv3 + Kleros v2, ruled by VAA", depth: 3, live: "LIVE" },
  { n: "Base", d: "Limitless holders → court → Reality.eth", depth: 4, live: "LIVE" },
  { n: "Hyperliquid", d: "HIP-4 holders in a live court; contract ready", depth: 2, live: "CONTRACT READY" },
];
const Chains: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pulse = interpolate(f % 60, [0, 30, 60], [0.35, 1, 0.35]);
  return (
    <Bg>
      <div style={{ position: "absolute", left: 120, top: 92, fontSize: 22, fontWeight: 700, letterSpacing: "0.16em", color: C.lilac }}>MULTICHAIN · VERDICTS TRAVEL AS WORMHOLE VAAS</div>
      <div style={{ position: "absolute", left: 120, top: 136, fontSize: 60, fontWeight: 800, letterSpacing: "-0.035em" }}>The court lives on Solana.</div>
      <div style={{ position: "absolute", right: 120, top: 150, opacity: spring({ frame: f - 110, fps, config: { damping: 200 } }), textAlign: "right" }}>
        <div style={{ fontSize: 44, fontWeight: 800, color: C.ok }}>1 VAA → 4 chains</div>
        <div style={{ fontSize: 20, color: C.muted }}>one Solana verdict settled four adapters</div>
      </div>
      <div style={{ position: "absolute", left: 120, right: 120, top: 300, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 22 }}>
        {CHAINS.map((c, i) => {
          const start = 6 + i * 14;
          const p = spring({ frame: f - start, fps, config: { damping: 16, stiffness: 110 } });
          return (
            <div key={c.n} style={{ gridColumn: c.core ? "span 2" : undefined, opacity: p, transform: `translateY(${(1 - p) * 50}px)`, position: "relative", borderRadius: 24, padding: "26px 28px", height: 230,
              border: `1px solid ${c.core ? C.lilac : C.line}`, background: c.core ? "radial-gradient(circle at 0 0, rgba(187,166,255,.22), rgba(24,18,44,.7))" : "rgba(24,18,44,.62)",
              boxShadow: c.core ? `0 0 ${50 * pulse}px rgba(187,166,255,.35)` : "none" }}>
              <div style={{ position: "absolute", top: 24, right: 24, fontSize: 16, fontWeight: 800, color: c.live === "LIVE" ? C.ok : C.gold }}>{c.live}</div>
              <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.02em" }}>{c.n}</div>
              <div style={{ fontSize: 22, color: C.muted, marginTop: 12, lineHeight: 1.35, maxWidth: c.core ? 700 : 330 }}>{c.d}</div>
              <div style={{ position: "absolute", left: 28, right: 28, bottom: 26, display: "flex", gap: 6 }}>
                {[0, 1, 2, 3, 4].map((k) => {
                  const fill = k < c.depth ? interpolate(f - start - 10 - k * 4, [0, 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0;
                  return <div key={k} style={{ flex: 1, height: 7, borderRadius: 4, background: "rgba(255,255,255,.12)", overflow: "hidden" }}>
                    <div style={{ width: `${fill * 100}%`, height: "100%", background: `linear-gradient(90deg, ${C.lilac}, ${C.ice})` }} />
                  </div>;
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Bg>
  );
};

const SceneBody: React.FC<{ s: (typeof timeline)[number] }> = ({ s }) => {
  if (s.id === "s01") return <Hook len={s.len} />;
  if (s.id === "s02") return <Problem cues={s.cues} lead={s.lead} />;
  if (s.id === "s07") return <Chains />;
  if (s.id === "s05")
    return (
      <AbsoluteFill>
        <SlideImg src="slides/s05.png" len={s.len} zoomTo={1.12} origin="70% 45%" />
      </AbsoluteFill>
    );
  return <SlideImg src={`slides/${s.id}.png`} len={s.len} />;
};

const Fade: React.FC<{ len: number; children: React.ReactNode }> = ({ len, children }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [0, 10, len - 4, len], [0, 1, 1, 1], { extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

const Pitch: React.FC = () => (
  <AbsoluteFill style={{ background: C.void, fontFamily }}>
    {timeline.map((s) => (
      <Sequence key={s.id} from={s.start} durationInFrames={s.len + (s.start + s.len < TOTAL ? 10 : 0)}>
        <Fade len={s.len}><SceneBody s={s} /></Fade>
        <Sequence from={Math.round(s.lead * FPS)}><Audio src={staticFile(s.audio)} /></Sequence>
        <Caption cues={s.cues} lead={s.lead} />
      </Sequence>
    ))}
  </AbsoluteFill>
);

registerRoot(() => (
  <Composition id="Pitch" component={Pitch} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080} />
));
