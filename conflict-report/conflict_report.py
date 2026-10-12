"""Conflict Report: UMA DVM voters who held a position in the Polymarket market they voted on.

Full backfill:  PYTHONIOENCODING=utf-8 python conflict_report.py [--window-start 2025-01-01] [--offline]
  Everything fetched is cached in ./cache (or $CONFLICT_CACHE), so reruns are cheap.
Daily update:   python conflict_report.py --incremental [--since <unix>]
  Fetches only requests resolved after the cursor in out/state.json (or after --since), analyses them
  without any cache, and merges them into out/*. Requests that can't be mapped yet are retried for 7 days.
Outputs: out/disputes.{csv,json}, out/conflicts.{csv,json}, out/summary.json, out/case_studies.json, out/state.json
"""
import csv, hashlib, json, os, re, sys, time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from common import (HERE, CACHE, DATA, GAMMA, cached, get, gql, keccak, rpc)

def arg(name):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else None


def day_ts(d): return int(datetime.fromisoformat(d).replace(tzinfo=timezone.utc).timestamp())
def day(ts): return datetime.fromtimestamp(ts, timezone.utc).date().isoformat()


_since = arg('--since')  # unix -> incremental cursor; YYYY-MM-DD -> legacy alias of --window-start
SINCE = day_ts(arg('--window-start') or (_since if _since and not _since.isdigit() else '2025-01-01'))
OUT = os.path.join(HERE, 'out'); os.makedirs(OUT, exist_ok=True)
STATE = os.path.join(OUT, 'state.json')
PENDING_DAYS = 7
E18 = 10 ** 18
POS_TYPES = {'TRADE', 'SPLIT', 'MERGE', 'REDEEM'}
MIN_SHARES = 1.0  # ponytail: dust filter; a voter "holds" a side if net >= 1 share at cutoff
pool = ThreadPoolExecutor(8)


def log(*a): print(time.strftime('%H:%M:%S'), *a, flush=True)


# ---------- 1. UMA DVM requests (YES_OR_NO_QUERY, resolved) ----------
REQ_FIELDS = '''id time price rollCount resolutionTimestamp ancillaryData
          latestRound{id roundId lastRevealTime totalVotesRevealed votersAmount minAgreementRequirement minParticipationRequirement
                      groups{price totalVoteAmount votersAmount won}}'''


def fetch_requests():
    out, last = [], SINCE
    while True:
        q = '{priceRequests(first:200,orderBy:time,where:{identifier:"YES_OR_NO_QUERY",isResolved:true,time_gt:%d}){%s}}' % (last, REQ_FIELDS)
        d = gql(q)['priceRequests']
        out += d
        if len(d) < 200: return out
        last = int(d[-1]['time']) - 1  # ponytail: overlap one second, dedup by id in main()


def fetch_resolved_after(cursor):
    """Resolved requests (in the window) with resolutionTimestamp > cursor. A block is indexed atomically,
    so everything resolved at `cursor` was already visible when the cursor was saved."""
    out, c = {}, cursor
    while True:
        d = gql('{priceRequests(first:1000,orderBy:resolutionTimestamp,where:{identifier:"YES_OR_NO_QUERY",isResolved:true,time_gt:%d,resolutionTimestamp_gte:%d}){%s}}'
                % (SINCE, c, REQ_FIELDS))['priceRequests']
        out.update((r['id'], r) for r in d if int(r['resolutionTimestamp']) > cursor)
        if len(d) < 1000: return list(out.values())
        if int(d[-1]['resolutionTimestamp']) == c: raise RuntimeError('>1000 requests resolved in one second')
        c = int(d[-1]['resolutionTimestamp'])


