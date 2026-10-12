// Panta REST API (https://docs.panta.market) through our server proxy (app/api/panta.js),
// which holds the API key. Used for market discovery and details, and to cross-check
// juror positions against what we read from Panta's program on chain.

export interface PantaMarket {
  marketId: string;
  title: string;
  category: string | null;
  phase: string;
  status: string;
  resolved: boolean;
  volumeUsdc: number | null;
  resolutionTime: number | null;
  yesPrice?: number | null;
  noPrice?: number | null;
  oracle?: string | null;
  sentToUma?: boolean | null;
  quoteAsset?: string;
}

export interface PantaPosition {
  marketId: string;
  side: "yes" | "no";
  shares: string;
  phase: string;
  outcome: string | null;
}

async function get<T>(params: Record<string, string>): Promise<T> {
  const r = await fetch(`/api/panta?${new URLSearchParams(params)}`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error ?? body?.code ?? `Panta API ${r.status}`);
  return body as T;
}

/** Most recent markets in Panta's USDC catalog (up to `pages` × 50). */
export async function listMarkets(pages = 2): Promise<PantaMarket[]> {
  const out: PantaMarket[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < pages; i++) {
    const page = await get<{ items: PantaMarket[]; nextCursor?: string | null }>({ op: "markets", limit: "50", ...(cursor ? { cursor } : {}) });
    out.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

export const marketDetail = (id: string) => get<PantaMarket>({ op: "market", id });

/** What Panta's indexer reports for a wallet; compared against the on-chain read. */
export const walletPositions = (wallet: string) =>
  get<{ wallet: string; positions: PantaPosition[] }>({ op: "positions", wallet });
