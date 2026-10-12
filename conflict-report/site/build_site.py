"""Build site/index.html from out/*.json. Run: PYTHONIOENCODING=utf-8 python site/build_site.py"""
import csv, html, json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
summary = json.loads((OUT / "summary.json").read_text(encoding="utf-8"))
cases = json.loads((OUT / "case_studies.json").read_text(encoding="utf-8"))
slugs = {d["request_id"]: d["slug"] for d in csv.DictReader(open(OUT / "disputes.csv", encoding="utf-8"))}
conflicts = list(csv.DictReader(open(OUT / "conflicts.csv", encoding="utf-8")))

ETH, POLY, PM = "https://etherscan.io/address/", "https://polygonscan.com/address/", "https://polymarket.com/market/"
e = html.escape


def short(a):
    return f"{a[:6]}…{a[-4:]}"


def money(x):
    x = float(x)
    return f"${x/1e6:.2f}M" if x >= 1e6 else f"${x/1e3:.0f}K" if x >= 1e3 else f"${x:,.0f}"


def holding(js):
    return ", ".join(f"{float(v):,.0f} {k}" for k, v in json.loads(js).items())


def mlink(rid, text):
    s = slugs.get(rid)
    return f'<a href="{PM}{e(s)}" rel="noopener">{e(text)}</a>' if s else e(text)


# ponytail: top 50 by position cost; full set lives in out/conflicts.csv
top = sorted(conflicts, key=lambda r: -float(r["net_cost_usdc"]))[:50]
rows = [{
    "m": r["market"], "slug": slugs.get(r["request_id"]), "d": r["vote_time_utc"], "v": r["voter"],
    "w": r["polymarket_wallet"], "h": holding(r["held_shares_at_vote"]), "vf": r["voted_for"],
    "c": round(float(r["net_cost_usdc"]), 2), "own": r["voted_own_side"] == "True",
    "uma": round(float(r["vote_tokens_UMA"]), 2),
} for r in top]

S = summary
pct_linked = S["voters_linked_to_polymarket_wallet"] / S["unique_voters"] * 100
n_big_conf = round(S["disputes_market_volume_ge_1M"] * S["pct_of_those_with_conflicted_voter"] / 100)

case_html = []
for c in cases:
    vol = f"{money(c['market_volume_usd'])} volume" if c["market_volume_usd"] else "volume n/a"
    case_html.append(f"""<article class="case">
  <h3>{mlink(c['request_id'], c['market'])}</h3>
  <p class="meta">Vote {e(c['vote_time_utc'])} · {vol}</p>
  <dl>
    <dt>Voter (UMA, Ethereum)</dt><dd><a href="{ETH}{e(c['voter'])}" rel="noopener"><code>{e(short(c['voter']))}</code></a></dd>
    <dt>Polymarket Safe (Polygon)</dt><dd><a href="{POLY}{e(c['polymarket_wallet'])}" rel="noopener"><code>{e(short(c['polymarket_wallet']))}</code></a></dd>
    <dt>Held at vote</dt><dd>{e(holding(c['held_shares_at_vote']))} shares <span class="muted">(cost ≈ {money(c['net_cost_usdc'])})</span></dd>
    <dt>Voted</dt><dd><strong>{e(c['voted_for'])}</strong> {'<span class="tag warn">own side</span>' if c['voted_own_side'] else '<span class="tag">other side</span>'}{' <span class="tag">redeemed after</span>' if c['redeemed_after'] else ''}</dd>
  </dl>
</article>""")

