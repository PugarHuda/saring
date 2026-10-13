// Saring demo: real Playwright recordings of the live product, cut to the voice-over.
// Every frame of product UI comes from public/*.mp4 (recorded by recording/rec-run.mjs and rec-extras.mjs).
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import durations from "./durations.json";
import lines from "./lines.json";
import mc from "./multichain-marks.json";

export const FPS = 30;
const GAP = 0.35; // silence between voice lines (s)
const INTRO = 3;
const OUTRO = 3.6;

type Box = { x: number; y: number; w: number; h: number };
type Callout = { at: number; dur: number; box: Box; label: string; zoom?: number }; // at/dur: seconds of SOURCE video
type Key = keyof typeof lines;
type Seg = { key: Key; chapter?: string; src: string; from: number; to: number; min?: number; callouts?: Callout[]; vo?: boolean };
const DUR = durations as Record<string, number>;
const LINES = lines as unknown as Record<Key, [string, string][]>;

// Source times come from run.json / x-*.json marks (seconds into each recording, 1920x1080 coords).
const mcCards = mc.marks.filter((m) => m.name === "card") as unknown as { t: number; chain: string; vaa: Box | null }[];
const mcStart = mc.marks.find((m) => m.name === "start")!.t;
const SEGS: Seg[] = [
  { key: "hero", chapter: "The problem", src: "run.mp4", from: 6, to: 15.4, min: 14,
    callouts: [{ at: 9.5, dur: 5, box: { x: 1591, y: 271, w: 264, h: 156 }, label: "834 of 4,121 UMA disputes" }] },
  { key: "case", chapter: "A real Panta market", src: "run.mp4", from: 15.4, to: 33.2, min: 16,
    callouts: [{ at: 27.8, dur: 3.6, box: { x: 264, y: 615, w: 150, h: 230 }, label: "God view: 3 jurors hold this market" }] },
  { key: "seat", chapter: "Your seat: juror #6", src: "run.mp4", from: 33.2, to: 38.6 },
  { key: "seat", src: "run.mp4", from: 107.6, to: 113, vo: false },
  { key: "run", chapter: "28 devnet transactions", src: "run.mp4", from: 113, to: 260.6, min: 21 },
  { key: "verdict", chapter: "Verdict", src: "run.mp4", from: 262.9, to: 277.6, min: 17,
    callouts: [
      { at: 264.6, dur: 4.2, box: { x: 1387, y: 230, w: 468, h: 620 }, label: "Saring tally, read from chain", zoom: 1.5 },
      { at: 268.8, dur: 2.8, box: { x: 1416, y: 564, w: 199, h: 91 }, label: "excluded: 3 holders + you", zoom: 1.5 },
    ] },
  { key: "privacy", chapter: "What the chain sees", src: "x-privacy.mp4", from: 17.6, to: 26.4, min: 8 },
  { key: "explorer", chapter: "Solana Explorer", src: "x-explorer.mp4", from: 7.5, to: 14, min: 6 },
  { key: "multichain", chapter: "Multichain, read live", src: "x-multichain.mp4", from: mcStart, to: mcStart + 31,
    callouts: mcCards.filter((c) => c.vaa).map((c) => ({ at: c.t + 0.6, dur: 3, box: c.vaa!, label: `${c.chain}: verified via Wormhole VAA` })) },
  { key: "court", chapter: "Public verdict proof", src: "x-court.mp4", from: 10.4, to: 28.5, min: 12 },
];

const voDur = (key: Key) => LINES[key].reduce((s, _l, i) => s + DUR[`${key}_${i}`] + GAP, 0);
// The two "seat" pieces share one pair of voice lines: the first piece carries the audio, the second plays at 1x.
const plan = (() => {
  let t = INTRO;
  return SEGS.map((seg, i) => {
    const srcLen = seg.to - seg.from;
    let len: number;
    if (seg.vo === false) len = srcLen;
    else if (seg.key === "seat") len = voDur("seat") + 0.4 - (SEGS[i + 1].to - SEGS[i + 1].from);
    else len = Math.max(voDur(seg.key) + 0.4, seg.min ?? 0);
    len = Math.max(len, 2);
    const start = t;
    t += len;
    return { seg, start, len, rate: srcLen / len };
  });
})();
const END = plan[plan.length - 1].start + plan[plan.length - 1].len;
export const TOTAL = Math.round((END + OUTRO) * FPS);

