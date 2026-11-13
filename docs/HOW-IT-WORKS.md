# How the VDB Website QA tool works

This page explains **what the tool covers**, **how each check works** and **how a result is decided**. It is written for testers, managers and developers alike.

---

## 1. What is covered

| Area | What is tested |
| --- | --- |
| **Header** | Announcement bar links, logo, top menu links, icons (wishlist, cart), and **CUSTOM DESIGN**: its "DESIGN YOUR DREAM RING" popup must open, show its text, images and START DESIGNING button, move on when that button is clicked, and close with × |
| **Mega menu** | Every top item is hovered. Every link and every icon or image in each open panel is tested. |
| **Homepage sections** | Hero section (main slider and mini slider), product sliders, "Diamonds Shape", "Shop By Collection", "Fine Jewelry" banners, "Discover Our Tennis Necklaces", "Shop By Color", the About banner and any other section with links |
| **Footer** | Every link in every column, social icons and policy links |
| **External links** | Social icons and any link to another website, opened in a real browser |
| **Every page opened from the homepage** | Each page a homepage link opens (collections, DEMO CENTER, diamond/gemstone search, Ring Builder lists, About…) is crawled too. **Every visible link in its main content is recorded and clicked**: hero buttons such as SHOP ALL, collection sliders (e.g. Necklaces, Halo Studs… under the Hoop Earrings banner), tabs (e.g. 01 Ring Creator on DEMO CENTER), cards and CTAs. Every new URL found there gets its own deeplink test. Product cards are sampled (two per listing) plus the next-page link. The header and footer are the same on every page and are covered on the homepage. |
| **Product / detail pages** | Shopify products, the VDB ring configurator, and Ring Builder setting and stone pages. Up to two links per detail page are followed, for example "Select Setting". |
| **Images** | Every image on every tested page, plus mega-menu icons of any size |
| **Page speed** | Homepage and every tested page |
| **Journeys** | Header search (a word with results, a word with none), two diamond searches in one visit (do filters leak from one to the next?), the scroll popup, every slider's arrows, dots and autoplay |

**Not covered:**

- Checkout and payment.
- Customer login and account pages (there is no test account).
- The 3D viewer drawing itself. It is switched off during page tests to save CPU; the page around it is still tested.
- Back-button behaviour (excluded on request).
- Content correctness beyond what is listed below, for example whether a description is well written.

---

## 2. Positions: where each link is

Every visible link on the homepage is recorded **once per place it appears**, with the **exact text shoppers see**:

| Example position | Link text |
| --- | --- |
| Mega menu › ENGAGEMENT RINGS › DESIGN YOUR OWN RING | Start with a Natural Diamond |
| Homepage › Hero section › Mini slider › slide 2 of 5 | 3D RING BUILDER |
| Homepage › FINE JEWELRY › item 1 of 4 | SHOP NECKLACES |
| Homepage › DISCOVER OUR TENNIS NECKLACES | SHOP NECKLACES |
| Footer › DIAMONDS | Search Natural Diamonds |
| Footer › Social icons | Instagram |

- **Same URL in several places.** When the same URL appears in several places (for example SHOP NECKLACES in two sections), each place gets its own row and its own click test. The page behind the URL is opened and checked once, and that result is shown on every row.
- **Image links.** An image link and a text link inside the same card or menu item are one place; the text is used as the name.
- **Links on pages opened from the homepage** show the **route a shopper takes from the homepage**, then where the link sits on that page, for example:

  `Mega menu › FINE JEWELRY › DIAMOND EARRINGS › "Hoop Earrings" › Hoop Earrings › Slider › slide 9 of 12` (text: **Halo Studs**)

  `Footer › FINE JEWELRY › "DEMO CENTER" › Sales Demo Center` (text: **01 Ring Creator**)

  This reads: open the mega menu, go to FINE JEWELRY, click "Hoop Earrings" under DIAMOND EARRINGS, then on that page click "Halo Studs" in the slider.

---

## 3. How a link is validated

Every link goes through two independent tests.

### A. Click test: does clicking it work?

The tool behaves like a shopper:

1. Opens the page where the link is (the homepage, or the listing or product page).
2. **Reveals the link the way a shopper would:**
   - hovers the mega-menu item;
   - moves the slider to the right slide (autoplay is paused, so the slider cannot move between aiming and clicking);
   - closes the "Want to speak to our team?" popup.
3. **Clicks** the link.
4. Records **where the browser goes**. The click is intercepted at that moment, so the page stays put and the next link can be clicked straight away.

**Links that open a new tab** (social icons, WhatsApp) are handled the same way. The click passes when the new tab goes to the linked site, even if that site immediately redirects, for example to its login page or from wa.me to api.whatsapp.com.

Result:

- **Passed:**
  - the click goes to the URL in the link;
  - or it opens a drawer or popup on purpose (for example the cart);
  - or it shows a message asking the shopper to choose something first.

  The last case covers the ring builder's "Select Setting" button: it shows the browser popup **"Please select ring size"** and stays on the same URL, which is correct.
- **Failed:**
  - the click goes somewhere else;
  - or nothing happens at all: no navigation, no popup, no message.

  "Nothing happens and no message" is a **critical** failure.

### B. Deeplink test: does the page behind the link work?

The URL is opened **directly in a brand-new browser**, like someone opening a shared or bookmarked link. These checks run in order:

| # | Check | Passes when | Fails when |
| --- | --- | --- | --- |
| 1 | Page opens | The server answers with HTTP 200/30x | 404, 500, a redirect loop or a timeout |
| 2 | Right page | The page type matches the link: collection, product, diamond search, Ring Builder… | The visitor is sent to the homepage, to the Ring Builder start page (item no longer exists), or to a login page |
| 3 | Filters kept | Shape, colour, gem type, stock number and similar URL filters are still in the final URL | A filter is lost or changed |
| 4 | Content appears (placeholder "skeleton" cards and a "0 Products" counter shown before the data arrives are ignored) | **Lists:** result cards appear, or a proper "no results" message (only acceptable for wishlist and cart). **Products:** title and price appear. **Ring Builder items:** the stock number from the link is shown. | Nothing renders, or a linked category shows 0 results |
| 5 | Results match the filter | Card names match the shape, colour or gem the link asks for | Cards for other shapes or colours appear |
| 6 | Product cards complete | Every card has a name, price and image | Something is missing (minor) |
| 7 | Item details open | On diamond and gemstone search, clicking a result opens its detail view with a stock or report number and images | The detail view does not open |
| 8 | Product data correct | For Shopify products: the shape named in the title is one of the product's real "Supported Shape" options, read from Shopify's own product data | The title names a shape the product is not offered in (minor) |
| 9 | Images | Every visible image downloads and decodes into a real picture | A file is missing (404), the server errors, or the picture is not valid |
| 10 | Refresh | On app result pages (Ring Builder, diamond and gemstone search), reloading shows the same number of results. Three pages per page type are tested. | Results disappear or change on reload. If a second reload works, it is reported as minor and intermittent. |
| 11 | Speed | The time until the main content is visible is recorded | Main content takes longer than 6 s, re-measured on its own to confirm. This is a performance issue. |

**In-page links** (`href="#…"`, like CUSTOM DESIGN or the DEMO CENTER tabs) do not open a new page, so they are checked by clicking them on their page:

- **Popup:**
  - it must open;
  - it must show content (a heading and a button);
  - its images must load and display;
  - a "Start…/Next" button must move on to the next step (nothing is submitted);
  - it must close with its × button.
- **Tab or jump:** the visible content must change, or the page must scroll to the section.
- **Fails** when nothing happens at all.

**External links** (social icons and other websites) are opened in a real browser:

- **Passes** when the site opens.
- **Fails** when the site returns 404 or 500, or shows "page not available" or "channel does not exist".

Social sites (Facebook, Instagram, LinkedIn, X, TikTok, Pinterest) hide pages from visitors who are not logged in. From cloud servers such as GitHub's, Facebook even shows "This content isn't available" for pages that exist. For these sites:

- Only a real "not found" (HTTP 404/410) counts as broken.
- If the site answers normally, the link **passes**, with a note that the page content could not be read.
- If the site refuses automated visitors ("too many requests"), the link shows as **couldn't verify**; check it by hand.