data_json = json.dumps({"rows": rows}, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")

page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UMA Conflict Report</title>
<meta name="description" content="How often UMA voters resolving Polymarket disputes held a position in the market they were judging. A Saring research note.">
<style>
:root {{
  --bg:#fbfaf7; --surface:#ffffff; --ink:#16181d; --muted:#565b66; --rule:#dcd9d2;
  --accent:#b3261e; --accent-soft:#f6e3e1; --link:#1a4fa3; --ok:#1d6b3f; --bar:#d8d4cc;
  --serif: Georgia, "Iowan Old Style", "Times New Roman", serif;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, "SFMono-Regular", Consolas, monospace;
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
    --bg:#121417; --surface:#1a1d22; --ink:#ecebe8; --muted:#a3a7b0; --rule:#2e323a;
    --accent:#ff8a80; --accent-soft:#3a1f1f; --link:#8ab4ff; --ok:#7fd6a2; --bar:#3a3f48;
  }}
}}
:root[data-theme="dark"] {{
  --bg:#121417; --surface:#1a1d22; --ink:#ecebe8; --muted:#a3a7b0; --rule:#2e323a;
  --accent:#ff8a80; --accent-soft:#3a1f1f; --link:#8ab4ff; --ok:#7fd6a2; --bar:#3a3f48;
}}
* {{ box-sizing:border-box; }}
html {{ -webkit-text-size-adjust:100%; }}
body {{ margin:0; background:var(--bg); color:var(--ink); font:17px/1.6 var(--serif); }}
main {{ max-width:860px; margin:0 auto; padding:0 16px 64px; }}
a {{ color:var(--link); text-underline-offset:2px; }}
a:focus-visible, button:focus-visible {{ outline:2px solid var(--link); outline-offset:2px; }}
code {{ font:0.88em var(--mono); }}
h1,h2,h3 {{ font-family:var(--sans); line-height:1.2; letter-spacing:-0.01em; }}
h1 {{ font-size:clamp(2rem,6vw,3.1rem); margin:0 0 12px; }}
h2 {{ font-size:1.5rem; margin:56px 0 12px; padding-top:16px; border-top:2px solid var(--ink); }}
h3 {{ font-size:1.05rem; margin:0 0 4px; }}
.kicker {{ font:600 0.8rem/1 var(--sans); text-transform:uppercase; letter-spacing:0.12em; color:var(--accent); margin:40px 0 12px; }}
.dek {{ font-size:1.2rem; color:var(--muted); margin:0 0 8px; }}
.byline {{ font:0.85rem var(--sans); color:var(--muted); }}
.muted {{ color:var(--muted); }}
.stats {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr)); gap:1px; background:var(--rule); border:1px solid var(--rule); margin:32px 0; }}
.stat {{ background:var(--surface); padding:20px; }}
.stat .n {{ font:700 2.4rem/1 var(--sans); color:var(--accent); font-variant-numeric:tabular-nums; }}
.stat .l {{ font:0.92rem/1.4 var(--sans); margin-top:8px; }}
.stat .s {{ font:0.8rem var(--sans); color:var(--muted); margin-top:4px; }}
.callout {{ background:var(--accent-soft); border-left:4px solid var(--accent); padding:16px 20px; margin:24px 0; font-family:var(--sans); font-size:0.98rem; }}
.callout.ok {{ border-color:var(--ok); background:var(--surface); }}
.bars {{ font-family:var(--sans); margin:24px 0; }}
.bars .row {{ margin:12px 0; }}
.bars .lab {{ font-size:0.9rem; display:flex; justify-content:space-between; gap:12px; }}
.bars .track {{ height:14px; background:var(--bar); margin-top:4px; }}
.bars .fill {{ height:100%; background:var(--accent); }}
ol.method li {{ margin-bottom:10px; }}
.cases {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr)); gap:16px; }}
.case {{ background:var(--surface); border:1px solid var(--rule); padding:16px; font-family:var(--sans); font-size:0.9rem; min-width:0; }}
.case .meta {{ color:var(--muted); margin:0 0 10px; font-size:0.82rem; }}
.case dl {{ display:grid; grid-template-columns:auto 1fr; gap:4px 12px; margin:0; }}
.case dt {{ color:var(--muted); }}
.case dd {{ margin:0; overflow-wrap:anywhere; }}
.tag {{ display:inline-block; font-size:0.72rem; padding:1px 6px; border:1px solid var(--rule); border-radius:3px; color:var(--muted); white-space:nowrap; }}
.tag.warn {{ border-color:var(--accent); color:var(--accent); }}
.tablewrap {{ overflow-x:auto; border:1px solid var(--rule); background:var(--surface); }}
table {{ border-collapse:collapse; width:100%; font:0.84rem/1.4 var(--sans); }}
th, td {{ text-align:left; padding:8px 10px; border-bottom:1px solid var(--rule); vertical-align:top; }}
th {{ position:sticky; top:0; background:var(--surface); white-space:nowrap; }}
th button {{ all:unset; cursor:pointer; font-weight:600; }}
th button::after {{ content:" ↕"; color:var(--muted); }}
td.num {{ text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }}
td.mk {{ min-width:200px; }}
.steps {{ counter-reset:s; list-style:none; padding:0; display:grid; gap:12px; }}
.steps li {{ background:var(--surface); border:1px solid var(--rule); padding:14px 16px 14px 56px; position:relative; font-family:var(--sans); font-size:0.95rem; }}
.steps li::before {{ counter-increment:s; content:counter(s); position:absolute; left:16px; top:12px; font:700 1.3rem var(--sans); color:var(--accent); }}
footer {{ margin-top:56px; padding-top:16px; border-top:1px solid var(--rule); font:0.82rem var(--sans); color:var(--muted); }}
@media (max-width:600px) {{
  body {{ font-size:16px; }}
  .case dl {{ grid-template-columns:1fr; }}
  .case dt {{ margin-top:6px; }}
  td.mk {{ min-width:160px; }}
}}
</style>
</head>
<body>
<main>
<p class="kicker">Saring research note · UMA × Polymarket</p>
<h1>UMA Conflict Report</h1>
<p class="dek">In one in five Polymarket disputes, at least one UMA voter held a position in the market they were deciding. For markets over $1M, it was two in three. Nothing in the protocol filters them out.</p>
<p class="byline">Window: every resolved UMA DVM <code>YES_OR_NO_QUERY</code> since {e(S['window_start'])}. Generated {e(S['generated_utc'][:10])}.</p>

