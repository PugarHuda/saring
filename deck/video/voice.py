# Generates one edge-tts clip + subtitle file per scene, then writes src/scenes.json with durations.
# Run: python voice.py   (needs edge-tts and ffprobe on PATH)
import json, subprocess, re, sys
RATE = sys.argv[1] if len(sys.argv) > 1 else "+4%"
SCENES = [
  ("s01", "Would you let a judge rule on a case they had money on? In crypto prediction markets it happens constantly, and nothing stops it."),
  ("s02", "I pulled every UMA vote on Polymarket disputes since January 2025: 4,121 disputes. In one out of five, someone voting held a position in that exact market. Above a million dollars of volume, it's two out of three. Removing them flips zero outcomes. The problem: no resolver even checks, and these numbers are a floor."),
  ("s03", "Why not filter them? Because the obvious fix leaks. Publish the jury and bribers know whom to pay. Publish positions and you dox traders."),
  ("s04", "Saring does the match inside Arcium's MPC network on Solana. Conflicted jurors are dropped silently."),
  ("s06", "The chain sees the tally and how many were excluded, never who."),
  ("s05", "This is a real Panta market on Solana. I read its 42 holders from mainnet and mirror them, encrypted, into a court on devnet. Three conflicted jurors vote YES. A bribed juror hands over his ballot key, then votes NO and rotates it. The briber's ballot is ignored, and he can't tell. Juror six is me: I vote NO and bet NO, so MPC drops my own ballot too. Saring rules NO. A plain jury would have said YES, and the market pays out."),
  ("s07", "The verdict travels as a Wormhole message: Tempo pays per court, Zcash shields juror bonds, Ethereum logs verify the data, and it arbitrates UMA on Arbitrum and Reality.eth on Base."),
  ("s11", "I'm Pugar Huda Mantoro, an Informatics student at Universitas Islam Indonesia, building solo. I measured the problem before I built the fix. It's open source and live on devnet, and you can sit on the jury yourself. If you run a Solana prediction market, give me one market to pilot."),
]
def secs(t):
    h, m, s = t.replace(",", ".").split(":"); return int(h) * 3600 + int(m) * 60 + float(s)
out = []
for sid, text in SCENES:
    mp3, srt = f"public/vo/{sid}.mp3", f"public/vo/{sid}.srt"
    for attempt in range(4):  # edge-tts sometimes drops a request; retry
        r = subprocess.run(["edge-tts", "--voice", "en-US-AndrewNeural", f"--rate={RATE}", "--text", text,
                            "--write-media", mp3, "--write-subtitles", srt])
        if r.returncode == 0: break
    else: raise SystemExit(f"edge-tts failed for {sid}")
    dur = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3]).decode())
    cues = []
    for block in open(srt, encoding="utf8").read().strip().split("\n\n"):
        lines = block.strip().splitlines()
        m = re.match(r"(\S+) --> (\S+)", lines[1])
        cues.append({"from": secs(m[1]), "to": secs(m[2]), "text": " ".join(lines[2:])})
    out.append({"id": sid, "audio": f"vo/{sid}.mp3", "dur": dur, "cues": cues})
    print(sid, round(dur, 2), len(cues))
json.dump(out, open("src/scenes.json", "w", encoding="utf8"), indent=1)
print("total", round(sum(s["dur"] for s in out), 2))
