"""Shared helpers: HTTP with DoH for polymarket.com (ISP DNS blocks it), keccak, caching."""
import json, os, socket, time, requests
from Crypto.Hash import keccak as _k

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache'); os.makedirs(CACHE, exist_ok=True)
UMA_SUBGRAPH = "https://api.goldsky.com/api/public/project_clus2fndawbcc01w31192938i/subgraphs/mainnet-voting-v2/0.1.0/gn"
POLYGON_RPCS = ["https://polygon.drpc.org", "https://1rpc.io/matic", "https://rpc-mainnet.matic.quiknode.pro"]
GAMMA = "https://gamma-api.polymarket.com"
DATA = "https://data-api.polymarket.com"

# ponytail: DoH only for *.polymarket.com because local ISP DNS hijacks it; harmless elsewhere.
_orig, _dns = socket.getaddrinfo, {}
def _gai(host, *a, **kw):
    if isinstance(host, str) and host.endswith('polymarket.com'):
        if host not in _dns:
            r = requests.get('https://cloudflare-dns.com/dns-query', params={'name': host, 'type': 'A'},
                             headers={'accept': 'application/dns-json'}, timeout=15).json()
            _dns[host] = [x['data'] for x in r['Answer'] if x['type'] == 1][0]
        host = _dns[host]
    return _orig(host, *a, **kw)
socket.getaddrinfo = _gai

S = requests.Session()

def keccak(b: bytes) -> bytes:
    h = _k.new(digest_bits=256); h.update(b); return h.digest()

def get(url, params=None, tries=6):
    for i in range(tries):
        try:
            r = S.get(url, params=params, timeout=40)
            if r.status_code in (403, 429) or r.status_code >= 500:  # 403 = Cloudflare rate limit
                time.sleep(3 * (i + 1)); continue
            r.raise_for_status(); return r.json()
        except requests.RequestException as e:
            if i == tries - 1: raise
            time.sleep(2 * (i + 1))
    raise RuntimeError(f'gave up after {tries} tries: {url} HTTP {r.status_code}')

def post(url, body, tries=5):
    for i in range(tries):
        try:
            r = S.post(url, json=body, timeout=60)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(2 * (i + 1)); continue
            r.raise_for_status(); return r.json()
        except requests.RequestException:
            if i == tries - 1: raise
            time.sleep(2 * (i + 1))

def gql(query, tries=4):
    for i in range(tries):
        d = post(UMA_SUBGRAPH, {'query': query})
        if 'errors' not in d: return d['data']
        time.sleep(3 * (i + 1))  # goldsky statement timeouts are transient
    raise RuntimeError(str(d['errors'])[:300])

def rpc(method, params):
    last = None
    for u in POLYGON_RPCS:
        try:
            d = post(u, {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}, tries=2)
            if 'result' in d: return d['result']
            last = d
        except Exception as e:
            last = e
    raise RuntimeError(f'all RPCs failed: {last}')

def cached(name, fn):
    p = os.path.join(CACHE, name)
    if os.path.exists(p):
        return json.load(open(p, encoding='utf-8'))
    v = fn(); json.dump(v, open(p, 'w', encoding='utf-8')); return v