<section class="stats" aria-label="Headline numbers">
  <div class="stat"><div class="n">{pct_linked:.1f}%</div><div class="l">of UMA voters control an active Polymarket Safe derived from the same address</div><div class="s">{S['voters_linked_to_polymarket_wallet']:,} of {S['unique_voters']:,} voters</div></div>
  <div class="stat"><div class="n">{S['pct_disputes_with_conflicted_voter']:.1f}%</div><div class="l">of Polymarket disputes had a voter holding a position in that market at vote time</div><div class="s">{S['disputes_with_conflicted_voter']:,} of {S['mapped_to_polymarket']:,} disputes</div></div>
  <div class="stat"><div class="n">{S['pct_of_those_with_conflicted_voter']:.1f}%</div><div class="l">of disputes on markets with ≥ $1M volume had a conflicted voter</div><div class="s">{n_big_conf:,} of {S['disputes_market_volume_ge_1M']:,} disputes</div></div>
  <div class="stat"><div class="n">{money(S['total_conflicted_position_cost_usdc'])}</div><div class="l">in positions held by conflicted voters while they voted</div><div class="s">{S['unique_conflicted_voters']:,} voters · {S['conflicted_vote_rows']:,} conflicted votes</div></div>
</section>

<div class="bars" role="img" aria-label="Share of disputes with a conflicted voter: {S['pct_disputes_with_conflicted_voter']:.1f}% overall, {S['pct_of_those_with_conflicted_voter']:.1f}% for markets at or above $1M volume">
  <div class="row"><div class="lab"><span>All mapped disputes</span><strong>{S['pct_disputes_with_conflicted_voter']:.1f}%</strong></div><div class="track"><div class="fill" style="width:{S['pct_disputes_with_conflicted_voter']}%"></div></div></div>
  <div class="row"><div class="lab"><span>Markets ≥ $1M volume</span><strong>{S['pct_of_those_with_conflicted_voter']:.1f}%</strong></div><div class="track"><div class="fill" style="width:{S['pct_of_those_with_conflicted_voter']}%"></div></div></div>
</div>

