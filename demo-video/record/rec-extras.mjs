// Records the short clips for the Remotion demo: node recording/rec-extras.mjs <multichain|explorer|court> [arg]
// -> recording/out2/x-<clip>.webm + x-<clip>.json (marks with element boxes in video pixels).
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readdirSync, renameSync, statSync, readFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/pc/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core");
const clip = process.argv[2];
const OUT = path.resolve("recording/out2", "tmp-" + clip);
mkdirSync(OUT, { recursive: true });
const DSF = 1.2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t0;
const marks = [];
const mark = (name, extra = {}) => { marks.push({ name, t: (Date.now() - t0) / 1000, ...extra }); console.log(`${marks.at(-1).t.toFixed(1)}s ${name}`); };
const box = async (loc) => { const b = await loc.boundingBox().catch(() => null); return b && { x: b.x * DSF, y: b.y * DSF, w: b.width * DSF, h: b.height * DSF }; };

const browser = await chromium.launch({ headless: true,
  executablePath: "C:/Users/pc/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe",
  args: ["--use-gl=angle", "--enable-gpu-rasterization"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: DSF,
  recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } } });
const page = await context.newPage();
t0 = Date.now();
const tick = async () => {
  await page.addStyleTag({ content: "@keyframes rec{to{opacity:.99}} #rec-tick{position:fixed;left:0;top:0;width:1px;height:1px;animation:rec .1s infinite alternate;z-index:-1}" }).catch(() => {});
  await page.evaluate(() => { const d = document.createElement("div"); d.id = "rec-tick"; document.body.appendChild(d); }).catch(() => {});
};
const center = (loc) => loc.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));

if (clip === "multichain") {
  await page.goto("https://saring-silk.vercel.app/#multichain", { waitUntil: "networkidle" });
  await tick();
  await page.locator("#multichain").evaluate((el) => el.scrollIntoView());
  await page.waitForFunction(() => {
    const s = [...document.querySelectorAll("#multichain .live-status")];
    return s.length && s.every((x) => !/loading|reading|connect/i.test(x.textContent));
  }, null, { timeout: 90_000 }).catch(() => console.log("some cards still loading"));
  await page.locator("#multichain").evaluate((el) => el.scrollIntoView());
  await sleep(500);
  mark("start");
  await sleep(4000);
  const cards = page.locator("#multichain .chain-card");
  const n = await cards.count();
  for (let i = 0; i < n; i++) {
    const c = cards.nth(i);
    await center(c);
    await sleep(1200);
    const vaa = c.getByText("verified via Wormhole VAA").first();
    mark("card", { chain: await c.locator("h3").innerText(), box: await box(c), vaa: (await vaa.count()) ? await box(vaa) : null,
      rows: await c.locator("dt").allInnerTexts() });
    await sleep(3300);
  }
  mark("end");
} else if (clip === "explorer") {
  await page.goto(process.argv[3], { waitUntil: "domcontentloaded" });
  await tick();
  mark("start");
  await sleep(9000);
  await page.mouse.wheel(0, 500);
  await sleep(6000);
  mark("end");
} else if (clip === "privacy") {
  await page.goto("https://saring-silk.vercel.app/", { waitUntil: "networkidle" });
  await tick();
  // multichain cards above it grow as their reads land: keep re-anchoring until the layout settles.
  for (let i = 0; i < 12; i++) { await page.locator("#privacy").evaluate((el) => el.scrollIntoView()); await sleep(1000); }
  mark("start");
  await sleep(5000);
  await page.mouse.wheel(0, 350);
  await sleep(4000);
  mark("end");
} else if (clip === "court") {
  await page.goto("https://pugarhuda.github.io/saring/court.html" + (process.argv[3] ? "?c=" + process.argv[3] : ""), { waitUntil: "networkidle" });
  await tick();
  mark("start");
  await sleep(3000);
  if (!process.argv[3]) { await page.locator('a[href*="?c="]').first().click(); await page.waitForLoadState("networkidle"); await tick(); mark("court"); }
  await sleep(6000);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 300); await sleep(2000); }
  mark("end");
}
await context.close();
await browser.close();
const v = readdirSync(OUT).filter((f) => f.endsWith(".webm")).map((f) => path.join(OUT, f)).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).at(-1);
renameSync(v, path.resolve("recording/out2", `x-${clip}.webm`));
writeFileSync(path.resolve("recording/out2", `x-${clip}.json`), JSON.stringify({ url: page.url(), marks }, null, 2));
console.log("saved", clip);
