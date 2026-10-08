# Class Poll + Survey Heat Map

A small, self-hosted tool for a first-year seminar. Students answer 5-point agree/disagree statements on one link, using the last 4 digits of their student ID. You then see how each poll lines up with the Qualtrics survey they completed earlier, and with your earlier polls, as a heat map. Zero npm dependencies (Node's built-ins only).

## Where does the survey file go? Nowhere in GitHub.

You chose "server memory only", so the survey export is **never committed, never saved on the server's disk, and never logged**. Each class session:

1. Open `https://YOUR-APP.onrender.com/analysis.html` and enter your instructor key.
2. In section 1, drop in the Qualtrics CSV export. It is parsed and held in the server's RAM.
3. When you finish, click **Remove survey data from the server** (or just let the server restart; it also disappears then).

The upload goes over HTTPS to your own server. The pages load no outside scripts, fonts, or services, and a Content-Security-Policy header makes the browser refuse to contact any other host.

**How to export from Qualtrics:** Data & Analysis → Export Data → CSV. Either "Use choice text" or "Use numeric values" works (auto-detected). The file needs the column with each student's last 4 digits (it finds `StudentLast4`, `Last4`, and similar names; otherwise it asks you to pick the column). The three Qualtrics header rows are handled. Preview/test responses are skipped.

`sample-data/` contains **fake** files in the same format so you can try everything. They are safe to commit; real CSVs are blocked by `.gitignore`.

## Updating the copy you already deployed on Render

1. Replace the files in your GitHub repo with the contents of this folder (keep your own `.git` folder). Typical commands:
   ```bash
   git add -A && git commit -m "Add survey analysis" && git push
   ```
2. Render redeploys automatically if auto-deploy is on; otherwise choose **Manual Deploy → Deploy latest commit**. Your `INSTRUCTOR_KEY` environment variable stays as it is.
3. The student link (`/`) and `/instructor.html` keep their addresses. New pages: `/analysis.html` and `/present.html`.

**What changed that you will notice:**
- Polls are now always the 5-point scale (Strongly disagree … Strongly agree). You type only the statement.
- Student codes must be exactly 4 digits (1–3 digits are padded with zeros: `457` → `0457`). The old "append a first initial" trick no longer works.
- Starting a new statement automatically closes the previous one.
- The instructor key is sent in a request header, not in the URL.
- Old polls that were not 5-point scale are kept but ignored by the analysis.

## Running a session

1. **Before class:** open `/analysis.html`, upload the survey. (After any restart, or after Render's free tier has gone to sleep, upload it again.)
2. **In class:** on `/instructor.html` type a statement and press **Start poll**. Students open the home link and vote. When you press **Close poll** (or start the next statement) the histogram appears on their screens.
3. **Class view** (`/present.html`, opens in a new tab, for the projector): shows the histogram first. Press **Show patterns** when you want to reveal what lines up with it. It only ever shows class-level patterns (see "Class-safe view").
4. **Your view** (`/analysis.html`): the full heat map, the chance check, and a click-through breakdown for every cell.
5. **After class:** press **Download all poll responses (CSV)** on the poll console and keep it somewhere private.

### Render free tier: what survives
Render's free web services sleep after a period of inactivity and use a disk that is wiped on restart and redeploy (check Render's current documentation; this is how it worked when I last knew it). Consequences:
- The survey is gone after any sleep or restart. Re-upload it. This is by design.
- **Poll history is also lost** unless you mount a Persistent Disk (paid) and set the environment variable `DATA_DIR` to its mount path (e.g. `/var/data`), **or** you re-import your downloaded poll CSV (Analysis page → "Restore earlier poll results"). Without one of these, cross-poll comparisons across weeks do not work. The simplest free approach: download the CSV after every class and re-import it when needed.

## Reading the heat map

- **Rows** are survey variables (202 columns from your QSF, expanded into about 235 rows, plus one row for each other poll). **Columns** are polls P1, P2…, numbered in the order the statements were run. Statements with fewer than 8 responses are skipped, so a number can be missing.
- **Cell value** is Spearman's ρ (rank correlation) over the students who answered both. **Orange** = students who score higher on the survey variable agreed *more* with the statement; **blue** = *less*. Strength words follow common conventions (|ρ| < .1 negligible, < .3 weak, < .5 moderate, otherwise strong), which are rules of thumb, not tests.
- **Direction of survey variables:** ordered questions are scored so higher = more (religion importance, conservatism, frequency). Unordered single-choice questions (party ID, religious identity, high school type, …) become one yes/no row per option. Select-all questions become one yes/no row per option. "Not sure" is treated as missing.
- **Every correlation is displayed**, as you asked. Markers show which ones are unlikely to be luck: `**` q < .05, `*` q < .10 (false-discovery-rate adjusted within each poll), `†` raw p < .05 only (usually not trustworthy at this many comparisons).
- **Poll rows** (other polls) work the same way, which is how you find patterns across polls.
- **Click a cell** for the breakdown: how each group of students answered, with counts and means.
- **Click a poll heading** to sort rows by that poll. Controls: top N, minimum |ρ|, only q < .10, search, section and poll filters, CSV download of the rows shown.

### The honest limits at seminar size

I tested the pipeline against an independent SciPy computation of every cell (1,404 cells in the 28-student sample and 1,536 in the 160-student one; no mismatches beyond rounding) and against simulated chance. The problem is not the arithmetic; it is the arithmetic of small samples:

- With ~25 matched students and ~235 comparisons per poll, chance alone puts the strongest "random" correlations around |ρ| ≈ .5–.6. In the 28-student fake data, relationships I **planted** at roughly ρ ≈ .45 mostly did not stand out, and one came out near zero. At 160 fake students all of them were found with q < .001 (`test/power.test.js`).
- So at 25 students a strong-looking cell is a **lead for discussion**, not a finding. Section 3 of the Analysis page shows, for each poll, how many correlations you see at |ρ| ≥ .3 / .4 / .5 / .6 next to how many pure chance would produce, and says in plain words whether you are above chance.
- Related survey items move together (all the AI-use items, for example), so one real relationship appears as many orange or blue cells. They are not independent findings, and the chance table does not account for that, so it can overstate "more than chance" when one cluster dominates.
- If you teach several sections, you can pool them (upload one combined export; use unique last-4 codes) to gain power. Pooling is the most effective fix.
- This design compares what students said at two times, with self-selection into who answered. It cannot show cause. Students who miss class or the survey are missing from the pairs.

### Method notes
- **Correlation:** Spearman's rank correlation, pairwise-complete, minimum 8 pairs. Tied ranks use average ranks. Both ordinal and 0/1 variables are handled by the same formula.
- **p-values:** two-sided permutation test (2,000 shuffles, extended up to 60,000 for strong cells, seeded so results do not change on refresh); p = (exceedances + 1) / (shuffles + 1) as recommended by [Phipson & Smyth (2010), *Stat. Appl. Genet. Mol. Biol.* 9(1), Art. 39](https://ideas.repec.org/a/bpj/sagmbi/v9y2010i1n39.html).
- **Multiple comparisons:** Benjamini & Hochberg (1995) false-discovery-rate adjustment, *J. R. Stat. Soc. B* 57(1), 289–300, applied separately to each poll's column.
- **Chance check:** expected number of |ρ| ≥ t among unrelated variables = Σ over cells of 2·[1 − Φ(atanh(t) / √(1.06/(n − 3)))], the Fieller–Hartley–Pearson variance approximation for Spearman's ρ ([*Biometrika* 44(3–4), 470–481, 1957](https://doi.org/10.1093/biomet/44.3-4.470)). I checked it against 200,000-shuffle simulations for n = 12 to 100: within about 10% of the simulated tail, slightly conservative at small n.
- **Verification in this folder:** `npm test` (28 tests: API, parsing, privacy, rendering, power and null-poll behavior). `python3 test/e2e.py` drives a real Chromium through every page (needs `pip install playwright`). `python3 test/crosscheck.py` recomputes every cell with SciPy.

## Class-safe view (`/present.html`)

For projection. The server (not the browser) enforces these rules:
- A survey variable appears only if **both** groups being compared have at least **5 students**. Ordered variables are split at the most balanced cut-point that satisfies this.
- No student codes, no individual answers, no names. Counts are group totals.
- **Political and religious sections are off by default.** Switch them on in section 5 of the Analysis page if you want them projected.
- It shows the same "how much to trust this" caution as your own view.

Be aware that a group of 5 in a class of 25 is one fifth of the room. Classmates may be able to guess who "the 5 students who …" are. Preview the page before projecting, and keep the sensitive sections off unless you are confident. A minimum group size is a standard rule of thumb for disclosure control, not a guarantee.

## Privacy: what is stored where

| Data | Where | Persisted? |
|---|---|---|
| Poll answers + last-4 code + timestamp | server disk `data/data.json` (or `DATA_DIR`) | yes, unless the host wipes the disk |
| Survey export | server memory only | no; gone on restart or "Remove survey data" |
| Heat-map numbers | computed on request from the two above | no |
| Student's last-4 code | their own browser (`localStorage`), so they do not retype it | on their device |
| Instructor key | your tab's `sessionStorage` while the tab is open | no |

Nothing is sent to Anthropic, analytics services, or any other third party by this code; the pages make requests only to your server. Your hosting provider (Render) does operate the machine whose memory holds the survey while it is loaded, and sees encrypted traffic metadata. **That may matter for FERPA and your institution's vendor rules.** I am not a lawyer; ask your registrar or IT/privacy office whether an institution-approved vendor is required for education records. The survey's own promise to students ("not shared with anyone but your instructor … class trends may be presented") is consistent with what this tool does, provided you stay within it.

**Strictest option:** keep Render only for students' voting. Download the poll CSV after class, run a second copy on your own computer (`npm start`, open `http://localhost:3000/analysis.html`), and upload both files there. The survey then never leaves your laptop.

### Known limitations
- Last-4 codes are not authenticated. Anyone who knows a classmate's four digits can vote as them or, via the student page, see that student's recorded answer for the current poll. This is the cost of using no login. In a class of 25 about 3% of the time two students share the same four digits; the tool excludes such students from the analysis rather than merging them. Combined sections (100 students) collide about 40% of the time; use a different identifier column in that case.
- The instructor key is a shared passphrase. Use a long one and HTTPS only.
- Requests are not rate-limited. This is built for a classroom, not the open internet.

## Files

```
server.js              HTTP server and all routes (Node built-ins only)
lib/analysis.js        correlations, q-values, chance check, class-safe rules
lib/stats.js           Spearman, permutation test, Benjamini-Hochberg, chance formula
lib/survey.js          Qualtrics export parser (header rows, text/numeric modes, ID matching)
lib/codebook.json      how each survey column is scored (generated from your .qsf)
lib/csv.js
public/                index.html (students), instructor.html, analysis.html, present.html,
                       common.js, render.js, page-*.js, style.css
tools/build-codebook.js   rebuild codebook.json:  node tools/build-codebook.js your.qsf
tools/make-sample-data.js fake data:  node tools/make-sample-data.js [--n 160] [--out DIR]
sample-data/           FAKE survey and poll files
test/                  automated tests
```

**If you change the survey** (new questions, new semester), re-run `node tools/build-codebook.js path/to/new.qsf` and push. The Analysis page reports how many expected question columns it found in the upload; a mismatch means the codebook and the export are out of step.

## Notes on the survey file (from reading your QSF)
- **Q56** (generative AI tools used) says "select all that apply" but is configured as a single-answer question in Qualtrics, so students could pick only one. It is analyzed as single-choice.
- **POL2** (party lean) sits in Qualtrics' Trash block and is not in the exports, so it is not analyzed.
- The AI items Q55–Q59 are grouped into their own "Generative AI" section, though Qualtrics places them at the end of the Academic block.

## Running locally

Node 18 or newer.
```bash
cp .env.example .env     # set INSTRUCTOR_KEY
npm start                # http://localhost:3000/
npm test
```
Docker: `docker build -t class-poll . && docker run -p 3000:3000 -e INSTRUCTOR_KEY=your-key class-poll`.