<div class="callout">
<strong>What this does and does not show.</strong> {S['self_serving_share_of_conflicted_votes']*100:.0f}% of conflicted votes went to the side the voter held. But the detectable conflicted stake is small: {S['conflicted_token_pct_all_disputes']}% of all vote weight, at most {S['max_conflicted_pct']}% in any single dispute. Removing every conflicted voter changes <strong>{S['outcome_flips_if_conflicted_removed']}</strong> outcomes and pushes {S['disputes_falling_below_supermajority_if_removed']} below the 65% supermajority.
The finding is not that outcomes were flipped. It is that conflicted jurors routinely sit on cases, and nothing filters them.
</div>

<h2 id="method">Method</h2>
<ol class="method">
<li><strong>Votes.</strong> Resolved <code>YES_OR_NO_QUERY</code> price requests and their revealed votes (voter, price, tokens) from the final, deciding round, via UMA's public <code>mainnet-voting-v2</code> subgraph.</li>
<li><strong>Question text.</strong> Ancillary data recovered from <code>OracleChildTunnel</code> logs on Polygon and matched by keccak hash.</li>
<li><strong>Market match.</strong> Polymarket <code>questionID = keccak(ancillary data before ",ooRequester:")</code>, looked up on the Gamma API. Accepted only on exact questionID match (2,895) or exact title match (1,198, mostly negRisk). {S['mapped_to_polymarket']:,} of {S['uma_yes_no_requests_resolved']:,} requests mapped.</li>
<li><strong>Voter → wallet.</strong> Each voter's Polymarket Safe address is derived deterministically with CREATE2 from the voter address (Polymarket Safe factory). The derivation was verified on a sample by calling <code>getOwners()</code> on-chain: the Safe's owner is the voting address. A Safe at that address can only be controlled by the key that cast the vote, unless its owners were later changed. Funding-graph heuristics were <em>not</em> used.</li>
<li><strong>Position at vote time.</strong> Polymarket Data API activity (trade, split, merge, redeem) in that market up to the round's last reveal time. A voter is "conflicted" if they held a net ≥ 1 share of any outcome.</li>
<li><strong>Counterfactual.</strong> Vote weight per answer recomputed without conflicted voters; checked for a different winner, the 65% supermajority (SPAT) and the participation threshold (GAT).</li>
</ol>

<h2 id="cases">Case studies</h2>
<p>The largest positions held while voting. The first two were re-checked live on-chain. Voter links go to Etherscan (UMA votes on Ethereum); Safe links go to Polygonscan (Polymarket settles on Polygon).</p>
<div class="cases">
{''.join(case_html)}
</div>
<p class="muted" style="font-family:var(--sans);font-size:0.9rem">Repeat jurors: <code>0x93a6…ced4</code> appears in {sum(1 for r in conflicts if r['voter']=='0x93a692fe5477902c3cf5f6997c1cf59a3712ced4')} conflicted votes. <code>0x86cc…273d</code> appears in {sum(1 for r in conflicts if r['voter']=='0x86cc5e1e8fb20102fa7a0fa4afeaf1cbe1be273d')}, including the US government shutdown dispute where 25 voters were conflicted.</p>

<h2 id="table">Top 50 conflicted votes</h2>
<p>Sorted by cost of the position held at vote time. Click a column header to re-sort. The full set of {S['conflicted_vote_rows']:,} rows is in <code>out/conflicts.csv</code>.</p>
<div class="tablewrap">
<table id="t">
<thead><tr>
<th><button data-k="m">Market</button></th>
<th><button data-k="d">Vote</button></th>
<th>Voter / Safe</th>
<th>Held</th>
<th><button data-k="vf">Voted</button></th>
<th class="num"><button data-k="c">Cost</button></th>
<th class="num"><button data-k="uma">UMA staked</button></th>
</tr></thead>
<tbody></tbody>
</table>
</div>

<h2 id="limits">Limitations</h2>
<ul>
<li><strong>This is a lower bound.</strong> Only the Safe derived from the voting address (and the address itself) is checked. Voters trading from separate wallets, exchanges, email/magic-link accounts or newer deposit wallets are invisible here. Large holders are the most likely to split wallets, so the {S['conflicted_token_pct_all_disputes']}% weight figure is almost certainly an undercount.</li>
<li>Transfers of outcome tokens between wallets and negRisk conversions are not reconstructed.</li>
<li>The Data API caps pagination at about 10,000 events per market chunk; extremely active traders may be truncated.</li>
<li>Gamma volume is zero or missing for some markets. {S['uma_yes_no_requests_resolved'] - S['mapped_to_polymarket']:,} requests could not be mapped to a market.</li>
<li>Voting one's own side is not proof of bad faith. Most conflicted voters also voted with the correct majority.</li>
<li>Some markets have two DVM requests (re-votes), so a voter can appear twice for one market.</li>
</ul>

