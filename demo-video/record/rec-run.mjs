// Records one real dispute run on the production site for the Remotion demo (demo-video/).
// Run from the repo root folder: node recording/rec-run.mjs  -> recording/out2/run.webm + run.json
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/pc/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core");
const URL = process.env.SARING_URL ?? "https://saring-silk.vercel.app";
const OUT = path.resolve("recording/out2");
mkdirSync(OUT, { recursive: true });
let t0 = Date.now();
const marks = [];
const mark = (name, extra = {}) => { marks.push({ name, t: (Date.now() - t0) / 1000, ...extra }); console.log(`${marks.at(-1).t.toFixed(1)}s ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fundBurner(address) {
  const script = `export PATH=$HOME/.local/share/solana/install/active_release/bin:$PATH; cd ~/blindcourt; set -a; . ./.env.local; set +a; solana transfer ${address} 0.2 --allow-unfunded-recipient -u "$RPC_URL" >/dev/null && echo funded`;
  writeFileSync("C:/Users/pc/AppData/Local/Temp/fund.sh", script);
  return execFileSync("wsl", ["-d", "Ubuntu", "--", "bash", "-l", "/mnt/c/Users/pc/AppData/Local/Temp/fund.sh"], { env: { ...process.env, MSYS_NO_PATHCONV: "1" } }).toString().trim();
}

const browser = await chromium.launch({ headless: true,
  executablePath: "C:/Users/pc/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe",
  args: ["--use-gl=angle", "--enable-gpu-rasterization"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2,
  recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } } });
const page = await context.newPage();
t0 = Date.now();
const smoothTo = async (sel, block = "start", wait = 1500) => {
  await page.evaluate(([s, b]) => document.querySelector(s)?.scrollIntoView({ behavior: "smooth", block: b }), [sel, block]);
  await sleep(wait);
};
await page.goto(URL, { waitUntil: "networkidle" });
await page.addStyleTag({ content: "@keyframes rec{to{opacity:.99}} #rec-tick{position:fixed;left:0;top:0;width:1px;height:1px;animation:rec .1s infinite alternate;z-index:-1}" });
await page.evaluate(() => { const d = document.createElement("div"); d.id = "rec-tick"; document.body.appendChild(d); });
mark("hero");
await sleep(6000);
await page.mouse.wheel(0, 450);
await sleep(3500);
mark("case");
await smoothTo("#case");
await page.getByRole("button", { name: /God view/ }).waitFor({ timeout: 90_000 });
await sleep(5000);
await page.mouse.wheel(0, 500);
await sleep(5000);
mark("godview");
await page.getByRole("button", { name: /God view/ }).click();
await sleep(5000);
await page.getByRole("button", { name: /God view/ }).click();
await sleep(1000);

mark("seat");
await smoothTo("#run");
await page.getByText("Run the dispute", { exact: true }).waitFor({ timeout: 90_000 }).catch(() => {});
await page.getByRole("radiogroup", { name: "Your vote" }).getByRole("radio", { name: "NO", exact: true }).check();
await sleep(1500);
await page.getByRole("radiogroup", { name: /Also bet/ }).getByRole("radio", { name: "NO", exact: true }).check();
await sleep(2500);
const address = (await page.locator('[aria-label="Burner wallet"] code').innerText()).trim();
mark("faucet");
const fb = page.getByRole("button", { name: "Get devnet SOL" });
let funded = false;
if (await fb.isEnabled()) {
  await fb.click();
  for (let i = 0; i < 30 && !funded; i++) {
    await sleep(2000);
    const b = await page.locator('[aria-label="Burner wallet"] .balance strong').innerText();
    funded = parseFloat(b) >= 0.11;
  }
}
if (!funded) { console.log("faucet failed, funding from dev wallet:", fundBurner(address)); await page.getByRole("button", { name: "Refresh" }).click(); }
mark("funded", { viaFaucet: funded });
await sleep(3000);
const runBtn = page.getByRole("button", { name: "Run the dispute" });
await runBtn.waitFor({ state: "visible" });
await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent === "Run the dispute" && !b.disabled), null, { timeout: 60_000 });
await runBtn.click();
mark("run_start");

const bar = page.getByRole("progressbar", { name: "Steps finalized" });
let last = -1;
for (;;) {
  const done = Number(await bar.getAttribute("aria-valuenow"));
  const max = Number(await bar.getAttribute("aria-valuemax"));
  if (done !== last) {
    last = done;
    mark(`step_${done}`);
    await page.evaluate(() => {
      const items = [...document.querySelectorAll("#run ol.timeline > li")];
      const live = items.find((li) => !/Finalized|Confirmed/.test(li.textContent ?? "")) ?? items.at(-1);
      live?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }
  if (max && done >= max) break;
  if (await page.getByRole("button", { name: "Retry from the failed step" }).isVisible()) {
    mark("retry"); await page.getByRole("button", { name: "Retry from the failed step" }).click();
  }
  if (Date.now() - t0 > 25 * 60_000) throw new Error("run did not finish in 25 minutes");
  await sleep(1000);
}
mark("run_end");
await sleep(2500);
mark("verdict");
await smoothTo(".verdict.blind", "center", 9000);
mark("settle");
await page.mouse.wheel(0, 500);
await sleep(6000);
mark("privacy");
await smoothTo("#privacy", "start", 7000);
mark("end");
const txs = await page.evaluate(() => [...document.querySelectorAll("#run ol.timeline a")].map((a) => ({ text: a.textContent, href: a.href })));
const court = await page.evaluate(() => [...document.querySelectorAll("a")].find((a) => /Court account/.test(a.textContent))?.href);
await context.close();
await browser.close();
const video = readdirSync(OUT).filter((f) => f.endsWith(".webm") && !["run.webm"].includes(f) && !f.startsWith("x-"))
  .map((f) => path.join(OUT, f)).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).at(-1);
renameSync(video, path.join(OUT, "run.webm"));
writeFileSync(path.join(OUT, "run.json"), JSON.stringify({ address, court, marks, txs }, null, 2));
console.log("saved recording/out2/run.webm");
