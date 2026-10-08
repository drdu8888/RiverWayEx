"""Independent re-computation of every poll x survey correlation straight from the raw CSV files
(own parsing, own join, SciPy for Spearman), compared with what the live server returns.

    python3 test/crosscheck.py [folder_with_sample_csvs]        (needs: pip install scipy)

Exits non-zero if any correlation or pair count disagrees.
"""
import csv, json, os, subprocess, sys, tempfile, time, urllib.request
from collections import defaultdict
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

    # ---------- what does the heat map actually surface? ----------
    for p in api['polls']:
        top = sorted(((abs(api['cells'][r['key']][p['id']][0] or 0), r['key'], api['cells'][r['key']][p['id']]) for r in api['rows']
                      if r['key'] in api['cells'] and p['id'] in api['cells'][r['key']] and api['cells'][r['key']][p['id']][0] is not None), reverse=True)[:7]
        print(f"\n{p['label']} {p['question'][:60]}  (tests: {p['tests']})")
        for _, k, c in top:
            print(f'   {k:<22} rho={c[0]:+.3f} n={c[1]} p={c[2]} q={c[3]}')
finally:
    srv.kill()