**Template / placeholder text** ("This is a placeholder text…") is accepted on this store. It is recorded for information only and never counts as a warning or failure.

### C. Re-test of failures: no false alarms

Many pages are tested in parallel, and the store sometimes answers slowly or says "too many requests". So **every failure is re-tested once on its own**, after the main pass:

- **Fails again:** reported as **Failed**, marked "confirmed: failed again when re-tested on its own".
- **Passes the second time:** reported as **Passed**. A note records that the first attempt failed while the store was busy.

Homepage clicks that failed are also clicked again on a fresh homepage.

On top of that, while testing:

- requests to the store's apps (`/apps/…`) are spaced out;
- on "429 Too Many Requests" every app request pauses briefly and is retried;
- a bot-protection page ("Performing security verification") is reported as "Couldn't verify", never as a site failure;
- the store's apps load their own scripts through the same rate-limited app proxy. The tool downloads each of those files **once** and shares it between all its browser sessions, so the proxy is not flooded.
- If the store still refuses a page's own app files ("429 Too Many Requests") and the page then shows nothing, the result is **Couldn't verify** (re-tested after a 30-second pause), not Failed.
- **Empty result lists are explained.** The tool reads what the store's data service (Ring Builder / VDB search API) answered. If the service itself returned "0 results" for that search, the report says so: the page is fine, and the search data or filters behind the link are the problem. This happens intermittently with *Start with Setting* (`rb-setting-list?in_journey=true`).
- **"Share this item" buttons** (WhatsApp, Facebook, X, Pinterest, email share on each diamond) are not counted as site links.

---

## 4. How the result of a row is decided

| Result | Rule |
| --- | --- |
| ✕ **Failed** | At least one **critical** check failed, and the failure was confirmed on re-test |
| ! **Passed with warnings** | Only **minor** or **performance** checks failed |
| ✓ **Passed** | Every check passed. Accepted template text does not change this. |
| ? **Couldn't verify** | A check could not run (bot protection, a site that blocks automated visitors, network). Re-tried automatically on the next run, up to 3 times. |
| … **Not run yet** | The time budget was reached; it runs first on the next run |
| – **Skipped** | Out of scope on purpose (in-page jump links, over the link limit) |

For a homepage row, the worse of its own **click test** and its URL's **deeplink test** is shown.

**Severity**

- **Critical:**
  - the page does not open, or the wrong page opens;
  - a click does nothing, with no message;
  - filters are lost;
  - no results, or wrong results;
  - item details do not open;
  - the price or stock number is missing;
  - a product image is broken;
  - the page breaks on refresh every time;
  - an external site no longer exists.
- **Performance:** the main content takes more than 6 s, confirmed by measuring the page alone.
- **Minor:**
  - a results counter that does not match the cards;
  - incomplete cards or duplicates;
  - a menu label that does not match its filter;
  - a title shape that is not among the product's options;
  - decorative images;
  - results that disappear only sometimes on refresh.

---

## 5. Images

For every tested page, every `<img>` and every visible CSS background image is listed.

- **Tested:** visible images at least 16 px in size (any size in mega menus), and images inside slider slides, even ones not currently showing. Lazy images are told to load immediately. Each image must download and decode into a picture with a real size.
- **Skipped, with the reason shown:**
  - hidden images (closed menus, the mobile menu copy, alternate views);
  - icons smaller than 16 px outside the menus;
  - tracking pixels.
- **Couldn't verify:** the image server was busy (HTTP 429/503) and a second request also failed.

An image URL already verified on another page is not waited for again.

---

## 6. Page speed

Timings come from Chrome's own measurements:

| Timing | What it means |
| --- | --- |
| Server responded | Time to first byte |
| Page structure ready | DOMContentLoaded |
| Largest image/text visible | Largest Contentful Paint (LCP) |
| Main content ready | The later of LCP and the moment the page's own content appeared (results, product, stock #) |
| Fully loaded | The load event |

During the parallel run, times are inflated, so they are marked **(busy)**. Pages that look slow are re-measured **one at a time** at the end (marked ✔). Only confirmed numbers raise a performance issue.

---

## 7. Run time, time budget and "Not run yet"