const voice: { file: string; cap: string; start: number; len: number }[] = [];
for (const p of plan) {
  if (p.seg.vo === false) continue;
  let t = p.start + 0.2;
  LINES[p.seg.key].forEach(([, cap], i) => {
    const d = DUR[`${p.seg.key}_${i}`];
    voice.push({ file: `vo/${p.seg.key}_${i}.mp3`, cap, start: t, len: d });
    t += d + GAP;
  });
}
voice.push({ file: "vo/outro_0.mp3", cap: LINES.outro[0][1], start: END + 0.3, len: DUR.outro_0 });

const f = (s: number) => Math.round(s * FPS);
const BG = "#0b0816";
const GOLD = "#e8c46a";
const font = "Inter, 'Segoe UI', 'DejaVu Sans', system-ui, sans-serif";
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const Clip = ({ seg, rate }: { seg: Seg; rate: number }) => {
  const frame = useCurrentFrame();
  const tSrc = seg.from + (frame / FPS) * rate;
  // Zoom toward the active callout that asks for it.
  const z = (seg.callouts ?? []).find((c) => c.zoom && tSrc >= c.at - 0.6 && tSrc <= c.at + c.dur + 0.6);
  let scale = 1, ox = 960, oy = 540;
  if (z) {
    const k = Math.min(interpolate(tSrc, [z.at - 0.6, z.at], [0, 1], clamp), interpolate(tSrc, [z.at + z.dur, z.at + z.dur + 0.6], [1, 0], clamp));
    scale = 1 + (z.zoom! - 1) * k;
    ox = z.box.x + z.box.w / 2;
    oy = z.box.y + z.box.h / 2;
  }
  const map = (x: number, y: number) => ({ x: ox + (x - ox) * scale, y: oy + (y - oy) * scale });
  const fadeIn = interpolate(frame, [0, 8], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ backgroundColor: BG, opacity: fadeIn }}>
      <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: `${ox}px ${oy}px` }}>
        <OffthreadVideo src={staticFile(seg.src)} startFrom={f(seg.from)} playbackRate={rate} muted />
      </AbsoluteFill>
      {(seg.callouts ?? []).map((c, i) => {
        if (tSrc < c.at || tSrc > c.at + c.dur) return null;
        const a = interpolate(tSrc, [c.at, c.at + 0.3, c.at + c.dur - 0.3, c.at + c.dur], [0, 1, 1, 0], clamp);
        const p = map(c.box.x, c.box.y);
        const w = c.box.w * scale, h = c.box.h * scale;
        const below = p.y + h + 80 < 900;
        return (
          <div key={i} style={{ opacity: a }}>
            <div style={{ position: "absolute", left: p.x - 8, top: p.y - 8, width: w + 16, height: h + 16,
              border: `4px solid ${GOLD}`, borderRadius: 14, boxShadow: `0 0 0 9999px rgba(11,8,22,0.35), 0 0 30px ${GOLD}` }} />
            <div style={{ position: "absolute", left: Math.min(Math.max(p.x - 8, 20), 1920 - 700), top: below ? p.y + h + 18 : Math.max(p.y - 70, 100),
              background: GOLD, color: "#1a1206", font: `700 30px ${font}`, padding: "8px 18px", borderRadius: 10, whiteSpace: "nowrap" }}>
              {c.label}
            </div>
          </div>
        );
      })}
      {rate > 1.5 && (
        <div style={{ position: "absolute", right: 48, top: 40, background: GOLD, color: "#1a1206",
          font: `800 46px ${font}`, padding: "6px 22px", borderRadius: 12 }}>
          ▶▶ {Math.round(rate)}x
        </div>
      )}
    </AbsoluteFill>
  );
};

