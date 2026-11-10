/**
 * Deeplink test: open a link's URL directly in a brand-new browser session (as if a shopper opened
 * a shared link or a bookmark) and check that the right page opens with the right content.
 *
 * While a listing page is open, its product cards are discovered and click-tested on the spot
 * (depth crawling without a separate crawl pass).
 */
import type { Browser, BrowserContext } from 'playwright';
import type { Config } from './config.js';
import { botChallenge, dismissPopups, gotoSettled, newContext, record, reloadSettled, scrollThrough } from './browser.js';
import { checkImages } from './images.js';
import { labelFilterCheck, listingChecks, modalChecks, pageStatus, placeholderCopy, readListing, waitForContent, type ReadyState } from './content.js';
import { classifyProduct, productChecks } from './products.js';
import { popupTest } from './popup.js';
import { measurePerf } from './perf.js';
import { readAnchors } from './discover.js';
import { clickTest, CLICK_EXEMPT } from './clicks.js';
import type { Inventory } from './inventory.js';
import { classify, cleanLabel, diffParams, linkKey, LISTING_TYPES, malformedReason, samePath, shortUrl, toAbsolute } from './urls.js';
import type { Check, ClickOutcome, DiscoveredLink, ListingInfo, Section, Validation } from './types.js';

const PAGE_NAME: Partial<Record<string, string>> = {
  collection: 'Collection', search: 'Search results', 'diamond-search': 'Diamond search', 'gemstone-search': 'Gemstone search',
  'rb-list': 'Ring Builder list', product: 'Product page', 'rb-details': 'Ring Builder item',
};

const LOGIN_RE = /customer_authentication|\/account\/login|accounts\.shopify\.com|shopify\.com\/authentication/;

const refreshUsed = new Map<string, number>();
const cardsPerPath = new Map<string, number>();
/** Reload tests are sampled per app page (path), since reload behaviour belongs to the page template. */
function takeRefreshSlot(url: string, cfg: Config): boolean {
  if (!cfg.refreshPerPage) return true;
  const p = new URL(url).pathname;
  const n = refreshUsed.get(p) ?? 0;
  if (n >= cfg.refreshPerPage) return false;
  refreshUsed.set(p, n + 1);
  return true;
}
export function seedRefreshSlots(urls: string[]) { for (const u of urls) { try { const p = new URL(u).pathname; refreshUsed.set(p, (refreshUsed.get(p) ?? 0) + 1); } catch { /* ignore */ } } }

export interface Harvest {
  inv: Inventory;
  /** Called for each place found on a page: `link` is set when the URL is new (to be deeplink-tested). */
  found: (link: DiscoveredLink | null, click?: ClickOutcome, place?: import('./types.js').Placement, target?: DiscoveredLink) => void;
  /** Route to a link as a shopper clicks it, e.g. ["Mega menu", "FINE JEWELRY", "WEDDING BANDS", "Diamond Bands"]. */
  routeOf?: (link: DiscoveredLink) => string[];
}

function softFailure(expected: string, actual: string, expectedType: string, cfg: Config): string | null {
  const actualType = classify(actual, actual, cfg);
  if (expectedType !== 'home' && actualType === 'home') return `Redirected to the homepage instead of ${shortUrl(expected, cfg)}`;
  if (expectedType === 'rb-details' && actualType === 'rb-start') return 'Stock number not found: redirected to ring builder start page';
  if (expectedType !== 'login' && LOGIN_RE.test(actual)) return 'Unexpected login redirect';
  return null;
}

