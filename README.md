# VDB Website QA

An automated website tester for the VDB Shopify store (`https://shopify.vdbapp.com/` by default). It opens the store in a real Chrome browser and checks what a shopper would see. The checks cover:

- **Homepage links:** every menu, slider, banner, CTA and footer link is clicked. The tool confirms each click goes where it should.
- **Deeplinks:** every link URL is opened directly, as if a shopper opened a shared or bookmarked link. The tool checks that the right page opens, filters are kept, results and prices appear, and the page survives a refresh.
- **Products:** product cards on listing pages and their detail pages are checked. Native Shopify products and VDB app pages (Ring Builder, configurator, diamond and gemstone search) are identified correctly.
- **Images:** every image is found and listed. Visible images are downloaded and decoded to confirm they really display.
- **Page speed:** the load time of the homepage and every tested page is recorded, and slow pages are flagged.

The results go into one self-contained **dashboard** (`reports/latest/dashboard.html`) written for non-technical readers. A CSV and a full JSON file are produced alongside it.

---

> **How it validates, what it covers and how results are decided:** see [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

## 1. Install

Requirements: **Node.js 20 or newer** and about 1 GB of free disk space for the browser.

```bash
git clone <this repository>
cd vdb-website-qa
npm install
npm run setup          # downloads the Chromium browser used for testing (first time only)
```

## 2. Run

```bash
npm run qa             # run (or continue) the current testing cycle
```

Open `reports/latest/dashboard.html` in any browser when it finishes. The console prints a one-line summary.

| Command | What it does |
| --- | --- |
| `npm run qa` | Runs everything that still needs testing in the current cycle. Starts a new cycle automatically the first time. |
| `npm run qa:fresh` | Starts a **new testing cycle** and forgets all previous results. Use this for a new release or test round. |
| `npm run qa:retest-failed` | Re-runs only the cases that **failed** in this cycle. Use this after developers fix something. |
| `npm run qa:quick` | A short smoke test: 40 links, homepage and listing pages only, separate report folder. |
| `npm run qa:mobile` | The same checks on a 390 px phone screen, with a separate report and progress file. |
| `npm run qa:phase2` | Runs the **Phase 2 test cases** (Week 1: global search, Diamond Search, Gemstone Search, 44 cases, about 10 min). Results appear in the dashboard's **Test cases** tab. See [docs/HOW-IT-WORKS.md › 9](docs/HOW-IT-WORKS.md#9-phase-2-test-cases). |
| `npm run report` | Rebuilds the dashboard from `results.json` without testing again. |
| `npm run qa -- --help` | Lists all options. |

The exit code is `1` when anything failed, so the tool can gate a CI pipeline.

### Run time and resuming

- **Time budget.** Every run stops starting new tests after `timeBudgetMin` minutes (default **23**). It then writes the report, so a run always finishes in about 20–25 minutes.
- **Saved progress.** Each result is saved to `state/progress.json` as soon as it finishes.
- **Continuing.** If the budget is reached, or you press Ctrl+C, the tests that did not run are shown as **Not run yet**. The next `npm run qa` runs those first.
- **What is not re-run.** Within a cycle, tests that already **passed or failed are not run again**. Their results stay in the report and are marked "kept from an earlier run". The only exceptions:
  - Tests that **could not be verified** (the store was busy, a network drop) are re-tried automatically, up to 3 times.
  - `--retest-failed` re-runs failures on purpose.
  - `--fresh` starts over.

How long a full cycle takes depends on the machine. Most of the time goes into Chrome rendering the store's heavy app pages, so the CPU core count matters most:

Measured on the live store (228 links, 2,235 images found, 1,563 tested):

| Machine | Full cycle |
| --- | --- |
| 2 vCPU cloud container (measured) | 2 runs: 22.5 min (144 links), then 15.1 min (84 links + slow-page re-measuring) |
| 4+ CPU cores, e.g. a modern laptop (estimated) | 1 run of about 20–25 min |
| Previous tool, same store | about 220 min (3 h 40 min) for one run |

The number of parallel browser sessions is set automatically: about 1.5 per CPU core, between 2 and 8. Override it with `--concurrency`.

## Web front end (Streamlit)

`streamlit_app.py` is a web page where anyone can start a test, watch it and read the report, without GitHub or a terminal. The heavy work keeps running on **GitHub Actions** (a real Chrome needs a proper machine). The Streamlit page only starts runs and shows the reports.

**One-time setup (about 10 min)**

1. **Create a GitHub token for the page.**
   1. Go to GitHub → *Settings* → *Developer settings* → *Personal access tokens* → **Fine-grained tokens** → *Generate new token*.
   2. Under **Repository access**, choose *Only select repositories* and pick this repository.
   3. Under **Permissions**, set *Actions: **Read and write*** and *Contents: **Read-only***. Metadata is read-only automatically.
   4. Click *Generate* and copy the token.
2. **Deploy the page.**
   1. Go to [share.streamlit.io](https://share.streamlit.io), sign in with GitHub and click **Create app**.
   2. Pick this repository, branch `main`, and main file `streamlit_app.py`.
   3. Under **Advanced settings → Secrets**, paste:

      ```toml
      GITHUB_REPO   = "your-org/vdb-website-qa"   # owner/repository
      GITHUB_TOKEN  = "github_pat_…"              # the token from step 1
      APP_PASSWORD  = "choose-a-password"          # optional: asks visitors for a password
      # GITHUB_BRANCH = "main"     WORKFLOW_FILE = "qa.yml"   (defaults)
      ```

   4. Click **Deploy** and share the page's link with your team.

**Using it**

- Pick *Test everything*, *Continue the previous cycle* or *Re-test only the failures*, then click **Start test**.
- The run list refreshes every 20 seconds and shows progress. You can close the page; the test keeps running on GitHub.
- When it finishes, the newest report opens automatically. Older runs have a **View report** button.
- Download buttons give the dashboard, the CSVs and the full report zip.

**Running on your own server instead** (no GitHub Actions): install Node.js 20+, run `npm install && npm run setup`, then:

```bash
pip install -r requirements.txt
QA_MODE=local streamlit run streamlit_app.py
```

**Start test** then runs the tool on that machine and shows its live log.

## 3. Configuration

Settings are read from `qa.config.json`; command-line options override them.

| Setting (`qa.config.json`) | CLI option | Default | Meaning |
| --- | --- | --- | --- |
| `baseUrl` | `--base-url` | `https://shopify.vdbapp.com/` | Store to test |
| `timeBudgetMin` | `--budget` | `23` | Minutes after which no new tests start (0 = unlimited) |
| `maxDepth` | `--depth` | `2` | 0 homepage links · 1 + product cards on listing pages · 2 + links on product/detail pages |
| `maxLinks` | `--max-links` | `400` | Cap on unique links tested |
| `cardsPerListing` | `--cards` | `2` | Product cards sampled per listing page |
| `linksPerLandingPage` | – | `60` | Links (other than product cards) clicked on each page opened from the homepage |
| `modalsPerSearch` | `--modals` | `1` | Diamond/gemstone result popups opened per search page |
| `concurrency` | `--concurrency` | auto | Parallel browser sessions |
| `appConcurrency` | `--app-concurrency` | `3` | Parallel loads of app pages (`/apps/...`). Keeps Shopify's app proxy from answering "429 Too Many Requests" |
| `refreshPerPage` | `--refresh-all` sets 0 | `3` | Reload tests per app page type (0 = every page) |
| `confirmSlow` | – | `20` | Pages rated slow that are re-measured alone at the end |
| `perf.fastMs` / `perf.slowMs` | – | `3000` / `6000` | Speed thresholds for "main content ready" (slow = performance issue) |
| `viewport` | `--viewport` | `desktop` | `desktop`, `tablet` or `mobile` |
| `checkExternal` | `--no-external` turns it off | `true` | Open links to other websites (social icons) in a browser and check they still exist |
| – | `--only <regex>` | – | Test only links whose text or URL matches |
| – | `--out`, `--state` | `reports/latest`, `state/progress.json` | Report folder and progress file |
| – | `--headed` | – | Show the browser while testing |

Other tunables (meaningful URL parameters, tracking hosts, blocked third-party hosts) live in `src/config.ts`.

## 4. Reading the report

The dashboard has four tabs.

**Summary** gives the overall verdict and is the page to share with non-technical people. It shows:

- How many links passed, passed with warnings, failed, could not be verified, have not run yet, or were skipped.
- How many problems are **critical**, **performance** or **minor**.
- **What needs attention:** problems grouped by type. Each group says what is wrong, who usually fixes it (developer or store admin) and where it happens.

**Homepage & speed** shows:

- The homepage load times, explained in plain words.
- The slowest pages.
- A sortable table of the load time of every page.
- Every homepage link, slider, CTA and button: what it should open, and what clicking it actually opened.
- Menus, sliders, the popup and header search as component checks.

Every row has a **position**: where the link sits on the page, for example *Mega menu › Engagement Rings › Shop By Metal*, *Homepage › Hero slideshow › Mini slider › Slide 2 of 6*, or *Footer › Diamonds*. Each visible place is listed and clicked separately, even when several places open the same URL. The page behind that URL is tested once, and its result is shown for every place. The **Mega menu icons & images** table checks every icon in every open menu panel, at any size.

**Deeplinks** lists every link URL tested, with its position (and how many other places use it). You can filter it by result (failed, passed, and so on), where the link was found, and product type. Each row shows the link URL, the expected page, what actually happened, and the reason for any failure. Click a row for:

- An explanation of each problem and the suggested fix.
- A screenshot.
- The product data.
- The technical check list.

Back-button behaviour is not tested. **Download CSV** exports the table. `homepage-links.csv` in the report folder lists every homepage placement.

**Images** shows the totals: images found, tested, loaded and displayed, broken, could not verify, and skipped. Below the totals, every image problem is listed with the file URL, the reason and the page it appears on. Skipped images are listed with the reason they were skipped. You can browse the full list of tested image URLs with previews.

### Result types

| Result | Meaning |
| --- | --- |
| ✓ **Passed** | Works as expected |
| ! **Passed with warnings** | Works, but has a minor or speed issue |
| ✕ **Failed** | A shopper would hit a real (critical) problem |
| ? **Couldn't verify** | The test could not check it (store busy, login needed). Re-tried next run |
| … **Not run yet** | The time budget was reached. It runs first next time |
| – **Skipped** | Out of scope on purpose (external sites, in-page jumps, over the link cap) |

### Severity

| Severity | Examples |
| --- | --- |
| **Critical** | The page does not open (404/500), the wrong page opens, a click does nothing, filters are lost, there are no results or wrong results, the price is missing, a product image is broken, the page breaks on refresh |
| **Performance** | Main content takes longer than `perf.slowMs` (6 s) to appear. The page is re-measured alone to confirm |
| **Minor** | Placeholder text, a result counter that doesn't match, a menu label that doesn't match its filter, a product title shape that isn't among its options, decorative image problems, a required option with no feedback message |

### Speed measurements

The numbers come from Chrome's own timing data:

- **Server responded:** time to first byte.
- **Page structure ready:** DOMContentLoaded.
- **Largest image or text visible:** LCP.
- **Main content ready:** the later of LCP and the moment the page's own content appeared (results, product, stock number). The speed rating is based on this number.
- **Fully loaded:** the load event.

Pages rated slow during the busy parallel run are re-measured one at a time at the end, so the slow list is reliable. Absolute times depend on where the test runs, so use them to compare pages and track changes.

## 5. How it works

```
src/run.ts         entry point: resume/cycle logic, task pool, time budget, report
src/discover.ts    homepage: header, mega menu (hover), sliders (arrows/dots/autoplay/drag), popup, footer
src/clicks.ts      click tests: the navigation is intercepted (HTTP 204), so one page tests many clicks
src/validate.ts    deeplink test of one URL; finds and click-tests product cards on listing pages
src/content.ts     page-type content checks (results, counts, filters, modals, placeholder text)
src/products.ts    product classification (Shopify product vs VDB app) using /products/<handle>.js
src/images.ts      image discovery, load + decode checks, skip reasons
src/perf.ts        page timing from the Navigation Timing API + LCP
src/throttle.ts    app-proxy rate limiting (prevents HTTP 429 noise)
src/state.ts       progress file (resume, skip finished cases)
src/severity.ts    plain-language explanations, severity and suggested fixes per check
src/report.ts      totals, image report, CSV, results.json
src/dashboard.ts   the HTML dashboard
```

**Why it is fast.** The previous version took about 3.5 hours for a full run. This version:

1. **No back-button tests and no separate crawl pass.** Product cards are discovered while their listing page is open.
2. **Clicks are intercepted** instead of loading each destination. The destination is tested once, by its own deeplink test.
3. **Requests to the ring builder and search apps are spaced out** (`appConcurrency`). On "429 Too Many Requests" all app loads pause briefly and retry, which removed the large serial re-test of false failures.
4. **Deeplink tests skip work that is never validated:**
   - The 3D ring viewer (WebGL) is not rendered. In software rendering it kept a CPU core busy for every ring builder page. The ring builder pages show their photos instead.
   - CSS animations, analytics sandboxes, survey embeds, Lottie animations, web fonts and videos are skipped.
5. **Faster image checks.** Images load in parallel without scrolling to each one. An image already verified on another page is not waited for again.
6. **Shorter waits.** Waits match each page type's content instead of fixed sleeps. Reload tests are sampled per app page type.

**Product classification.** Product links are classified using Shopify's own product data (`/products/<handle>.js`):

- **Shopify product:** a native product page, often synced from VDB jewelry inventory (tags `VDBJL`, `vdb_stock_num_…`).
- **Ring configurator:** the VDB app on the placeholder `configure-engagement-ring` product.
- **Ring Builder setting / stone:** a VDB app page, not a Shopify product.

The "title matches product data" check compares the shape in the title with the product's real *Supported Shape* option values. The old check read the first selected variant instead, which falsely reported multi-shape "Round" rings as mislabelled.

## 6. Maintenance

- **Store theme changes.** Selectors for cards, prices and menus live in `src/content.ts` (`CARDS`), `src/discover.ts` and `src/products.ts`.
- **Wording.** Plain-language texts, severities and suggested fixes are in `src/severity.ts`.
- **Updating Playwright.** Run `npm install playwright@latest && npm run setup`.
- **Type check:** `npm run typecheck`.
- **CI.** `.github/workflows/qa.yml` runs weekly and on demand, and uploads the report as a build artifact.

`reports/` and `state/` are git-ignored. Each machine keeps its own progress.