# ---------- 2. resolve hashed ancillary data from the Polygon OracleChildTunnel ----------
def resolve_hashed(text):
    m = dict(kv.split(':', 1) for kv in text.split(','))
    blk, oracle, h = int(m['childBlockNumber']), '0x' + m['childOracle'], m['ancillaryDataHash']
    for lg in rpc('eth_getLogs', [{'fromBlock': hex(blk), 'toBlock': hex(blk), 'address': oracle}]):
        raw = bytes.fromhex(lg['data'][2:])
        if len(raw) < 128: continue
        off = int.from_bytes(raw[64:96], 'big'); ln = int.from_bytes(raw[off:off + 32], 'big')
        anc = raw[off + 32: off + 32 + ln]
        if keccak(anc).hex() == h:
            return anc.decode('utf-8', 'replace')
    return None


def anc_text(r):
    t = bytes.fromhex(r['ancillaryData'][2:]).decode('utf-8', 'replace')
    return resolve_hashed(t) if t.startswith('ancillaryDataHash:') and 'childChainId:137' in t else t


def ancillary_texts(reqs):
    p = os.path.join(CACHE, 'ancillary.json')
    memo = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}
    todo = []
    for r in reqs:
        t = bytes.fromhex(r['ancillaryData'][2:]).decode('utf-8', 'replace')
        if t.startswith('ancillaryDataHash:') and 'childChainId:137' in t:
            if r['id'] not in memo: todo.append((r['id'], t))
        else:
            memo[r['id']] = t
    log(f'resolving {len(todo)} hashed ancillary blobs on Polygon')
    for i, (rid, txt) in enumerate(zip([x[0] for x in todo], pool.map(lambda x: _safe(resolve_hashed, x[1]), todo))):
        memo[rid] = txt
        if i % 200 == 0:
            json.dump(memo, open(p, 'w', encoding='utf-8')); log(f'  {i}/{len(todo)}')
    json.dump(memo, open(p, 'w', encoding='utf-8'))
    return memo


def _safe(fn, *a):
    try: return fn(*a)
    except Exception as e:
        log('  warn', fn.__name__, repr(e)[:120]); return None


# ---------- 3. map to Polymarket market via Gamma ----------
def title_of(t):
    m = re.search(r'q: title: (.*?), description:', t, re.S)
    return m.group(1).strip() if m else None


def gamma_market(text):
    if not text or ',ooRequester:' not in text: return None
    prefix = text.split(',ooRequester:')[0]
    qid = '0x' + keccak(prefix.encode('utf-8')).hex()
    res = get(GAMMA + '/markets', {'question_ids': qid, 'closed': 'true'}) or []
    title = title_of(text)
    for m in res:
        # ponytail: gamma ignores unknown ids and returns a default list, so require an exact id or title match
        if m.get('questionID', '').lower() == qid or (title and m.get('question', '').strip() == title):
            return {k: m.get(k) for k in ('question', 'conditionId', 'questionID', 'slug', 'volume', 'outcomes',
                                          'negRisk', 'endDate', 'clobTokenIds')} | {'matched_by': 'questionID' if m.get('questionID', '').lower() == qid else 'title'}
    return None


def markets(reqs, anc):
    p = os.path.join(CACHE, 'markets.json')
    memo = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}
    todo = [r['id'] for r in reqs if r['id'] not in memo and anc.get(r['id']) and 'ooRequester:' in anc[r['id']]]
    log(f'gamma lookups: {len(todo)}')
    for i, (rid, m) in enumerate(zip(todo, pool.map(lambda rid: _safe(gamma_market, anc[rid]), todo))):
        memo[rid] = m
        if i % 300 == 0: json.dump(memo, open(p, 'w', encoding='utf-8')); log(f'  {i}/{len(todo)}')
    json.dump(memo, open(p, 'w', encoding='utf-8'))
    return memo


# ---------- 4. revealed votes for the deciding (latest) round ----------
def round_votes(round_id):
    out, last = [], ''
    while True:
        d = gql('{revealedVotes(first:1000,orderBy:id,where:{round:"%s",id_gt:"%s"}){id voter{address} price numTokens}}'
                % (round_id, last))['revealedVotes']
        out += [{'voter': v['voter']['address'].lower(), 'price': v['price'], 'tokens': int(v['numTokens']) / E18} for v in d]
        if len(d) < 1000: return out
        last = d[-1]['id']


