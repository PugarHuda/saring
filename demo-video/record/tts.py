# tts.py lines.json outdir  -> outdir/<seg>_<i>.mp3 + outdir/durations.json
import json, subprocess, sys, os
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
segs = json.load(open(src, encoding="utf-8"))
dur = {}
for seg, lines in segs.items():
    for i, (say, _cap) in enumerate(lines):
        f = f"{out}/{seg}_{i}.mp3"
        for attempt in range(5):
            if os.path.exists(f) and os.path.getsize(f) > 1000:
                break
            subprocess.run(["edge-tts", "--voice", "en-US-AndrewNeural", "--rate=+4%", "--text", say, "--write-media", f])
        d = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], capture_output=True, text=True).stdout
        dur[f"{seg}_{i}"] = float(d)
json.dump(dur, open(f"{out}/durations.json", "w"), indent=1)
print(sum(dur.values()))
