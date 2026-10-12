// Vercel function: read-only proxy to the Panta REST API (https://docs.panta.market)
// so the PANTA_API_KEY stays server-side. Only the catalog, market detail, trade
// tape and per-wallet positions are forwarded; responses are cached briefly.
const BASE = "https://live-api.panta.market/api/v1";
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TIMEOUT_MS = 15_000;

/** Maps the query to an allowed upstream path, or null. */
function upstreamPath(q) {
  switch (q.op) {
    case "markets": {
      const p = new URLSearchParams({ limit: String(Math.min(Number(q.limit) || 50, 50)) });
      if (["primary", "secondary", "resolved", "cancelled"].includes(q.status)) p.set("status", q.status);
      if (typeof q.cursor === "string" && q.cursor.length < 400) p.set("cursor", q.cursor);
      return `/markets/?${p}`;
    }
    case "market":
      return B58.test(q.id ?? "") ? `/markets/${q.id}/` : null;
    case "trades":
      return B58.test(q.id ?? "") ? `/markets/${q.id}/trades/?limit=${Math.min(Number(q.limit) || 50, 200)}` : null;
    case "positions":
      return B58.test(q.wallet ?? "") ? `/positions/?wallet=${q.wallet}` : null;
    default:
      return null;
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
    const key = process.env.PANTA_API_KEY;
    if (!key) return res.status(500).json({ error: "Panta API not configured" });
    const path = upstreamPath(req.query);
    if (!path) return res.status(400).json({ error: "unsupported query" });
    const r = await fetch(BASE + path, { headers: { "X-Api-Key": key }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
    res.status(r.status).setHeader("Content-Type", "application/json").send(await r.text());
  } catch (e) {
    res.status(502).json({ error: e.name === "TimeoutError" ? "Panta API timeout" : "Panta API unavailable" });
  }
}