def all_votes(rounds):
    p = os.path.join(CACHE, 'votes.json')
    memo = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}
    todo = [r for r in rounds if r not in memo]
    log(f'fetching votes for {len(todo)} rounds')
    for i, (rid, v) in enumerate(zip(todo, pool.map(lambda r: _safe(round_votes, r), todo))):
        if v is not None: memo[rid] = v
        if i % 300 == 0: json.dump(memo, open(p, 'w', encoding='utf-8')); log(f'  {i}/{len(todo)}')
    json.dump(memo, open(p, 'w', encoding='utf-8'))
    return memo


# ---------- 5. voter EOA -> Polymarket wallets ----------
SAFE_FACTORY = bytes.fromhex('aacFeEa03eb1561C4e67d661e40682Bd20E3541b')
SAFE_INIT_HASH = bytes.fromhex('2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf')


def safe_of(eoa):
    """Polymarket Gnosis-Safe proxy deterministically derived (CREATE2) from the owner EOA.
    Verified against live wallets: getOwners() of a Safe trader re-derives to the same address."""
    salt = keccak(bytes(12) + bytes.fromhex(eoa[2:]))
    return '0x' + keccak(b'\xff' + SAFE_FACTORY + salt + SAFE_INIT_HASH)[-20:].hex()


def wallet_activity(wallet, conds):
    """All position-relevant activity of `wallet` restricted to `conds` (chunked, paginated)."""
    out = []
    conds = sorted(conds)
    for i in range(0, len(conds), 100):  # data-api rejects >~100 values in `market`
        off = 0
        while True:
            d = get(DATA + '/activity', {'user': wallet, 'market': ','.join(conds[i:i + 100]), 'type': 'TRADE,SPLIT,MERGE,REDEEM', 'limit': 500, 'offset': off})
            out += [{k: a.get(k) for k in ('timestamp', 'conditionId', 'type', 'size', 'usdcSize', 'side', 'outcomeIndex', 'price', 'transactionHash')}
                    for a in d if a.get('type') in POS_TYPES]
            if len(d) < 500 or off >= 9500: break  # ponytail: data-api offset cap ~10k; whales beyond that are truncated
            off += 500
    return out


def has_any(wallet):
    return bool(get(DATA + '/activity', {'user': wallet, 'type': 'TRADE,SPLIT,MERGE,REDEEM', 'limit': 1}))


def voter_activity(voter_conds):
    p = os.path.join(CACHE, 'activity.json')
    memo = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}
    if '--offline' in sys.argv:  # analyse whatever is cached (partial run); coverage is reported in summary
        return memo
    todo = [v for v in voter_conds if v not in memo]
    log(f'checking Polymarket activity for {len(todo)} voters (EOA + derived Safe)')

    # phase A (cheap): which voters have ANY Polymarket position activity on EOA / derived Safe
    pa = os.path.join(CACHE, 'linked.json')
    linked = json.load(open(pa, encoding='utf-8')) if os.path.exists(pa) else {}
    need = [v for v in voter_conds if v not in linked]
    log(f'  phase A: {len(need)} voters to probe')
    for i, (v, r) in enumerate(zip(need, pool.map(lambda v: _safe(lambda: {k: w for k, w in (('eoa', v), ('safe', safe_of(v))) if has_any(w)}), need))):
        if r is not None: linked[v] = r
        if i % 500 == 0: json.dump(linked, open(pa, 'w', encoding='utf-8')); log(f'  A {i}/{len(need)}')
    json.dump(linked, open(pa, 'w', encoding='utf-8'))
    for v in todo:
        if v in linked and not linked[v]: memo[v] = {}
    todo = [v for v in todo if v not in memo and v in linked]
    log(f'  phase B: {len(todo)} linked voters, fetching activity in their voted markets')

    def one(v):
        return {k: {'wallet': w, 'acts': wallet_activity(w, voter_conds[v])} for k, w in linked[v].items()}
    for i, (v, r) in enumerate(zip(todo, pool.map(lambda v: _safe(one, v), todo))):
        if r is not None: memo[v] = r
        if i % 200 == 0: json.dump(memo, open(p, 'w', encoding='utf-8')); log(f'  {i}/{len(todo)}')
    json.dump(memo, open(p, 'w', encoding='utf-8'))
    return memo


