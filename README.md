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
3. **Class view** (`/present.html`, opens in a new tab, for the projector): shows the histogram first. Press **Show what lines up** (or the right-arrow key) to reveal one plain-English comparison at a time; **Back** / left arrow goes back, **Show all** lists them, **Hide** returns to the histogram. It only ever shows class-level comparisons (see "Class view").
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
- **Verification in this folder:** `npm test` (API, parsing, privacy, rendering, power and null-poll behavior). `python3 test/e2e.py` drives a real Chromium through every page (needs `pip install playwright`). `python3 test/crosscheck.py [folder]` recomputes every heat-map cell with SciPy and re-derives every class-view card (group sizes, who agreed, ordering, the luck line) from the raw CSV files.

## Class view (`/present.html`)

For projection. After the histogram, each "connection" is one card:

> **On the survey:** How important is religion in your life?
> Students who answered **"Somewhat important or Very important"** were **more likely** to agree with this statement than students who answered **"Not at all important or Not too important"**.
> 61% agreed (41 of 67 students) · 30% agreed (23 of 76 students)

Each bar splits a group into disagreed / neutral / agreed on the statement just polled.

**How a card is made.** For each survey question the students are split into two groups by their survey answer (yes/no for a single answer or a select-all option; for ordered questions, the most balanced cut-point that leaves at least 5 students on each side). The card reports, for each group, the share who answered Agree or Strongly agree on the poll. Cards appear only if the two shares differ by at least 20 percentage points. The group with the higher share is named first ("more likely").

**Order.** Strongest first, where "strongest" means the gap that stands out most *given the group sizes* (a 40-point gap between 70 and 70 students outranks the same gap between 7 and 9). The first screens cover different survey questions: the best card for each question comes first, second helpings (a different answer to the same question) after. Mirror images (the Yes row and the No row of a two-answer question) are dropped. At most 30 cards.

**"Could be a coincidence" / "Bigger than luck usually makes."** Each card carries one of these two plain notes. The server shuffles who said what on the poll many times (500 shuffles; the survey groups stay fixed), records the most striking gap among *all* the comparisons on offer each time, and takes the level that shuffled data exceeds only 1 time in 10. A card gets the second note only if it beats that level. So the note already accounts for how many questions were compared. The "how to read this" box turns the same calculation into one sentence: how many points two typical-sized groups need to differ before luck stops being a likely explanation. With about 25 students that is roughly 60–70 points, so almost every card will say "could be a coincidence". That is the truth about small classes, not a defect. I checked the calibration with pure-noise polls: 12% of noise polls at 28 students (60 polls) and 15% at 160 students (100 polls) produced at least one "bigger than luck" card, against a design target of 10%. Treat the label as a rough guide.

The server (not the browser) enforces these rules:
- A comparison appears only if **both** groups have at least **5 students**.
- No student codes, no individual answers, no names. Only group sizes and group percentages are sent to the page. Correlations, p-values and the chance table are not sent at all.
- **Political and religious sections are off by default.** Switch them on in section 5 of the Analysis page if you want them projected.

Be aware that a group of 5 in a class of 25 is one fifth of the room. Classmates may be able to guess who "the 5 students who …" are. Preview the page before projecting, and keep the sensitive sections off unless you are confident. A minimum group size is a standard rule of thumb for disclosure control, not a guarantee.

**Limits of this view.** It looks only at agreeing (Agree + Strongly agree). If nearly everyone agrees (or nearly everyone disagrees) with a statement there is little to compare and few cards will appear; your own Analysis page still shows the full picture. It does not control for related questions moving together, so two cards about similar survey questions are one finding, not two. And it cannot say why.

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
lib/analysis.js        correlations, q-values, chance check, class-view cards and rules
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
- `lib/codebook.json` records each question's type (single, matrix, select-all, pick-one-from-list) and wording; the class view quotes that wording. If you change the survey, rebuild it as described above.
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
