/**
 * Pay-per-court over MPP (Machine Payments Protocol, mpp.dev) on Tempo Moderato.
 * POST /courts {"question": "..."}:
 *   no payment  -> 402 + WWW-Authenticate: Payment challenge (0.50 pathUSD to the Saring operator)
 *   paid retry  -> mppx verifies/broadcasts the TIP-20 transfer on Tempo, then the server opens a
 *                  real Saring court on Solana devnet (Arcium MPC init) and returns it with a Payment-Receipt.
 *
 *   MPP_SECRET_KEY=$(openssl rand -hex 32) npx tsx mpp-server.ts
 * Needs ~/.config/solana/id.json (devnet SOL) and RPC_URL (read from ~/blindcourt/.env.local).
 */
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Receipt } from "mppx";
import { Mppx, NodeListener, tempo } from "mppx/server";
import { SaringClient } from "../sdk/src";
import { PATH_USD, logger, saveState, solana, state, tempoClient } from "./lib";

const PORT = Number(process.env.PORT ?? 8787);
const PRICE = "0.50"; // pathUSD per court
const log = logger("mpp-server");

if (!process.env.MPP_SECRET_KEY) throw new Error("set MPP_SECRET_KEY (openssl rand -hex 32)");
const operator = tempoClient("operator").account.address;
const mppx = Mppx.create({
  methods: [tempo.charge({ currencies: [PATH_USD], recipient: operator, testnet: true })],
  secretKey: process.env.MPP_SECRET_KEY,
  realm: "saring-courts",
});

const sol = solana();
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8"))));
const saring = new SaringClient(sol, authority);

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "POST" || req.url !== "/courts") {
      res.writeHead(404).end();
      return;
    }
    const body = await readBody(req);
    let question: unknown;
    try {
      question = JSON.parse(body).question;
    } catch {}
    // Validate before charging: never take money for a request we will reject.
    if (typeof question !== "string" || !question || Buffer.byteLength(question) > 64) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "question: 1..64 UTF-8 bytes" }));
      return;
    }
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: "POST", headers: req.headers as any, body });
    const result = await mppx.charge({ amount: PRICE, description: `Open a Saring court: ${question}` })(request);
    if (result.status === 402) {
      log(`402 challenge issued for "${question}"`);
      return NodeListener.sendResponse(res, result.challenge);
    }

    // Paid. Open the court on Solana devnet.
    const bal = await sol.getBalance(authority.publicKey);
    if (bal < 0.02 * LAMPORTS_PER_SOL) throw new Error(`authority low on devnet SOL (${bal / LAMPORTS_PER_SOL})`);
    log(`payment verified; opening court for "${question}" (authority ${authority.publicKey.toBase58()}, ${bal / LAMPORTS_PER_SOL} SOL)`);
    const opened = await saring.openCourt(question);
    const out = { court: opened.court.toBase58(), courtId: opened.courtId, queueSig: opened.queueSig, callbackSig: opened.callbackSig };
    const response = result.withReceipt(Response.json(out));
    const paymentTx = Receipt.fromResponse(response).reference; // the Tempo tx that paid for this court
    log(`court opened ${out.court} (id ${out.courtId}) queue ${out.queueSig} callback ${out.callbackSig}; paid by Tempo tx ${paymentTx}`);
    saveState({ mppCourts: [...(state().mppCourts ?? []), { question, paymentTx, ...out }] });
    return NodeListener.sendResponse(res, response);
  } catch (e: any) {
    log(`error: ${e?.message ?? e}`);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e?.message ?? e) }));
  }
});

server.listen(PORT, () => log(`MPP court endpoint on http://localhost:${PORT}/courts, price ${PRICE} pathUSD -> ${operator}`));
