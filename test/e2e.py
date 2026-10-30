"""Real-browser walk-through of every page (needs: pip install playwright, and a Chromium it can launch).

    python3 test/e2e.py [screenshot_dir] [number_of_fake_students]

Starts the server on a throwaway port with fake data, drives the instructor console, the student page, the
analysis page and the class view like a person would, and fails on any JavaScript error or any request
the Content-Security-Policy blocks.
"""
import json, os, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp()
N = sys.argv[2] if len(sys.argv) > 2 else '28'
PORT, KEY = 3911, 'e2e-key'
BASE = f'http://127.0.0.1:{PORT}'
CHROME = os.environ.get('CHROME_PATH') or ('/opt/pw-browsers/chromium' if os.path.exists('/opt/pw-browsers/chromium') else None)
os.makedirs(OUT, exist_ok=True)

sample = tempfile.mkdtemp()
subprocess.run(['node', 'tools/make-sample-data.js', '--n', N, '--out', sample], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
data_dir = tempfile.mkdtemp()
srv = subprocess.Popen(['node', 'server.js'], cwd=ROOT, stdout=subprocess.PIPE,
                       env=dict(os.environ, PORT=str(PORT), INSTRUCTOR_KEY=KEY, DATA_DIR=data_dir))
srv.stdout.readline()

errors = []
def watch(page, name):
    page.on('pageerror', lambda e: errors.append(f'{name}: pageerror {e}'))
    def on_console(m):
        # 400/401 responses are provoked on purpose below (wrong key, unfamiliar ID column)
        if m.type in ('error', 'warning') and not ('Failed to load resource' in m.text and ('status of 400' in m.text or 'status of 401' in m.text)):
            errors.append(f'{name}: console.{m.type} {m.text}')
    page.on('console', on_console)

def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        errors.append('assertion: ' + msg)

try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
        inst_ctx = browser.new_context(viewport={'width': 1400, 'height': 1000})
        stud_ctx = browser.new_context(viewport={'width': 390, 'height': 800})

        # ---- instructor console ----
        inst = inst_ctx.new_page(); watch(inst, 'instructor')
        inst.goto(BASE + '/instructor.html')
        inst.fill('#key', 'wrong'); inst.click('#unlockBtn')
        inst.wait_for_selector('#gateError:has-text("Incorrect")')
        check('Incorrect' in inst.inner_text('#gateError'), 'wrong key is rejected')
        inst.fill('#key', KEY); inst.click('#unlockBtn')
        inst.wait_for_selector('#main', state='visible')
        inst.fill('#question', 'Generative AI tools help students think more deeply.')
        inst.click('#startBtn')
        inst.wait_for_selector('#statusPill.open')
        check('Generative AI' in inst.inner_text('#currentQ'), 'poll started')

        # ---- student page (phone-sized) ----
        stu = stud_ctx.new_page(); watch(stu, 'student')
        stu.goto(BASE + '/')
        stu.locator('#code').press_sequentially('ab12cd345')   # typed like a person; letters dropped, 4 digits max
        check(stu.input_value('#code') == '1234', 'student code field keeps digits only, max 4')
        stu.fill('#code', '0457')
        stu.wait_for_selector('.option-btn')
        check(stu.locator('.option-btn').count() == 5, 'five Likert buttons')
        stu.click('.option-btn:has-text("Strongly agree")')
        stu.wait_for_selector('.option-btn.selected')
        check('Strongly agree' in stu.inner_text('.option-btn.selected'), 'vote recorded and highlighted')
        stu.screenshot(path=f'{OUT}/student_open.png')
        inst.wait_for_selector('#liveResults:has-text("1 response")')
        inst.screenshot(path=f'{OUT}/instructor.png')
        inst.click('#closeBtn')
        stu.wait_for_selector('.pill.closed')
        check('your answer' in stu.inner_text('#pollBody'), 'student sees the closed histogram')
        stu.screenshot(path=f'{OUT}/student_closed.png')

        # ---- analysis page ----
        ana = inst_ctx.new_page(); watch(ana, 'analysis')
        ana.goto(BASE + '/analysis.html')
        check(ana.is_visible('#gate'), 'a fresh tab asks for the key (it is not stored beyond the tab)')
        ana.fill('#key', KEY); ana.click('#unlockBtn')
        ana.wait_for_selector('#main', state='visible')
        ana.click('summary')   # the restore-polls section is collapsed until opened
        ana.set_input_files('#pollFile', f'{sample}/SAMPLE_poll_export_FAKE.csv')
        ana.wait_for_selector('#pollImportMsg:has-text("Imported")')
        check('Imported 6' in ana.inner_text('#pollImportMsg'), 'poll history imported')

        # file whose ID column has an unfamiliar name -> asks which column
        text = open(f'{sample}/SAMPLE_survey_export_FAKE.csv').read().replace('StudentLast4', 'Mystery')
        odd = f'{sample}/odd.csv'; open(odd, 'w').write(text)
        ana.set_input_files('#surveyFile', odd)
        ana.wait_for_selector('#idPicker', state='visible')
        ana.select_option('#idSelect', 'Mystery'); ana.click('#idGo')
        ana.wait_for_selector('#surveyStatus .banner.good')
        check(True, 'unfamiliar ID column handled through the picker')

        # the real upload
        ana.set_input_files('#surveyFile', f'{sample}/SAMPLE_survey_export_FAKE.csv')
        ana.wait_for_selector('#uploadMsg:has-text("Loaded")')
        ana.wait_for_selector('table.hm td.v')
        cells = ana.locator('table.hm td.v').count()
        check(cells > 100, f'heat map rendered ({cells} coloured cells)')
        check('memory' in ana.inner_text('#surveyStatus'), 'status says survey is in memory')
        check(ana.locator('#chanceCard').is_visible(), 'chance check visible')
        ana.screenshot(path=f'{OUT}/analysis_top.png', full_page=False)

        ana.locator('table.hm td.v').first.click()
        ana.wait_for_selector('#detail .stats')
        check(ana.locator('#detail .stack').count() >= 2, 'detail panel shows group distributions')
        # sort by a poll column header and filter
        ana.locator('table.hm th.ph').nth(2).click()
        ana.select_option('#minAbs', '0.3')
        check(ana.locator('#shownCount').inner_text().startswith('Showing'), 'filters apply')
        ana.select_option('#minAbs', '0')
        ana.fill('#search', 'religio')
        check(ana.locator('table.hm tbody tr').count() >= 1, 'search narrows rows')
        ana.fill('#search', '')
        with ana.expect_download() as dl:
            ana.click('#csvBtn')
        check(dl.value.suggested_filename.endswith('.csv'), 'heat-map CSV downloads')
        ana.screenshot(path=f'{OUT}/analysis_full.png', full_page=True)

        # sensitive sections default OFF in the class-safe view
        pchips = ana.locator('#presentChips input')
        states = {pchips.nth(i).get_attribute('data-psec'): pchips.nth(i).is_checked() for i in range(pchips.count())}
        check(states.get('political') is False and states.get('religious') is False and states.get('family') is True, f'sensitive sections default to off: {states}')

        # ---- class view (opened from the analysis page, so it inherits the sign-in) ----
        with ana.expect_popup() as pop:
            ana.click('#openPresent')
        pres = pop.value; watch(pres, 'present')
        pres.wait_for_selector('#main', state='visible')
        pres.wait_for_selector('.histo')
        check(pres.locator('#connections').is_hidden(), 'connections start hidden so the class sees the histogram first')
        check('agreed' in pres.inner_text('#histoNote') and '%' in pres.inner_text('#histoNote'), 'histogram caption says in words how many agreed')
        pres.screenshot(path=f'{OUT}/present_histogram.png')

        # reveal one connection at a time
        pres.click('#nextBtn')
        pres.wait_for_selector('#connBody .conn')
        check(pres.locator('#connBody .conn').count() == 1, 'first click reveals exactly one connection')
        check('Connection 1 of' in pres.inner_text('#connCount'), 'counter says which connection is showing')
        first = pres.inner_text('#connBody .conn-s')
        check(bool(__import__('re').match(r'^Students who (answered|selected|did not).* were (somewhat |much )?more likely to agree with this statement than students who ', first)), f'sentence reads in plain English: {first[:110]}...')
        check(pres.locator('#connBody .cb').count() == 2 and '% agreed' in pres.inner_text('#connBody .cb-pct').replace('\n', ' ').replace('  ', ' '), 'two groups shown with a percent who agreed')
        check(pres.locator('#connBody .luck').count() == 1, 'each card says whether it could be a coincidence')
        pres.screenshot(path=f'{OUT}/present_card1.png', full_page=True)
        pres.click('#nextBtn')
        check('Connection 2 of' in pres.inner_text('#connCount') and pres.inner_text('#connBody .conn-s') != first, 'Next moves to a different connection')
        pres.keyboard.press('ArrowLeft')
        check('Connection 1 of' in pres.inner_text('#connCount'), 'left arrow goes back')
        pres.keyboard.press('ArrowRight')
        check('Connection 2 of' in pres.inner_text('#connCount'), 'right arrow goes forward')
        pres.screenshot(path=f'{OUT}/present_card2.png', full_page=True)

        txt = pres.inner_text('body')
        low = txt.lower()
        for bad in ['p-value', 'p =', 'rho', 'ρ', 'correlat', 'significan', 'spearman', 'q <']:
            check(bad not in low, f'class view never says "{bad}"')
        check('religious identity' not in low and 'importance of religion' not in low and 'how important is religion' not in low, 'religious items are not on the projected page by default')

        pres.click('#allBtn')
        pres.wait_for_selector('#connBody .conn:nth-child(5)')
        n_all = pres.locator('#connBody .conn').count()
        check(n_all >= 5, f'"Show all" lists every connection ({n_all})')
        check('Bigger than luck' in pres.inner_text('#guide') or 'coincidence' in pres.inner_text('#guide'), 'guide explains coincidence in plain words')
        pres.screenshot(path=f'{OUT}/present_all.png', full_page=True)
        pres.click('#hideBtn')
        check(pres.locator('#connections').is_hidden(), 'Hide returns to the histogram only')

        # another statement on screen resets to the histogram
        pres.click('#nextBtn')
        pres.select_option('#pollSel', index=2)
        pres.wait_for_selector('#connections', state='hidden')
        check(pres.locator('#connections').is_hidden(), 'choosing another statement hides the connections again')

        browser.close()
finally:
    srv.kill()

if errors:
    print('\nPROBLEMS:'); [print(' -', e) for e in errors]; sys.exit(1)
print('\nAll browser checks passed. Screenshots in', OUT)
