"""Independent re-computation of every poll x survey correlation straight from the raw CSV files
(own parsing, own join, SciPy for Spearman), compared with what the live server returns.

    python3 test/crosscheck.py [folder_with_sample_csvs]        (needs: pip install scipy)

Also re-derives every class-view card (group sizes, who agreed, the 20-point floor, the balanced split, the
ordering, and the "luck" line) and exits non-zero if any correlation, pair count or card disagrees.
"""
import csv, json, math, os, subprocess, sys, tempfile, time, urllib.request
from collections import defaultdict
import numpy as np
from scipy.stats import spearmanr

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'sample-data')
PORT = 3777 + os.getpid() % 100
KEY = 'xcheck'
data_dir = tempfile.mkdtemp()
env = dict(os.environ, PORT=str(PORT), INSTRUCTOR_KEY=KEY, DATA_DIR=data_dir)
srv = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=env, stdout=subprocess.PIPE)
srv.stdout.readline()

def call(method, path, body=None):
    req = urllib.request.Request(f'http://127.0.0.1:{PORT}{path}', method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'x-instructor-key': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req))

try:
    survey_csv = open(f'{SAMPLE}/SAMPLE_survey_export_FAKE.csv').read()
    poll_csv = open(f'{SAMPLE}/SAMPLE_poll_export_FAKE.csv').read()
    call('POST', '/api/admin/import-polls', {'csv': poll_csv})
    call('POST', '/api/admin/survey', {'csv': survey_csv})
    api = call('GET', '/api/admin/analysis')

    # ---------- independent computation ----------
    book = json.load(open(f'{ROOT}/lib/codebook.json'))
    rows = list(csv.reader(open(f'{SAMPLE}/SAMPLE_survey_export_FAKE.csv')))
    head, body = rows[0], rows[3:]
    ci = {h: i for i, h in enumerate(head)}
    survey = {r[ci['StudentLast4']].zfill(4): r for r in body}

    def cell(code, col):
        return survey[code][ci[col]].strip()

    vals = {}   # key -> {code: number}
    for v in book['variables']:
        m = {}
        if v['kind'] == 'ordinal':
            by = {l['label'].lower(): l['value'] for l in v['levels']}
            for code in survey:
                c = cell(code, v['column'])
                if c and by.get(c.lower()) is not None:
                    m[code] = by[c.lower()]
            vals[v['key']] = m
        elif v['kind'] == 'nominal':
            idx = {l['label'].lower(): l['index'] for l in v['levels']}
            lv = {}
            for code in survey:
                c = cell(code, v['column'])
                if c:
                    lv[code] = idx[c.lower()]
            for l in v['levels']:
                vals[f"{v['key']}#{l['index']}"] = {c: int(i == l['index']) for c, i in lv.items()}
        # multi handled below
    by_tag = defaultdict(list)
    for v in book['variables']:
        if v['kind'] == 'multi':
            by_tag[v['tag']].append(v)
    for tag, vs in by_tag.items():
        for v in vs:
            m = {}
            for code in survey:
                flags = [cell(code, x['column']) != '' for x in vs]
                if any(flags):
                    m[code] = int(cell(code, v['column']) != '')
            vals[v['key']] = m

    polls = defaultdict(dict)
    qtext = {}
    for r in list(csv.reader(open(f'{SAMPLE}/SAMPLE_poll_export_FAKE.csv')))[1:]:
        rid, q, code, choice, _ = r
        qtext[rid] = q
        polls[rid][code.zfill(4)] = ['strongly disagree', 'disagree', 'neutral', 'agree', 'strongly agree'].index(choice.lower()) + 1
    api_poll = {p['question']: p for p in api['polls']}

    compared = mism_rho = mism_n = 0
    worst = 0
    missing_from_api = []
    for rid, pm in polls.items():
        ap = api_poll[qtext[rid]]
        for key, m in vals.items():
            pairs = [(pm[c], m[c]) for c in pm if c in m]
            c = api['cells'].get(key, {}).get(ap['id'])
            if c is None:
                continue  # variable dropped by the app's own group-size/constant rules
            compared += 1
            if len(pairs) < 8:
                ok_n = c[1] == len(pairs) and c[0] is None
                mism_n += (not ok_n)
                continue
            x, y = zip(*pairs)
            rho = spearmanr(x, y).statistic
            if c[1] != len(pairs):
                mism_n += 1
            if rho != rho:  # nan (constant)
                continue
            d = abs(rho - c[0])
            worst = max(worst, d)
            if d > 0.0006:
                mism_rho += 1
                print('MISMATCH', key, ap['label'], 'api', c[0], 'scipy', round(rho, 4))
        # poll x poll
        for rid2, pm2 in polls.items():
            if rid2 == rid:
                continue
            ap2 = api_poll[qtext[rid2]]
            c = api['cells'][f"poll:{ap2['id']}"][ap['id']]
            pairs = [(pm[k], pm2[k]) for k in pm if k in pm2]
            rho = spearmanr(*zip(*pairs)).statistic
            compared += 1
            if c[1] != len(pairs): mism_n += 1
            d = abs(rho - c[0]); worst = max(worst, d)
            if d > 0.0006: mism_rho += 1; print('POLLPOLL MISMATCH', c, rho)

    print(f'compared {compared} cells; rho mismatches: {mism_rho}; n mismatches: {mism_n}; worst |diff| {worst:.5f}')
    if mism_rho or mism_n:
        sys.exit(1)
    print('app rows:', len(api['rows']), '| polls:', [(p['label'], p['votes'], p['matched'], p['unmatched']) for p in api['polls']])

    # ---------- class-view cards, re-derived independently ----------
    call('POST', '/api/admin/present-config', {'sections': [s['id'] for s in book['sections']]})
    LIK = ['strongly disagree', 'disagree', 'neutral', 'agree', 'strongly agree']
    MIN_G, FLOOR = 5, 0.20
    rid_of = {ap['id']: next(r for r, qq in qtext.items() if qq == ap['question']) for ap in api['polls']}

    def standout(a0, n0, a1, n1):
        pooled = (a0 + a1 + 1) / (n0 + n1 + 2)
        return abs(a1 / n1 - a0 / n0) / math.sqrt(pooled * (1 - pooled) * (1 / n0 + 1 / n1))

    card_bad = cards_checked = 0
    for ap in api['polls']:
        pm = polls[rid_of[ap['id']]]
        codes = sorted(pm)
        agree = np.array([1 if pm[c] >= 4 else 0 for c in codes])
        dis = np.array([1 if pm[c] <= 2 else 0 for c in codes])
        # every comparison on offer: (key, member indexes, side 0/1, counts)
        family = {}
        others = {f"poll:{o['id']}": polls[rid_of[o['id']]] for o in api['polls'] if o['id'] != ap['id']}
        sources = dict(vals); sources.update(others)
        for key, m in sources.items():
            idx = [i for i, c in enumerate(codes) if c in m]
            if len(idx) < 8:
                continue
            rv = [m[codes[i]] for i in idx]
            uniq = sorted(set(rv))
            binary = set(rv) <= {0, 1} and not key.startswith('poll:') and not any(v['key'] == key and v['kind'] == 'ordinal' for v in book['variables'])
            if binary:
                if sum(rv) < MIN_G or len(rv) - sum(rv) < MIN_G:
                    continue
                side = [int(v == 1) for v in rv]
            else:
                best = None
                for t in uniq[:-1]:
                    lo = sum(v <= t for v in rv); hi = len(rv) - lo
                    if lo >= MIN_G and hi >= MIN_G and (best is None or abs(lo - hi) < best[1]):
                        best = (t, abs(lo - hi))
                if best is None:
                    continue
                side = [int(v > best[0]) for v in rv]
            idx = np.array(idx); side = np.array(side)
            n1 = int(side.sum()); n0 = len(side) - n1
            a1 = int(agree[idx][side == 1].sum()); a0 = int(agree[idx][side == 0].sum())
            d1 = int(dis[idx][side == 1].sum()); d0 = int(dis[idx][side == 0].sum())
            family[key] = dict(idx=idx, side=side, n0=n0, n1=n1, a0=a0, a1=a1, d0=d0, d1=d1, z=standout(a0, n0, a1, n1), gap=abs(a1 / n1 - a0 / n0))

        r = call('GET', f"/api/admin/present?poll={ap['id']}")
        # luck line: shuffle the poll answers, 90th percentile of the largest standout among all comparisons
        rng = np.random.default_rng(1)
        B = 2000
        shuf = np.stack([rng.permutation(agree) for _ in range(B)])
        mx = np.zeros(B)
        for f in family.values():
            A = shuf[:, f['idx']]
            a1s = A[:, f['side'] == 1].sum(1); a0s = A[:, f['side'] == 0].sum(1)
            n0, n1 = f['n0'], f['n1']
            pooled = (a0s + a1s + 1) / (n0 + n1 + 2)
            z = np.abs(a1s / n1 - a0s / n0) / np.sqrt(pooled * (1 - pooled) * (1 / n0 + 1 / n1))
            mx = np.maximum(mx, z)
        luck_z = float(np.quantile(mx, 0.9))
        need = sorted(luck_z * math.sqrt(0.25 * (1 / f['n0'] + 1 / f['n1'])) for f in family.values())
        luck_gap = min(100, round(need[len(need) // 2] * 100))
        if abs(luck_gap - r['luckGap']) > 4:
            card_bad += 1; print('LUCK LINE differs', ap['label'], 'api', r['luckGap'], 'python', luck_gap)

        if r['compared'] != len(family):
            card_bad += 1; print('COMPARED differs', ap['label'], r['compared'], len(family))
        eligible = sorted((f['z'], k) for k, f in family.items() if f['gap'] >= FLOOR - 1e-9)
        if r['connections'] and eligible and r['connections'][0]['key'] != eligible[-1][1] and abs(family[r['connections'][0]['key']]['z'] - eligible[-1][0]) > 1e-9:
            card_bad += 1; print('TOP CARD differs', ap['label'], r['connections'][0]['key'], eligible[-1][1])
        for c in r['connections']:
            f = family.get(c['key'])
            cards_checked += 1
            if f is None:
                card_bad += 1; print('CARD for a comparison the independent code does not offer', c['key']); continue
            got = sorted([(g['n'], g['agree'], g['disagree']) for g in (c['more'], c['less'])])
            exp = sorted([(f['n0'], f['a0'], f['d0']), (f['n1'], f['a1'], f['d1'])])
            if got != exp:
                card_bad += 1; print('COUNTS differ', ap['label'], c['key'], got, exp)
            if c['gap'] != math.floor(f['gap'] * 100 + 0.5) or c['gap'] < 20:
                card_bad += 1; print('GAP differs', c['key'], c['gap'], f['gap'])
            if c['beyondLuck'] != (f['z'] > luck_z):
                # tolerate disagreement only when the card sits within Monte-Carlo noise of the line
                if abs(f['z'] - luck_z) > 0.15:
                    card_bad += 1; print('LUCK FLAG differs', c['key'], c['beyondLuck'], round(f['z'], 2), round(luck_z, 2))
    print(f'class view: {cards_checked} cards re-derived from the raw files; disagreements: {card_bad}')
    if card_bad:
        sys.exit(1)

    # ---------- what does the heat map actually surface? ----------
    for p in api['polls']:
        top = sorted(((abs(api['cells'][r['key']][p['id']][0] or 0), r['key'], api['cells'][r['key']][p['id']]) for r in api['rows']
                      if r['key'] in api['cells'] and p['id'] in api['cells'][r['key']] and api['cells'][r['key']][p['id']][0] is not None), reverse=True)[:7]
        print(f"\n{p['label']} {p['question'][:60]}  (tests: {p['tests']})")
        for _, k, c in top:
            print(f'   {k:<22} rho={c[0]:+.3f} n={c[1]} p={c[2]} q={c[3]}')
finally:
    srv.kill()