# ---------- 6. analysis ----------
def vote_side(price):
    p = int(price)
    return {E18: 0, 0: 1, E18 // 2: '50-50'}.get(p, 'other')  # p2 -> outcomeIndex 0, p1 -> outcomeIndex 1


def position_at(acts, cond, cutoff):
    net, cost, n_pre, redeemed = defaultdict(float), 0.0, 0, False
    for a in acts:
        if a['conditionId'] != cond: continue
        if a['type'] == 'REDEEM':
            if a['timestamp'] >= cutoff: redeemed = True
            continue
        if a['timestamp'] > cutoff: continue
        n_pre += 1
        s = float(a['size'] or 0)
        if a['type'] == 'TRADE':
            sign = 1 if a['side'] == 'BUY' else -1
            net[a['outcomeIndex']] += sign * s; cost += sign * float(a['usdcSize'] or 0)
        elif a['type'] == 'SPLIT':
            net[0] += s; net[1] += s; cost += float(a['usdcSize'] or s)
        elif a['type'] == 'MERGE':
            net[0] -= s; net[1] -= s; cost -= float(a['usdcSize'] or s)
    held = {k: round(v, 2) for k, v in net.items() if v >= MIN_SHARES}
    return held, round(cost, 2), n_pre, redeemed


def winner(groups_tokens, min_agree):
    tot = sum(groups_tokens.values())
    if not tot: return None, 0.0, tot
    p, w = max(groups_tokens.items(), key=lambda x: x[1])
    return p, w / tot, tot


def short(a): return a[:6] + '…' + a[-4:]


def rid_key(rid): return hashlib.sha1(rid.encode()).hexdigest()[:16]


def analyse(pm, mk, votes, act):
    """Per-dispute rows + per-conflicted-vote rows. Pure: depends only on the fetched inputs."""
    disputes, conflicts = [], []
    for r in pm:
        m, rd = mk[r['id']], r['latestRound']
        vs = votes.get(rd['id'])
        if not vs: continue
        cutoff = int(rd['lastRevealTime'])
        g_all, g_clean = defaultdict(float), defaultdict(float)
        conf_tokens, conf_n, self_serving_tokens, touched = 0.0, 0, 0.0, 0
        for v in vs:
            g_all[v['price']] += v['tokens']
            held, cost, n_pre, redeemed = {}, 0.0, 0, False
            via = None
            for kind, a in act.get(v['voter'], {}).items():
                h, c, n, rdm = position_at(a['acts'], m['conditionId'], cutoff)
                if n: touched += 1
                if h:
                    held, cost, n_pre, redeemed, via = h, c, n, rdm, (kind, a['wallet'])
            if held:
                conf_tokens += v['tokens']; conf_n += 1
                side = vote_side(v['price'])
                held_side = max(held, key=held.get)
                ss = (side == held_side)
                if ss: self_serving_tokens += v['tokens']
                outcomes = json.loads(m['outcomes']) if isinstance(m['outcomes'], str) else (m['outcomes'] or [])
                nm = lambda i: outcomes[i] if isinstance(i, int) and i < len(outcomes) else str(i)
                conflicts.append({'request_id': r['id'][:80], 'market': m['question'], 'conditionId': m['conditionId'],
                                  'vote_time_utc': datetime.fromtimestamp(cutoff, timezone.utc).strftime('%Y-%m-%d'),
                                  'voter': v['voter'], 'link': via[0], 'polymarket_wallet': via[1],
                                  'vote_tokens_UMA': round(v['tokens'], 2), 'voted_for': nm(side),
                                  'held_shares_at_vote': json.dumps({nm(k): s for k, s in held.items()}),
                                  'net_cost_usdc': cost, 'voted_own_side': ss, 'redeemed_after': redeemed})
            else:
                g_clean[v['price']] += v['tokens']
        outcomes = json.loads(m['outcomes']) if isinstance(m['outcomes'], str) else (m['outcomes'] or [])
        name = lambda price: (lambda i: outcomes[i] if isinstance(i, int) and i < len(outcomes) else str(i))(vote_side(price)) if price is not None else None
        tot = sum(g_all.values())
        min_agree = 0.65  # UMA SPAT: winning price needs >65% of revealed tokens (subgraph field is a token amount, not a ratio)
        w_all, share_all, _ = winner(g_all, min_agree)
        w_clean, share_clean, tot_clean = winner(g_clean, min_agree)
        gat = float(rd['minParticipationRequirement'] or 0)  # GAT in UMA tokens (already decimal in subgraph)
        disputes.append({'request_id': r['id'][:80], 'market': m['question'], 'slug': m['slug'],
                         'volume_usd': round(float(m['volume'] or 0)), 'vote_round_end_utc': datetime.fromtimestamp(cutoff, timezone.utc).strftime('%Y-%m-%d'),
                         'resolved_outcome': name(r['price']), 'voters': len(vs), 'tokens_revealed': round(tot),
                         'conflicted_voters': conf_n, 'conflicted_tokens': round(conf_tokens),
                         'conflicted_pct': round(100 * conf_tokens / tot, 2) if tot else 0,
                         'self_serving_tokens': round(self_serving_tokens),
                         'winner_all': name(w_all), 'winner_share_all': round(share_all, 4),
                         'winner_clean': name(w_clean), 'winner_share_clean': round(share_clean, 4),
                         'outcome_flips': bool(w_clean) and w_clean != w_all,
                         'clean_below_supermajority': share_clean < min_agree if w_clean else True,
                         'clean_below_GAT': tot_clean < gat, 'voters_touching_market': touched})
    return disputes, conflicts


def summarize(disputes, conflicts, st, generated=None):
    """Headline numbers. `st` (out/state.json) carries the counts that aren't recoverable from the rows."""
    with_conf = [d for d in disputes if d['conflicted_voters']]
    tot_tok = sum(d['tokens_revealed'] for d in disputes)
    linked = {v: k for v, k in st['voters'].items() if k}
    summary = {
        'generated_utc': generated or datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'window_start': st['window_start'],
        'latest_resolution_utc': datetime.fromtimestamp(st['cursor'], timezone.utc).isoformat(timespec='seconds'),
        'uma_yes_no_requests_resolved': len(st['requests']) + len(st['pending']),
        'mapped_to_polymarket': sum(st['requests'].values()), 'disputes_with_votes': len(disputes),
        'unique_voters': len(st['voters']),
        'voters_probed_for_link': len(st['voters']),
        'voters_with_activity_fetched': len(st['voters']),
        'unique_markets': len(st['markets']),
        'voters_linked_to_polymarket_wallet': len(linked),
        'voters_linked_via_eoa': sum('eoa' in a for a in linked.values()),
        'voters_linked_via_safe': sum('safe' in a for a in linked.values()),
        'disputes_with_conflicted_voter': len(with_conf),
        'pct_disputes_with_conflicted_voter': round(100 * len(with_conf) / len(disputes), 2) if disputes else 0,
        'conflicted_vote_rows': len(conflicts), 'unique_conflicted_voters': len({c['voter'] for c in conflicts}),
        'conflicted_token_pct_all_disputes': round(100 * sum(d['conflicted_tokens'] for d in disputes) / tot_tok, 3) if tot_tok else 0,
        'conflicted_token_pct_median_when_present': sorted(d['conflicted_pct'] for d in with_conf)[len(with_conf) // 2] if with_conf else 0,
        'max_conflicted_pct': max((d['conflicted_pct'] for d in disputes), default=0),
        'self_serving_share_of_conflicted_votes': round(sum(c['voted_own_side'] for c in conflicts) / len(conflicts), 3) if conflicts else None,
        'outcome_flips_if_conflicted_removed': sum(d['outcome_flips'] for d in disputes),
        'disputes_falling_below_supermajority_if_removed': sum(d['clean_below_supermajority'] and not d['winner_share_all'] < 0.65 for d in disputes),
    }
    big = [d for d in disputes if d['volume_usd'] >= 1_000_000]
    summary['disputes_market_volume_ge_1M'] = len(big)
    summary['pct_of_those_with_conflicted_voter'] = round(100 * sum(d['conflicted_voters'] > 0 for d in big) / len(big), 2) if big else 0
    summary['unique_markets_with_conflicted_voter'] = len({d['slug'] for d in with_conf})
    summary['total_conflicted_position_cost_usdc'] = round(sum(c['net_cost_usdc'] for c in conflicts))
    summary['top20_disputes_by_volume'] = [{k: d[k] for k in ('market', 'vote_round_end_utc', 'volume_usd', 'voters', 'conflicted_voters', 'conflicted_pct', 'outcome_flips')}
                                           for d in sorted(disputes, key=lambda d: -d['volume_usd'])[:20]]
    return summary


def dump(obj, name, **kw):
    with open(os.path.join(OUT, name), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(obj, f, ensure_ascii=False, **kw); f.write('\n')


def finish(disputes, conflicts, st):
    summary = summarize(disputes, conflicts, st)
    vol = {d['request_id']: d['volume_usd'] for d in disputes}
    # case studies: self-serving votes (voted for the side they held), ranked by money at stake, one per market
    seen, cases = set(), []
    for c in sorted((c for c in conflicts if c['voted_own_side']), key=lambda c: -abs(c['net_cost_usdc'])):
        if c['conditionId'] in seen: continue
        seen.add(c['conditionId'])
        cases.append(c | {'market_volume_usd': vol.get(c['request_id']), 'voter_short': short(c['voter']), 'wallet_short': short(c['polymarket_wallet'])})
        if len(cases) == 10: break
    dump(cases, 'case_studies.json', indent=1)
    for name, rows in (('disputes', disputes), ('conflicts', conflicts)):
        rows = sorted(rows, key=lambda d: -d.get('volume_usd', d.get('vote_tokens_UMA', 0)))
        with open(os.path.join(OUT, f'{name}.csv'), 'w', newline='', encoding='utf-8') as f:
            if rows:
                w = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator='\n'); w.writeheader(); w.writerows(rows)
        dump(rows, f'{name}.json', indent=1)
    dump(summary, 'summary.json', indent=1)
    dump(st, 'state.json', indent=0, sort_keys=True)
    print(json.dumps({k: v for k, v in summary.items() if k != 'top20_disputes_by_volume'}, indent=1))


def main():
    reqs = cached(f'requests_{SINCE}.json', fetch_requests)
    reqs = list({r['id']: r for r in reqs}.values())
    log(f'{len(reqs)} resolved YES_OR_NO_QUERY DVM requests since {day(SINCE)}')
    anc = ancillary_texts(reqs)
    mk = markets(reqs, anc)
    pm = [r for r in reqs if mk.get(r['id'])]
    log(f'{len(pm)} mapped to a Polymarket market')
    votes = all_votes([r['latestRound']['id'] for r in pm])

    voter_conds = defaultdict(set)
    for r in pm:
        for v in votes.get(r['latestRound']['id'], []):
            voter_conds[v['voter']].add(mk[r['id']]['conditionId'])
    act = voter_activity({k: sorted(v) for k, v in voter_conds.items()})
    lk = json.load(open(os.path.join(CACHE, 'linked.json'), encoding='utf-8'))
    log(f'{len(voter_conds)} unique voters, {sum(bool(lk.get(v)) for v in voter_conds)} with any Polymarket activity on EOA/derived Safe')
    disputes, conflicts = analyse(pm, mk, votes, act)
    st = {'window_start': day(SINCE), 'cursor': max((int(r['resolutionTimestamp']) for r in reqs), default=SINCE),
          'requests': {rid_key(r['id']): int(bool(mk.get(r['id']))) for r in reqs},
          'markets': sorted({mk[r['id']]['conditionId'] for r in pm}),
          'voters': {v: sorted(lk.get(v) or {}) for v in sorted(voter_conds)}, 'pending': []}
    finish(disputes, conflicts, st)


def incremental():
    """Fetch only requests resolved after the saved cursor, analyse them cache-free, merge into out/."""
    global SINCE
    st = json.load(open(STATE, encoding='utf-8'))
    SINCE = day_ts(st['window_start'])
    cursor = int(_since) if _since and _since.isdigit() else st['cursor']
    fresh = [r for r in fetch_resolved_after(cursor) if rid_key(r['id']) not in st['requests']]
    pend = {r['id']: r for r in st['pending']}
    batch = list(pend.values()) + [r for r in fresh if r['id'] not in pend]
    log(f'{len(fresh)} newly resolved requests after {datetime.fromtimestamp(cursor, timezone.utc):%Y-%m-%d %H:%M} UTC, {len(pend)} pending retries')

    anc = dict(zip([r['id'] for r in batch], pool.map(lambda r: _safe(anc_text, r), batch)))
    mk = dict(zip(anc, pool.map(lambda t: _safe(gamma_market, t) if t else None, anc.values())))
    rounds = [r['latestRound']['id'] for r in batch if mk[r['id']]]
    votes = dict(zip(rounds, pool.map(lambda x: _safe(round_votes, x), rounds)))

    now, pending, done = time.time(), [], []
    for r in batch:
        t, m = anc[r['id']], mk[r['id']]
        retry = t is None or (m is None and ',ooRequester:' in t) or (m and votes[r['latestRound']['id']] is None)
        # ponytail: unmapped/failed requests are retried for PENDING_DAYS (Gamma lists a market only once it closes), then counted as unmapped
        (pending if retry and now - int(r['resolutionTimestamp']) < PENDING_DAYS * 86400 else done).append(r)
    pm = [r for r in done if mk[r['id']]]
    votes = {k: v for k, v in votes.items() if v}

    voter_conds = defaultdict(set)
    for r in pm:
        for v in votes.get(r['latestRound']['id'], []):
            voter_conds[v['voter']].add(mk[r['id']]['conditionId'])
    new_voters = [v for v in voter_conds if v not in st['voters']]
    log(f'{len(pm)} new disputes mapped, {len(voter_conds)} voters ({len(new_voters)} new); {len(pending)} pending')

    # Every voter's EOA + derived Safe is checked directly in the new markets (no reliance on an old link probe).
    # Errors propagate: a half-checked dispute must not be published.
    def one(v):
        return {k: {'wallet': w, 'acts': wallet_activity(w, sorted(voter_conds[v]))} for k, w in (('eoa', v), ('safe', safe_of(v)))}
    act = dict(zip(voter_conds, pool.map(one, voter_conds)))
    probe = dict(zip(new_voters, pool.map(lambda v: [k for k, w in (('eoa', v), ('safe', safe_of(v))) if has_any(w)], new_voters)))
    for v, a in act.items():
        st['voters'][v] = sorted(set(st['voters'].get(v, [])) | set(probe.get(v, [])) | {k for k, x in a.items() if x['acts']})

    new_d, new_c = analyse(pm, mk, votes, act)
    disputes = json.load(open(os.path.join(OUT, 'disputes.json'), encoding='utf-8')) + new_d
    conflicts = json.load(open(os.path.join(OUT, 'conflicts.json'), encoding='utf-8')) + new_c
    st['requests'].update({rid_key(r['id']): int(bool(mk[r['id']])) for r in done})
    st['markets'] = sorted(set(st['markets']) | {mk[r['id']]['conditionId'] for r in pm})
    st['pending'] = pending
    st['cursor'] = max([st['cursor']] + [int(r['resolutionTimestamp']) for r in fresh])
    st['last_run'] = {'utc': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'new_disputes': len(new_d),
                      'new_conflicted_votes': len(new_c), 'pending': len(pending)}
    log(f'+{len(new_d)} disputes, +{len(new_c)} conflicted votes')
    finish(disputes, conflicts, st)


if __name__ == '__main__':
    incremental() if '--incremental' in sys.argv or (_since and _since.isdigit()) else main()
