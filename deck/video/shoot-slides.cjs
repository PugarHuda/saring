const { chromium } = require(process.env.PW_CORE ?? "playwright-core");
// Screenshots each deck slide at 1920x1080 into public/slides for the video.
// Run from deck/video: node shoot-slides.cjs [deck url] (needs playwright-core; set PW_CORE and CHROME if not default)
const url = process.argv[2] ?? "https://saring-deck.vercel.app/", out = "public/slides";
(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2 });
  for (let n = 1; n <= 11; n++) {
    await p.goto(`${url}?video#${n}`, { waitUntil: "networkidle" });
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(800);
    await p.screenshot({ path: `${out}/s${String(n).padStart(2, "0")}.png` });
  }
  const m = await b.newPage({ viewport: { width: 390, height: 844 } });
  await m.goto(url, { waitUntil: "networkidle" });
  await m.screenshot({ path: `${out}/mobile.png`, fullPage: false });
  const w = await m.evaluate(() => document.documentElement.scrollWidth);
  console.log("mobile scrollWidth", w);
  await b.close();
})();