const Chapter = ({ n, title }: { n: number; title: string }) => {
  const frame = useCurrentFrame();
  const big = interpolate(frame, [0, 8, 40, 54], [0, 1, 1, 0], clamp);
  return (
    <>
      <div style={{ position: "absolute", left: 48, top: 40, background: "rgba(11,8,22,0.85)", border: "1px solid rgba(255,255,255,0.18)",
        color: "#fff", font: `600 28px ${font}`, padding: "8px 18px", borderRadius: 10 }}>
        <span style={{ color: GOLD }}>{String(n).padStart(2, "0")}</span>&nbsp; {title}
      </div>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: big }}>
        <div style={{ background: "rgba(11,8,22,0.9)", padding: "26px 56px", borderRadius: 20, border: `2px solid ${GOLD}`,
          color: "#fff", font: `800 72px ${font}`, transform: `scale(${0.94 + 0.06 * big})` }}>
          {title}
        </div>
      </AbsoluteFill>
    </>
  );
};

const Caption = ({ text, len }: { text: string; len: number }) => {
  const frame = useCurrentFrame();
  const a = interpolate(frame, [0, 5, f(len) - 5, f(len)], [0, 1, 1, 0], clamp);
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 56, opacity: a }}>
      <div style={{ maxWidth: 1500, background: "rgba(11,8,22,0.88)", borderLeft: `6px solid ${GOLD}`, color: "#fff",
        font: `600 40px/1.3 ${font}`, padding: "16px 30px", borderRadius: 12, textAlign: "center" }}>
        {text}
      </div>
    </AbsoluteFill>
  );
};

const Card = ({ sub, outro }: { sub: string; outro?: boolean }) => {
  const frame = useCurrentFrame();
  const a = interpolate(frame, [0, 12], [0, 1], clamp);
  const s = interpolate(frame, [0, 110], [0.9, 1], clamp);
  return (
    <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 40%, #2a1a4a, ${BG} 70%)`, justifyContent: "center", alignItems: "center", opacity: a }}>
      <Img src={staticFile("logo.png")} style={{ width: 300, height: 300, objectFit: "cover", borderRadius: "50%", boxShadow: "0 0 60px rgba(160,140,255,0.35)", transform: `scale(${s})` }} />
      <div style={{ color: "#fff", font: `800 88px ${font}`, marginTop: 18 }}>Saring</div>
      <div style={{ color: "#cfc6e6", font: `500 36px ${font}`, marginTop: 8 }}>
        {outro ? "Disputes decided by people with no stake in the outcome" : "A jury that can't rule on markets it bet on"}
      </div>
      <div style={{ color: GOLD, font: `600 34px ${font}`, marginTop: 30 }}>saring-silk.vercel.app · github.com/PugarHuda/saring</div>
      <div style={{ color: "#8f86a8", font: `500 26px ${font}`, marginTop: 14 }}>{sub}</div>
    </AbsoluteFill>
  );
};

export const Demo = () => {
  let ch = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      <Sequence durationInFrames={f(INTRO)}>
        <Card sub="Screen recordings of the live product · Solana devnet + Arcium MPC" />
      </Sequence>
      {plan.map((p, i) => (
        <Sequence key={i} from={f(p.start)} durationInFrames={f(p.len) + 1}>
          <Clip seg={p.seg} rate={p.rate} />
          {p.seg.chapter && <Chapter n={++ch} title={p.seg.chapter} />}
        </Sequence>
      ))}
      <Sequence from={f(END)}>
        <Card sub="Data: pugarhuda.github.io/saring" outro />
      </Sequence>
      {voice.map((v, i) => (
        <Sequence key={i} from={f(v.start)} durationInFrames={f(v.len) + 6}>
          <Audio src={staticFile(v.file)} />
          <Caption text={v.cap} len={v.len + 0.2} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