- **Time budget.** A run stops **starting new tests** after `timeBudgetMin` minutes (default **23**). The tests already running finish, and the run keeps time at the end for:
  - re-testing failures alone (up to about 5 minutes, depending on how many failed);
  - re-measuring slow pages;
  - writing the report.

  So **one run always ends at about 23–25 minutes**, however big the site is.
- **"Not run yet".** If the budget is reached before every link is tested, the remaining links show as *Not run yet – the time budget was reached, it runs first next time*. Nothing is lost: run the tool again with **Continue** (`npm run qa`). It skips everything already tested and starts with these links.
- **Typical turnaround on the live store:**
  - **On GitHub:** one run tests about 220 links and their pages in about 20 minutes. Your 5 Nov run tested 222 links in 20.4 min and left 3 for the next run.
  - **With the wider crawl** (every link on pages opened from the homepage) there are more places to click, but few new URLs. Expect one run plus a short "continue" run of 5–10 min for a complete cycle.
  - **A 2-CPU machine** needs 2–3 runs.
- To finish in **one** run on a slower machine, raise the budget (`--budget 45`, or `timeBudgetMin` in `qa.config.json`; GitHub allows up to 45 min in the workflow), or lower `cardsPerListing`.

## 8. Speed and resuming

- One browser session runs per 1.5 CPU cores, capped at 8. App pages are limited to 3 at a time.
- A run stops starting new tests after **23 minutes**, keeping time at the end for the re-test of failures and the report.
- Progress is saved after every test. The next run:
  - **continues** with what is left;
  - keeps finished results, including failures, in the report;
  - re-tries "Couldn't verify" cases.
- `--retest-failed` re-runs failures after a fix. `--fresh` starts a new testing cycle.

## 9. Phase 2 test cases

Phase 2 runs the cases from the test case sheet ("VDB Demo Store Automation – Final Test Cases") as real shopper journeys. **Week 1** is built: 44 cases.

| Area | Cases | What the test does |
| --- | --- | --- |
| Global search | SR-01 – SR-07 | Types in the header search, reads the suggestions panel, opens results, uses the Availability / Price / Metal Type filters and the sort menu, searches a nonsense word and special characters, closes the panel. |
| Diamond Search | DS-01 – DS-26 | Sets each filter like a shopper (clicks shapes, drags the Color / Clarity / Cut sliders, types carat and budget), presses Search and checks **every diamond on screen** against the filter. Also sort, infinite scroll, Modify / New / Clear Search, stock number, share, the detail panel (video, certificate, Have a Question, Book an Appointment, Close) and Add to Cart. |
| Gemstone Search | GS-01 – GS-11 | Same for gemstones: type, single/pair, shape, carat, price, ratio, lab, treatment, sort, infinite scroll, Clear Search, collapsing Search Options, detail panel and Add to Cart. |

**How a result is decided**

- **What is compared.** Results are read twice: from the cards on screen (name, carat, price) and from the data the store's search service sent to the page for those same cards. A card fails if either one does not match the filter.
- **Passed.** Everything the sheet expects happened.
- **Failed.** The store did something different from the sheet. The reason names the cards or values that were wrong, and a screenshot is attached.
- **Passed with warnings.** It works, but something is worth a look. For example, a filter the sheet mentions is not offered, or demo prices look unrealistic.
- **Couldn't verify.** The test could not decide. Typical reasons:
  - no stock matches (for example, no ruby pairs);
  - an earlier step on the same page did not work;
  - the page did not respond.

  These are not counted as failures.

**What is never done**

- No form is submitted (contact, question, appointment, share, newsletter).
- Nothing is bought.
- *Add to Cart* uses a temporary cart that disappears with the test browser.

**Running it**

- **Streamlit or GitHub:** choose *Phase 2 test cases*.
- **On your computer:** `npm run qa:phase2`.

It runs separately from the link check, so the link check keeps its 20–25 minutes. A Phase 2 run shows the latest link-check results in the other tabs, and a link-check run shows the latest Phase 2 results in the Test cases tab.

Screenshots of link-check failures are only in the link-check run's own report.

**Changing a case**

- The case wording comes from the sheet, in `src/journeys/catalog.ts`.
- The checks are in `src/journeys/search.ts`, `diamond.ts` and `gemstone.ts`, one block per case ID.