export async function validateLink(browser: Browser, link: DiscoveredLink, cfg: Config, runId: string, harvest: Harvest | null, ctxRef: { ctx?: BrowserContext }): Promise<Validation> {
  const t0 = Date.now();
  const checks: Check[] = [];
  const v: Validation = { status: 'PENDING', checks, images: [], testedAt: new Date().toISOString(), durationMs: 0, attempts: 1, runId };
  const finish = () => { v.status = pageStatus(checks); v.durationMs = Date.now() - t0; return v; };
  let tPrev = t0;
  const tick = (step: string) => { if (process.env.QA_DEBUG) { const n = Date.now(); console.log(`    ${link.id} ${step} +${((n - tPrev) / 1000).toFixed(1)}s`); tPrev = n; } };

  // ---- links that are not page navigations
  if (link.destType === 'mailto' || link.destType === 'tel') {
    const ok = link.destType === 'mailto' ? /^mailto:[^@\s]+@[^@\s]+\.[a-z]{2,}/i.test(link.rawHref) : /^tel:\+?[\d\s().-]{6,}$/.test(link.rawHref);
    checks.push({ name: 'Valid address', status: ok ? 'PASS' : 'FAIL', mandatory: true, detail: link.rawHref });
    return finish();
  }
  if (link.destType === 'anchor') {
    // in-page links: must open a working popup (e.g. CUSTOM DESIGN → "DESIGN YOUR DREAM RING") or jump to a section
    checks.push(...await popupTest(browser, link, cfg, v, ctxRef));
    return finish();
  }
  if (link.destType === 'external') {
    if (!cfg.checkExternal) {
      checks.push({ name: 'External link', status: 'SKIPPED', mandatory: true, detail: 'Link to another website; external checks are switched off (checkExternal)' });
      return finish();
    }
    // open the other site in a real browser: social sites answer plain requests differently from browsers
    const ctx = await newContext(browser, { ...cfg, blockThirdParty: null });
    ctxRef.ctx = ctx;
    try {
      const page = await ctx.newPage();
      const resp = await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(e => { throw e; });
      await page.waitForTimeout(1500);
      const s = resp?.status() ?? 0;
      v.directUrl = page.url();
      v.directHttpStatus = s;
      v.pageTitle = await page.title().catch(() => '');
      const text = ((await page.evaluate(() => document.body?.innerText || '').catch(() => '')) as string).slice(0, 3000);
      const gone = /page (isn't|is not) available|this page isn't available|page not found|content isn't available|this account doesn't exist|channel does not exist|sorry, this page/i.test(text + ' ' + v.pageTitle);
      const host = new URL(v.directUrl).host;
      const login = /login|signin|accounts\//i.test(new URL(v.directUrl).pathname);
      // Facebook, Instagram & co. hide pages from visitors who are not logged in, and show automated visitors
      // (especially from cloud servers such as GitHub's) "This content isn't available". Only a real 404 counts as broken there.
      const social = /(^|\.)(facebook|instagram|linkedin|twitter|x|tiktok|pinterest|threads)\.(com|net)$/.test(host);
      if (social && s < 400 && gone) checks.push({ name: 'External link reachable', status: 'PASS', mandatory: true, detail: `Opens ${host} · HTTP ${s}. ${host} hides the page from visitors who are not logged in, so its content could not be read; please confirm by hand if needed` });
      else if (s === 404 || s === 410 || s >= 500 || gone) checks.push({ name: 'External link reachable', status: 'FAIL', mandatory: true, detail: `${host} says the page does not exist${s ? ` (HTTP ${s})` : ''}` });
      else if (s === 403 || s === 429 || s === 999) checks.push({ name: 'External link reachable', status: 'BLOCKED', mandatory: true, detail: `${host} refused automated visitors (HTTP ${s}); please check it by hand` });
      else checks.push({ name: 'External link reachable', status: 'PASS', mandatory: true, detail: `Opens ${host}${login ? ' (the site asks visitors to log in first)' : ''} · HTTP ${s}` });
    } catch (e) {
      checks.push({ name: 'External link reachable', status: 'BLOCKED', mandatory: true, detail: `Could not reach the site: ${(e as Error).message.split('\n')[0]}` });
    } finally { await ctx.close().catch(() => {}); }
    return finish();
  }

  const malformed = link.destType === 'malformed' ? (malformedReason(link.rawHref, link.href) ?? 'Malformed href') : null;
  if (malformed) checks.push({ name: 'Valid href', status: 'FAIL', mandatory: true, detail: malformed });

  const ctx = await newContext(browser, cfg, true);
  ctxRef.ctx = ctx;
  const page = await ctx.newPage();
  const rec = record(page);
  // what the store's data services answered (Ring Builder / diamond & gemstone search): explains empty lists
  const appData: { url: string; total?: number }[] = [];
  page.on('response', async r => {
    if (!/ringcreator\.io\/.*\.php|api\.vdbapp\.com|\/apps\/vdb-app\/.*(search|gemstone).*json/i.test(r.url())) return;
    try {
      const j = await r.json();
      const total = typeof j?.total_count === 'number' ? j.total_count : typeof j?.response?.body?.total_diamonds_found === 'number' ? j.response.body.total_diamonds_found : undefined;
      if (total !== undefined) appData.push({ url: r.url(), total });
    } catch { /* not JSON */ }
  });
  try {
    v.product = await classifyProduct(ctx, link, cfg);
    tick('product-json');

    // ---- 1. open directly
    const nav = await gotoSettled(page, link.href, cfg);
    v.redirectChain = rec.documents.map(d => `${d.status} ${shortUrl(d.url, cfg)}`);
    const docs = rec.documents.filter(d => d.status !== 429 && d.status !== 503);
    v.directHttpStatus = docs[0]?.status ?? nav.status;
    v.directUrl = page.url();
    v.pageTitle = await page.title().catch(() => '');
    const firstErr = docs.find(d => d.status >= 400 || d.status === -1);
    const stillLimited = nav.status === 429 || nav.status === 503;
    if (stillLimited) {
      checks.push({ name: 'Direct open', status: 'BLOCKED', mandatory: true, detail: `Store kept answering HTTP ${nav.status} (too many requests) after ${nav.rateLimitedRetries} retries` });
      return finish();
    }
    if (nav.error) {
      const loop = /ERR_TOO_MANY_REDIRECTS/.test(nav.error);
      checks.push({ name: 'Direct open', status: loop ? 'FAIL' : /Timeout/i.test(nav.error) ? 'BLOCKED' : 'FAIL', mandatory: true, detail: loop ? 'Redirect loop' : nav.error });
      if (!loop) return finish();
    } else if (firstErr && firstErr.status >= 400) {
      checks.push({ name: 'Direct open', status: 'FAIL', mandatory: true, detail: `HTTP ${firstErr.status} for ${shortUrl(firstErr.url, cfg)}${v.directUrl !== firstErr.url ? `, then redirected to ${shortUrl(v.directUrl, cfg)}` : ''}` });
    } else {
      checks.push({ name: 'Direct open', status: 'PASS', mandatory: true, detail: `HTTP ${v.directHttpStatus} → ${shortUrl(v.directUrl, cfg)}${docs.length > 1 ? ` (${docs.length - 1} redirect(s))` : ''}${nav.rateLimitedRetries ? ` · retried ${nav.rateLimitedRetries}× after the store rate-limited the test` : ''}` });
    }
    if (docs.length > 8) checks.push({ name: 'Redirects', status: 'FAIL', mandatory: true, detail: `${docs.length} page loads: possible redirect loop` });

    const soft = softFailure(link.href, v.directUrl, link.destType, cfg);
    const isLoginLink = /log ?in|sign ?in|account/i.test(link.label) || link.destType === 'login';
    if (isLoginLink && (link.destType === 'login' || /log ?in|sign ?in/i.test(link.label)) && LOGIN_RE.test(v.directUrl)) {
      checks.push({ name: 'Correct destination', status: 'PASS', mandatory: true, detail: 'Opens the customer login page' });
    } else if (soft === 'Unexpected login redirect' && isLoginLink) {
      checks.push({ name: 'Correct destination', status: 'BLOCKED', mandatory: true, detail: 'Login-protected page (no test account)' });
    } else if (soft) {
      checks.push({ name: 'Correct destination', status: 'FAIL', mandatory: true, detail: soft });
    } else if (!malformed) {
      const actualType = classify(v.directUrl, v.directUrl, cfg);
      const sameKind = actualType === link.destType || samePath(link.href, v.directUrl);
      checks.push({ name: 'Correct destination', status: sameKind ? 'PASS' : 'FAIL', mandatory: true, detail: sameKind ? `${actualType} page` : `Expected a ${link.destType} page, got ${actualType} (${shortUrl(v.directUrl, cfg)})` });
    }
    if (/404|not found/i.test(v.pageTitle || '')) checks.push({ name: 'Page title', status: 'FAIL', mandatory: true, detail: `Title "${v.pageTitle}"` });
    if (!malformed) {
      const d = diffParams(link.href, v.directUrl, cfg);
      const bad = [...d.missing.map(x => `lost ${x}`), ...d.changed.map(x => `changed ${x}`)];
      checks.push({ name: 'Parameters preserved', status: bad.length ? 'FAIL' : 'PASS', mandatory: true, detail: bad.length ? bad.join('; ') : `All filters kept${d.injected.length ? ` (app added defaults: ${d.injected.join(', ')})` : ''}` });
    }

    tick('opened');
    const challenge = await botChallenge(page);
    if (challenge) {
      checks.push({ name: 'Bot protection', status: 'BLOCKED', mandatory: true, detail: `The store's bot protection showed "${challenge}" to the test browser instead of the page (caused by automated traffic; shoppers normally do not see it)` });
      return finish();
    }
    // ---- 2. content by page type
    const actualType = classify(v.directUrl, v.directUrl, cfg);
    const contentType = malformed ? actualType : link.destType;
    let state: ReadyState = 'ready';
    let listing: ListingInfo | undefined;
    const isListing = LISTING_TYPES.includes(contentType) && actualType === contentType;
    if (actualType === contentType || malformed) {
      state = await waitForContent(page, contentType, cfg);
      if (state === 'timeout' && isListing && /^\/apps\//.test(new URL(v.directUrl).pathname)) {
        // app result lists stay empty when their data API is rate limited: wait for the gate, load once more
        await gotoSettled(page, link.href, cfg);
        state = await waitForContent(page, contentType, cfg);
        if (state !== 'timeout') checks.push({ name: 'Content on first load', status: 'PASS', mandatory: false, detail: 'Results did not appear on the first load (store busy); appeared on a second load' });
      }
      await dismissPopups(page);
      v.perf = await measurePerf(page, link.label, contentType, cfg);
      if (isListing) {
        const lc = await listingChecks(page, contentType, state, cfg, !cfg.allowEmpty.some(r => r.test(link.href)));
        checks.push(...lc.checks);
        listing = lc.listing;
        v.listing = listing;
      } else if (contentType === 'rb-details' || contentType === 'product') {
        if (state === 'timeout') checks.push({ name: 'Content loaded', status: 'FAIL', mandatory: true, detail: `Detail content did not appear within ${cfg.contentTimeoutMs / 1000}s` });
        const pc = await productChecks(page, link, v.product);
        checks.push(...pc.checks);
        v.stockNumber = pc.stock;
        if (v.product && pc.title && !v.product.title) v.product.title = pc.title;
      } else {
        checks.push({ name: 'Content loaded', status: state === 'timeout' ? 'FAIL' : 'PASS', mandatory: true, detail: state === 'timeout' ? 'Page body stayed empty' : 'Page has content' });
      }
    } else {
      v.perf = await measurePerf(page, link.label, actualType, cfg);
    }
    if (v.perf) {
      const p = v.perf;
      const secs = p.readyMs ? (p.readyMs / 1000).toFixed(1) + ' s' : 'unknown';
      // measured while other tests run in parallel, so times are inflated: informational only.
      // Pages that look slow are re-measured alone at the end of the run (run.ts), which makes the check count.
      checks.push({ name: 'Page speed', status: p.rating === 'slow' ? 'FAIL' : 'PASS', mandatory: false, severity: 'performance', detail: `Ready in ${secs}${p.loadMs ? `, fully loaded in ${(p.loadMs / 1000).toFixed(1)} s` : ''} (measured during the parallel test run${p.rating === 'slow' ? '; will be re-measured alone' : ''})` });
    }
    tick('content');
    const lf = labelFilterCheck(link.label, link.href, link.destType);
    if (lf && ['megamenu', 'header', 'footer', 'sliders'].includes(link.section)) checks.push({ ...lf, severity: 'minor' });

    const ph = await placeholderCopy(page);
    // template text is accepted on this demo store: recorded for information, never a failure
    if (ph.length) { v.placeholder = ph; checks.push({ name: 'Placeholder text', status: 'PASS', mandatory: false, detail: `Template text present (accepted): "${ph[0].slice(0, 80)}"` }); }

    tick('placeholder');
    // ---- 3. images (in the main content; header/footer images are covered on the homepage)
    await scrollThrough(page);
    await dismissPopups(page); // the contact popup opens on scroll and would cover result cards
    const img = await checkImages(page, rec, cfg, 'main');
    v.images = img.images;
    checks.push(img.check);

    tick('images');
    // ---- 4. diamond / gemstone result detail modals
    if (isListing && (contentType === 'diamond-search' || contentType === 'gemstone-search') && listing?.displayed && cfg.modalsPerSearch > 0) {
      const mc = await modalChecks(page, contentType, cfg.modalsPerSearch);
      checks.push(...mc.checks.map(c => ({ ...c, severity: /did not open|not clickable/i.test(c.detail ?? '') ? 'critical' as const : 'minor' as const })));
      v.stockNumber = mc.stocks.join(', ') || undefined;
    }

    tick('modals');
    // ---- 5. refresh (app-rendered result lists: that is where reloads have broken before)
    if (isListing && /^\/apps\//.test(new URL(v.directUrl).pathname) && takeRefreshSlot(v.directUrl, cfg)) {
      const preUrl = page.url();
      // the "N results" total may have appeared after the first read: read again so both sides compare the same number
      if (listing && listing.resultCount === undefined && listing.displayed) {
        const again = await readListing(page, contentType);
        if (again.resultCount !== undefined) { listing.resultCount = again.resultCount; const rc = checks.find(c => c.name === 'Results rendered'); if (rc) rc.detail += ` of ${again.resultCount}`; }
      }
      const useTotal = listing?.resultCount !== undefined;
      const preCount = useTotal ? listing!.resultCount : listing?.displayed;
      await reloadSettled(page, cfg);
      const postUrl = page.url();
      let ok = samePath(preUrl, postUrl);
      let detail = ok ? 'Same page after reload' : `Reload went to ${shortUrl(postUrl, cfg)}`;
      if (ok) {
        const pd = diffParams(preUrl, postUrl, cfg);
        if (pd.missing.length || pd.changed.length) { ok = false; detail = `Filters changed on reload: ${[...pd.missing, ...pd.changed].join('; ')}`; }
      }
      let severity: 'critical' | 'minor' = 'critical';
      let challenged = false;
      if (ok && preCount !== undefined) {
        const countAfter = async () => {
          const st = await waitForContent(page, contentType, { contentTimeoutMs: Math.min(cfg.contentTimeoutMs, 20_000) });
          let after = st === 'timeout' ? undefined : await readListing(page, contentType);
          for (let i = 0; i < 10 && after && useTotal && after.resultCount === undefined; i++) { await page.waitForTimeout(400); after = await readListing(page, contentType); }
          return after ? (useTotal ? after.resultCount : after.displayed) : undefined;
        };
        const same = (n: number | undefined) => useTotal ? n === preCount : !!n === !!preCount;
        const postCount = await countAfter();
        const ch = !same(postCount) ? await botChallenge(page) : null;
        if (ch) {
          challenged = true;
          detail = `Not verified: after the reload the store's bot protection showed "${ch}" to the test browser (caused by automated traffic)`;
        } else if (!same(postCount)) {
          // reload once more: tells a page that always breaks on reload from one that sometimes does
          await reloadSettled(page, cfg);
          const second = await countAfter();
          ok = false;
          if (same(second)) { severity = 'minor'; detail = `Intermittent: the first reload showed ${postCount ?? 'nothing'} instead of ${preCount} results; a second reload was fine`; }
          else detail = `Result count changed on reload: ${preCount} → ${postCount ?? 'nothing rendered'} (twice)`;
        } else detail += ` (${postCount} ${useTotal ? 'results' : 'cards shown'})`;
      }
      if (challenged) checks.push({ name: 'Refresh', status: 'BLOCKED', mandatory: false, detail });
      else checks.push({ name: 'Refresh', status: ok ? 'PASS' : 'FAIL', mandatory: true, detail, severity });
    }

    tick('refresh');
    const empty = checks.find(c => c.name === 'Results rendered' && c.status === 'FAIL');
    if (empty && appData.length && appData.every(d => d.total === 0)) {
      empty.detail = `${empty.detail ?? ''}. The store's data service itself answered "0 results" for this search (${new URL(appData[0].url).host}), so the page correctly shows none: the problem is the search data/filters behind this link, not the page`;
    }
    // the store refused the page's own app files (HTTP 429): an empty or broken page is then the test's
    // traffic, not a site bug. Report "couldn't verify" (re-tested later) instead of a failure.
    if (rec.app429.length) {
      for (const c of checks) {
        if (c.mandatory && c.status === 'FAIL' && /^(Results rendered|Content loaded|Detail modal|Refresh|Correct stock number shown|Product loaded|Product has price|Results match filter|Result count)/.test(c.name)) {
          c.status = 'BLOCKED';
          c.detail = `${c.detail ?? ''}. Not counted as a failure: the store refused ${rec.app429.length} of the page's own app files with "429 Too Many Requests" while it loaded (caused by the test's traffic)`;
        }
      }
    }
    if (pageStatus(checks) === 'FAIL' || pageStatus(checks) === 'WARN') {
      const rel = `screenshots/${link.id}.jpg`;
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      v.screenshot = await page.screenshot({ path: `${cfg.outDir}/${rel}`, type: 'jpeg', quality: 55 }).then(() => rel).catch(() => undefined);
    }

    tick('screenshot');
    // ---- 6. discover and click-test deeper links found on this page
    if (harvest && !malformed) await harvestLinks(ctx, page, link, contentType, isListing, cfg, harvest);
  } catch (e) {
    checks.push({ name: 'Validation', status: 'BLOCKED', mandatory: true, detail: `Test aborted: ${(e as Error).message.split('\n')[0]}` });
  } finally {
    rec.stop();
    await ctx.close().catch(() => {});
  }
  return finish();
}

/**
 * Links on a page opened from the homepage. Every visible link in the page's main content is recorded with its
 * position (route from the homepage + section on this page) and click-tested right here; new URLs are queued for
 * their own deeplink test. Product cards are sampled (cardsPerListing) and one "next page" link is taken.
 * On product / Ring Builder detail pages one level further, only the first few links are taken (linksPerPage).
 */
async function harvestLinks(ctx: BrowserContext, page: import('playwright').Page, src: DiscoveredLink, type: DiscoveredLink['destType'], _isListing: boolean, cfg: Config, h: Harvest) {
  const depth = src.depth + 1;
  if (depth > cfg.maxDepth) return;
  const fromLanding = src.depth === 0 && type !== 'home';
  const fromDetail = src.depth === 1 && (type === 'product' || type === 'rb-details');
  if (!fromLanding && !fromDetail) return;
  // the page may have been reloaded for the refresh check: wait for its content again
  await waitForContent(page, type, cfg);
  await scrollThrough(page);
  await dismissPopups(page);
  const anchors = await readAnchors(page, 'main');
  const srcUrl = page.url();
  const srcPath = new URL(srcUrl).pathname;
  const srcName = (src.label && src.label !== '(no text)' ? src.label : (await page.title().catch(() => '')).split(/\s[–|-]\s/)[0]).slice(0, 50);
  const route = h.routeOf?.(src) ?? [`${PAGE_NAME[type] ?? 'Page'}: "${srcName}"`];
  const cardHrefs = new Set<string>();
  let pagers = 0, others = 0;
  const newPlaces: { link: DiscoveredLink; place: import('./types.js').Placement; isNew: boolean }[] = [];
  for (const a of anchors) {
    if (!a.visible && !a.inSlide) continue;
    const abs = toAbsolute(a.rawHref, srcUrl);
    const t = classify(a.rawHref, abs, cfg);
    const isCard = t === 'product' || t === 'rb-details';
    const isPager = /[?&]page=\d+/.test(a.rawHref);
    // filter chips / sort options ("Clear", "Remove …", ?filter.…, ?sort_by=…) are not destinations
    if (/^(clear|clear all|remove|reset)\b/i.test(a.label)) continue;
    // script-only controls (javascript:…) are app buttons (shape/colour filters, steps), not links
    if (/^\s*javascript:/i.test(a.rawHref)) continue;
    // "share this item" buttons (WhatsApp, Facebook, X, Pinterest, email): one per result, not site links
    if (/api\.whatsapp\.com\/send|wa\.me\/\?|facebook\.com\/sharer|twitter\.com\/intent|x\.com\/intent|pinterest\.[a-z.]+\/pin\/create|^mailto:\?/i.test(a.rawHref)) continue;
    // in-page links (#…) are kept on content pages (tabs such as DEMO CENTER's "01 Ring Creator", popups);
    // on search / Ring Builder / collection pages they are the app's own filter and sort controls
    if (t === 'anchor' && type !== 'page' && type !== 'policy') continue;
    if (abs && !isPager && new URL(abs).pathname === srcPath && /[?&](filter\.|sort_by=)/.test(a.rawHref)) continue;
    let section: Section;
    if (fromLanding) {
      section = isCard || isPager ? (type === 'search' ? 'search' : 'plp') : 'category';
      if (isCard && !cardHrefs.has(a.rawHref)) {
        if (cardHrefs.size >= cfg.cardsPerListing) continue;
        // listings of the same app page with different filters show largely the same items
        const pathKey = 'cards|' + srcPath;
        if ((cardsPerPath.get(pathKey) ?? 0) >= cfg.cardsPerListing * 3) continue;
        cardHrefs.add(a.rawHref);
        cardsPerPath.set(pathKey, (cardsPerPath.get(pathKey) ?? 0) + 1);
      }
      else if (isPager) { if (pagers >= 1) continue; pagers++; }
      else if (others >= cfg.linksPerLandingPage) continue;
    } else {
      section = 'pdp';
      if (t === 'anchor' || others >= cfg.linksPerPage) continue;
    }
    const label = isPager && /^\d+$/.test(a.label.trim()) ? `Page ${a.label.trim()}` : a.label;
    // position: the route a shopper follows from the homepage, then where the link sits on this page
    const onPage = a.position && a.position.length > 1 ? a.position.slice(1) : [isCard ? 'product card' : isPager ? 'pagination' : 'link on the page'];
    const position = [...route, ...onPage];
    const added = h.inv.add({ ...a, label, section, position }, srcUrl, depth, { kind: 'none' });
    const place = h.inv.lastPlacement;
    const link = added ?? h.inv.get(linkKey(t, abs, srcUrl, a.rawHref, cleanLabel(label), cfg));
    if (!added && !place) continue;
    if (!isCard && !isPager && place) others++;
    if (link && place) newPlaces.push({ link, place, isNew: !!added });
    else if (added) newPlaces.push({ link: added, place: undefined as never, isNew: true });
  }
  for (const { link, place, isNew } of newPlaces) {
    let click: ClickOutcome | undefined;
    if (!CLICK_EXEMPT.has(link.destType)) {
      const target = place ? { ...link, id: place.pid, label: place.label, section: place.section, reveal: place.reveal, rawHref: place.rawHref, sourceUrl: srcUrl, secId: place.secId, nth: place.nth } : link;
      try { click = await clickTest(ctx, page, target, cfg); }
      catch (e) { click = { checks: [{ name: 'Click from source', status: 'BLOCKED', mandatory: true, detail: (e as Error).message.split('\n')[0] }], at: new Date().toISOString() }; }
    }
    h.found(isNew ? link : null, click, place, link);
  }
}