<h2 id="fix">How Saring fixes this</h2>
<p>Saring is a conflict-blind jury for prediction-market disputes, built on Solana with Arcium multi-party computation. The conflict check happens inside MPC, so the filter never becomes a public list.</p>
<ol class="steps">
<li><strong>Silent exclusion.</strong> Inside Arcium MPC, each juror's ballot is checked against positions in the disputed market. Jurors holding a position are excluded from the tally.</li>
<li><strong>The chain never sees the jury.</strong> Juror ids, trader ids and ballots go on chain only as ciphertexts, and the MPC never reveals which jurors were excluded. (In the current MVP the court authority seats the jurors and relays the positions, so it knows both lists.)</li>
<li><strong>Bribe receipts are worthless.</strong> Each seat has a secret ballot key held inside MPC. A ballot counts only with the seat's current key, and a ballot can rotate the key, so a key handed to a briber after rotation is worthless and the briber can't tell. Forged ballots with guessed keys are ignored inside MPC.</li>
<li><strong>Minimal output.</strong> The only thing revealed is <code>(yes, no, excluded, incomplete)</code>.</li>
</ol>
<div class="callout ok"><strong>Prior art.</strong> Kleros pioneered hidden-vote juries with commit-reveal. Saring builds on that idea: it also filters conflicted jurors, and the chain never sees who the jurors are or which ones were dropped.</div>

<footer>
Data and scripts: <code>conflict-report/</code> (<code>conflict_report.py</code>, <code>out/summary.json</code>). Sources: UMA voting subgraph, Polygon RPC, Polymarket Gamma and Data APIs. All addresses are public on-chain data.
</footer>
</main>
<script type="application/json" id="data">{data_json}</script>
<script>
(() => {{
  const rows = JSON.parse(document.getElementById('data').textContent).rows;
  const tb = document.querySelector('#t tbody');
  const sh = a => a.slice(0, 6) + '…' + a.slice(-4);
  const usd = n => '$' + Math.round(n).toLocaleString('en-US');
  const el = (tag, txt, cls) => {{ const x = document.createElement(tag); if (txt != null) x.textContent = txt; if (cls) x.className = cls; return x; }};
  const link = (href, txt, code) => {{ const a = el('a'); a.href = href; a.rel = 'noopener'; a.append(code ? el('code', txt) : txt); return a; }};
  function render() {{
    tb.replaceChildren(...rows.map(r => {{
      const tr = el('tr');
      const m = el('td', null, 'mk'); m.append(r.slug ? link('{PM}' + r.slug, r.m) : r.m);
      const w = el('td'); w.append(link('{ETH}' + r.v, sh(r.v), 1), el('br'), link('{POLY}' + r.w, sh(r.w), 1));
      const vf = el('td', r.vf + ' '); vf.append(el('span', r.own ? 'own side' : 'other', r.own ? 'tag warn' : 'tag'));
      tr.append(m, el('td', r.d), w, el('td', r.h), vf, el('td', usd(r.c), 'num'), el('td', Math.round(r.uma).toLocaleString('en-US'), 'num'));
      return tr;
    }}));
  }}
  let last = 'c', dir = -1;
  document.querySelectorAll('#t th button').forEach(b => b.addEventListener('click', () => {{
    const k = b.dataset.k; dir = k === last ? -dir : (k === 'c' || k === 'uma' ? -1 : 1); last = k;
    rows.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * dir); render();
  }}));
  render();
}})();
</script>
</body>
</html>
"""

(Path(__file__).parent / "index.html").write_text(page, encoding="utf-8")
assert len(page.encode()) < 2_000_000 and len(rows) == 50
print("wrote index.html", len(page.encode()), "bytes")
