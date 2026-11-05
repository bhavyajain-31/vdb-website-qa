import type { Page } from 'playwright';
import type { Config } from './config.js';
import { dismissPopups } from './browser.js';
import type { Check, DestType, ListingInfo, Status } from './types.js';
import { severityOf } from './severity.js';

/** Card selectors per listing type: container, name, price, image. */
const CARDS: Partial<Record<DestType, { card: string; name: string; price: string; img: string }>> = {
  'diamond-search': { card: '.vdb-search-result-block', name: '@data-product-name', price: '.vdb-product-prize', img: 'img' },
  'gemstone-search': { card: '.vdb-gem-product-image-block', name: '@data-product-name', price: '.vdb-gem-product-title-and-price h3', img: 'img' },
  'rb-list': { card: '.vdb-rb-list-product-item', name: '.vdb-rb-product-name', price: '.vdb-rb-price h3, .vdb-rb-price', img: 'img' },
  // Dawn product cards, and the VDB configurator's own cards on "Configure …" collections
  collection: { card: '.card-wrapper, .vdb-spjc-product-card', name: '.card__heading, .vdb-spjc-product-card__title', price: '.price-item, .price, .vdb-spjc-product-card__price', img: 'img' },
  search: { card: '.card-wrapper', name: '.card__heading', price: '.price-item, .price', img: 'img' },
};

export type ReadyState = 'ready' | 'empty' | 'form' | 'timeout';

/** Wait until the page type's own content has rendered (not just HTTP 200).
 * Sets window.__qaReadyAt (ms from navigation start) the first moment content is seen, for the performance report. */
export async function waitForContent(page: Page, type: DestType, cfg: Pick<Config, 'contentTimeoutMs'>): Promise<ReadyState> {
  const spec = CARDS[type];
  const mark = () => page.evaluate(() => { const w = window as any; w.__qaReadyAt ??= performance.now(); }).catch(() => {});
  try {
    if (spec) {
      const h = await page.waitForFunction(({ card }) => {
        const w = window as any;
        const t = document.body?.innerText || '';
        // placeholder (skeleton) cards render before the data: only count cards that have text
        const cards = [...document.querySelectorAll(card)].filter(c => (c.textContent || '').trim().length > 2).length;
        const count = w.__qaCount() as number | undefined;
        const empty = /No results found|No products found|Use fewer filters/i.test(t) || count === 0;
        if (cards > 0) {
          w.__qaReadyAt ??= performance.now();
          w.__qaEmptySince = undefined;
          // the "N results" total can render after the cards: give it a moment
          w.__qaCardsSince ??= Date.now();
          // "0 Products" next to visible cards is the counter not updated yet: wait a little longer for it
          return (count !== undefined && count > 0) || Date.now() - w.__qaCardsSince > 3000 ? 'ready' : false;
        }
        // a search link without filters opens the app's search form, not a result list
        const form = /(Natural Diamonds|Lab-Grown Diamonds|Gemstone) Search/i.test(t) && count === undefined && !/\bResults\b/.test(t.replace(/Show All Results|Search Results/g, ''));
        if (form && /search-filters|gemstone/.test(location.pathname) && !/[?&](shapes|fancy|gem_type)=/.test(location.search)) {
          w.__qaFormSince ??= Date.now();
          w.__qaReadyAt ??= performance.now();
          return Date.now() - w.__qaFormSince > 4000 ? 'form' : false;
        }
        // the apps print "0 Results" before their AJAX call returns: only trust an empty state that persists
        if (empty) {
          w.__qaEmptySince ??= Date.now();
          if (Date.now() - w.__qaEmptySince > 5000) { w.__qaReadyAt ??= performance.now() - 5000; return 'empty'; }
          return false;
        }
        w.__qaEmptySince = undefined;
        return false;
      }, { card: spec.card }, { timeout: cfg.contentTimeoutMs, polling: 250 });
      const state = (await h.jsonValue()) as ReadyState;
      await page.waitForTimeout(state === 'ready' ? 300 : 150); // let the remaining cards paint
      return state;
    }
    if (type === 'rb-details') {
      await page.waitForFunction(() => /Stock\s*#/i.test(document.body?.innerText || ''), undefined, { timeout: cfg.contentTimeoutMs, polling: 250 });
      await mark();
      return 'ready';
    }
    if (type === 'product') {
      await page.waitForSelector('h1, .product__title', { timeout: cfg.contentTimeoutMs });
      await mark();
      return 'ready';
    }
    await page.waitForFunction(() => (document.querySelector('main')?.textContent || document.body.textContent || '').trim().length > 40, undefined, { timeout: cfg.contentTimeoutMs, polling: 250 });
    await mark();
    return 'ready';
  } catch {
    return 'timeout';
  }
}

export async function readListing(page: Page, type: DestType): Promise<ListingInfo> {
  const spec = CARDS[type]!;
  return page.evaluate((s) => {
    const vis = (window as any).__qaVis as (e: Element) => boolean;
    const text = document.body.innerText;
    const count = (window as any).__qaCount() as number | undefined;
    const cards = [...document.querySelectorAll(s.card)].filter(c => vis(c) && (c.textContent || '').trim().length > 2);
    const names: string[] = [], incomplete: string[] = [];
    for (const c of cards) {
      const name = (s.name.startsWith('@') ? (c as HTMLElement).getAttribute(s.name.slice(1)) : c.querySelector(s.name)?.textContent)?.replace(/\s+/g, ' ').trim() || '';
      const price = c.querySelector(s.price)?.textContent?.trim() || '';
      const img = c.querySelector(s.img) as HTMLImageElement | null;
      names.push(name);
      const miss = [!name && 'name', !price && 'price', !(img && (img.getAttribute('src') || img.getAttribute('srcset'))) && 'image'].filter(Boolean);
      if (miss.length) incomplete.push(`${name || '(card ' + names.length + ')'}: missing ${miss.join(', ')}`);
    }
    const seen = new Map<string, number>();
    // duplicate = same id (diamond/gem cards) or same link; names alone repeat legitimately
    for (const c of cards) {
      const key = (c as HTMLElement).dataset.prids || (c.querySelector('a[href]') as HTMLAnchorElement | null)?.getAttribute('href') || '';
      if (key) seen.set(key, (seen.get(key) || 0) + 1);
    }
    return {
      resultCount: count === 0 && cards.length ? undefined : count,
      displayed: cards.length,
      emptyState: /No results found|No products found/i.test(text) || count === 0,
      mismatches: [] as string[],
      incomplete,
      duplicates: [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`),
      sample: names.slice(0, 40),
    };
  }, spec);
}

export const SHAPES = ['round', 'princess', 'cushion', 'emerald', 'oval', 'heart', 'pear', 'radiant', 'asscher', 'marquise', 'square', 'trilliant', 'triangle', 'crystal', 'other', 'baguette', 'rose cut', 'old miner', 'european'];
const COLORS = ['yellow', 'pink', 'blue', 'green', 'orange', 'brown', 'purple', 'red', 'black', 'gray', 'grey', 'violet', 'white', 'champagne', 'cognac', 'olive'];

function shapeWord(v: string): string {
  const s = v.toLowerCase();
  if (s.startsWith('cush')) return 'cushion';
  if (s.startsWith('sq emerald')) return 'emerald';
  return s;
}

/** Card names must agree with the filters the URL asks for (only for filters names reveal). */
export function filterMismatches(url: string, type: DestType, names: string[]): { rule: string; bad: string[] } | null {
  const u = new URL(url);
  // gemstone names abbreviate the cut ("Em Cut Blue Iolite", "Cush Mod", "Sq Emerald"): expand before matching
  const ABBR: [RegExp, string][] = [[/\bem(\.|erald)? cut\b/g, 'emerald'], [/\bsq emerald\b/g, 'emerald'], [/\bcush(\.|ion)?\b/g, 'cushion'], [/\brd\b/g, 'round'], [/\bov\b/g, 'oval']];
  const lower = names.map(n => ABBR.reduce((t, [re, w]) => t.replace(re, w), n.toLowerCase()));
  const rules: { rule: string; test: (n: string) => boolean }[] = [];
  const shapes = u.searchParams.get('shapes');
  if (shapes && (type === 'diamond-search' || type === 'gemstone-search')) {
    const want = shapes.split(',').map(shapeWord);
    rules.push({ rule: `shape ∈ {${want.join(', ')}}`, test: n => want.some(w => n.startsWith(w) || n.includes(' ' + w)) });
  }
  const fancy = u.searchParams.get('fancy');
  if (fancy && type === 'diamond-search') {
    const want = fancy.toLowerCase().split(',');
    rules.push({ rule: `colour ∈ {${want.join(', ')}}`, test: n => want.some(w => n.includes(w)) });
  }
  const gem = u.searchParams.get('gem_type');
  if (gem && type === 'gemstone-search') {
    const want = gem.toLowerCase().split(',');
    rules.push({ rule: `gem ∈ {${want.join(', ')}}`, test: n => want.some(w => n.includes(w)) });
  }
  if (!rules.length) return null;
  const bad = names.filter((_, i) => !rules.every(r => r.test(lower[i])));
  return { rule: rules.map(r => r.rule).join(' and '), bad };
}

/** "Brown" in a menu should not also restrict shape, etc. */
export function labelFilterCheck(label: string, url: string, type: DestType): Check | null {
  if (type !== 'diamond-search' && type !== 'gemstone-search') return null;
  const words = label.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return null;
  const u = new URL(url);
  const shapes = (u.searchParams.get('shapes') || '').split(',').filter(Boolean).map(shapeWord);
  const fancy = (u.searchParams.get('fancy') || '').toLowerCase();
  const gem = (u.searchParams.get('gem_type') || '').toLowerCase();
  const labelColor = words.find(w => COLORS.includes(w));
  const labelShape = words.find(w => SHAPES.includes(w));
  const issues: string[] = [];
  if (labelColor && !labelShape && shapes.length === 1 && !gem) issues.push(`label names colour "${labelColor}" but link also restricts shape to ${shapes[0]}`);
  if (labelShape && !labelColor && fancy && type === 'diamond-search') issues.push(`label names shape "${labelShape}" but link also restricts colour to ${fancy}`);
  if (labelColor && fancy && !fancy.includes(labelColor)) issues.push(`label "${label}" but colour filter is ${fancy}`);
  if (labelShape && shapes.length && !shapes.includes(labelShape)) issues.push(`label "${label}" but shape filter is ${shapes.join(',')}`);
  if (!issues.length) return { name: 'Label matches filters', status: 'PASS', mandatory: true };
  return { name: 'Label matches filters', status: 'FAIL', mandatory: true, detail: issues.join('; ') };
}

/** Evaluate a listing page: loaded, non-empty, count consistent, results match filters, cards complete. */
export async function listingChecks(page: Page, type: DestType, state: ReadyState, cfg: Config, expectNonEmpty: boolean): Promise<{ checks: Check[]; listing?: ListingInfo }> {
  const checks: Check[] = [];
  if (state === 'timeout') {
    checks.push({ name: 'Results rendered', status: 'FAIL', mandatory: true, detail: `No result cards and no empty-state message after ${cfg.contentTimeoutMs / 1000}s` });
    return { checks };
  }
  if (state === 'form') {
    checks.push({ name: 'Results rendered', status: 'PASS', mandatory: true, detail: 'Link has no filters: the search form is shown, ready to search' });
    return { checks };
  }
  const listing = await readListing(page, type);
  if (state === 'empty' || listing.displayed === 0) {
    const allowed = cfg.allowEmpty.some(r => r.test(page.url()));
    if (listing.emptyState || listing.resultCount === 0) {
      checks.push({
        name: 'Results rendered',
        status: allowed || !expectNonEmpty ? 'PASS' : 'FAIL',
        mandatory: true,
        detail: allowed || !expectNonEmpty ? 'Valid empty state shown' : `Unexpected empty result: page shows "${listing.resultCount ?? 0} results / No results found" for a linked category`,
      });
    } else {
      checks.push({ name: 'Results rendered', status: 'FAIL', mandatory: true, detail: 'No products rendered and no empty-state message (render failure)' });
    }
    return { checks, listing };
  }
  checks.push({ name: 'Results rendered', status: 'PASS', mandatory: true, detail: `${listing.displayed} cards shown${listing.resultCount !== undefined ? ` of ${listing.resultCount}` : ''}` });

  if (listing.resultCount !== undefined) {
    const smallEnough = listing.resultCount <= 12;
    const ok = listing.displayed <= listing.resultCount && (!smallEnough || listing.displayed === listing.resultCount);
    checks.push({
      name: 'Result count matches cards',
      status: ok ? 'PASS' : 'FAIL',
      mandatory: true,
      detail: ok ? `count ${listing.resultCount}, displayed ${listing.displayed}` : `page says ${listing.resultCount} but shows ${listing.displayed} cards`,
    });
  }
  const fm = filterMismatches(page.url(), type, listing.sample);
  if (fm) {
    listing.mismatches = fm.bad;
    checks.push({
      name: 'Results match filter',
      status: fm.bad.length ? 'FAIL' : 'PASS',
      mandatory: true,
      detail: fm.bad.length ? `${fm.bad.length} of ${listing.sample.length} cards do not match ${fm.rule}: ${fm.bad.slice(0, 4).join(' | ')}` : `all ${listing.sample.length} sampled cards match ${fm.rule}`,
    });
  }
  checks.push({
    name: 'Product cards complete',
    status: listing.incomplete.length ? 'FAIL' : 'PASS',
    mandatory: true,
    detail: listing.incomplete.length ? listing.incomplete.slice(0, 5).join('; ') : 'every card has name, price, image',
  });
  if (listing.duplicates.length)
    checks.push({ name: 'No duplicate results', status: 'FAIL', mandatory: true, detail: listing.duplicates.slice(0, 5).join(', ') });
  return { checks, listing };
}

/**
 * Diamond / gemstone search: detail views are modals on the same URL.
 * Open the first N cards' modals and verify the stock number, name and images.
 */
/**
 * The search apps append their default ranges (carat_min, budget_max, …) to the URL a few seconds
 * after load, often while a modal is open. Only a different path or a changed search filter counts.
 */
function modalUrlChanged(before: string, after: string): boolean {
  const a = new URL(before), b = new URL(after);
  if (a.pathname !== b.pathname) return true;
  const norm = (u: URL, k: string) => (u.searchParams.get(k) ?? '').toLowerCase().replace(/\s+/g, '');
  return ['shapes', 'fancy', 'gem_type', 'diamondSearchType', 'diamond_type', 'color_type'].some(k => norm(a, k) !== norm(b, k));
}

export async function modalChecks(page: Page, type: DestType, n: number): Promise<{ checks: Check[]; stocks: string[] }> {
  const checks: Check[] = [];
  const stocks: string[] = [];
  const cardSel = type === 'diamond-search' ? '.vdb-search-result-block' : '.vdb-gem-product-image-block';
  // grid and list views both exist in the DOM; only the visible one can be clicked
  const cards = page.locator(cardSel).filter({ visible: true });
  const count = await cards.count();
  for (let i = 0; i < Math.min(n, count); i++) {
    if (i > 0) {
      // the detail view replaces the grid and its Close control is unreliable: start from a clean load
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitForContent(page, type, { contentTimeoutMs: 30_000 });
    }
    const card = cards.nth(i);
    const name = (await card.getAttribute('data-product-name', { timeout: 8000 }).catch(() => null)) || `card ${i + 1}`;
    const urlBefore = page.url();
    try {
      await card.scrollIntoViewIfNeeded();
      await dismissPopups(page);
      await card.click({ timeout: 4000 }).catch(async () => { await dismissPopups(page); await card.click({ timeout: 4000 }); });
    } catch (e) {
      checks.push({ name: `Detail modal: ${name}`, status: 'FAIL', mandatory: true, detail: `Card not clickable: ${(e as Error).message.split('\n')[0]}` });
      continue;
    }
    let res: { open: boolean; stock?: string; title?: string; imgs: number; broken: string[] } | null = null;
    for (let t = 0; t < 20 && !(res?.open && res.stock); t++) {
      await page.waitForTimeout(400);
      res = await page.evaluate(() => {
        const vis = (window as any).__qaVis as (e: Element) => boolean;
        // the modal is the visible block containing "Stock#" or "Report #" details with a Close control
        const cands = [...document.querySelectorAll('div, section')].filter(e => vis(e) && /Close/.test((e as HTMLElement).innerText || '') && /(Stock\s*#|Report\s*#|Gemstone Details|Diamond Details)/i.test((e as HTMLElement).innerText || ''));
        const m = cands.sort((a, b) => (a as HTMLElement).innerText.length - (b as HTMLElement).innerText.length)[0] as HTMLElement | undefined;
        if (!m) return { open: false, imgs: 0, broken: [] };
        const t = m.innerText;
        const stock = (t.match(/Stock\s*#\s*:?\s*([A-Za-z0-9-]+)/i) || t.match(/Report\s*#\s*:?\s*([A-Za-z0-9-]+)/i) || [])[1];
        const imgs = [...m.querySelectorAll('img')].filter(vis).filter(i => i.getBoundingClientRect().width >= 16);
        return {
          open: true, stock, title: t.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 3).join(' '),
          imgs: imgs.length,
          broken: imgs.filter(i => i.complete && i.naturalWidth === 0).map(i => i.currentSrc || i.src || '(no source)'),
        };
      });
    }
    if (!res?.open) {
      checks.push({ name: `Detail modal: ${name}`, status: 'FAIL', mandatory: true, detail: 'Clicking the card did not open a detail view' });
    } else {
      const titleOk = !!res.title && res.title.toLowerCase().includes(name.split(' ')[0].toLowerCase());
      const problems = [
        !res.stock && 'no stock/report number',
        !titleOk && `title "${res.title}" does not match card "${name}"`,
        res.broken.length && `broken image(s): ${res.broken.slice(0, 2).join(', ')}`,
        modalUrlChanged(urlBefore, page.url()) && `URL changed unexpectedly (${new URL(page.url()).search.slice(0, 120)})`,
      ].filter(Boolean);
      if (res.stock) stocks.push(res.stock);
      checks.push({
        name: `Detail modal: ${name}`,
        status: problems.length ? 'FAIL' : 'PASS',
        mandatory: true,
        detail: problems.length ? problems.join('; ') : `Stock ${res.stock}, ${res.imgs} image(s)`,
      });
    }
    // close
    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(() => {
      const vis = (window as any).__qaVis as (e: Element) => boolean;
      const btn = [...document.querySelectorAll('button, a, span, div')].find(e => vis(e) && ((e as HTMLElement).innerText || '').trim() === 'Close') as HTMLElement | undefined;
      btn?.click();
    }).catch(() => {});
    await page.waitForTimeout(600);
  }
  if (!count) checks.push({ name: 'Detail modal', status: 'SKIPPED', mandatory: false, detail: 'No result cards to open' });
  return { checks, stocks };
}

/** Case status from its checks: critical failure → FAIL; only minor/performance → WARN. */
export function pageStatus(checks: Check[]): Status {
  const m = checks.filter(c => c.mandatory);
  if (!m.length) return 'SKIPPED';
  const failing = m.filter(c => c.status === 'FAIL');
  if (failing.some(c => (c.severity ?? severityOf(c.name)) === 'critical')) return 'FAIL';
  if (m.some(c => c.status === 'BLOCKED')) return 'BLOCKED';
  if (m.some(c => c.status === 'PENDING')) return 'PENDING';
  if (failing.length || m.some(c => c.status === 'WARN')) return 'WARN';
  if (m.some(c => c.status === 'SKIPPED')) return 'SKIPPED';
  return 'PASS';
}

const PLACEHOLDER = /(this is a placeholder|lorem ipsum|placeholder text|your text here|add your text|sample text goes here)/i;

/** Template copy left on a live page. Reported once per site, not as a failure on every link. */
export async function placeholderCopy(page: Page): Promise<string[]> {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const vis = (window as any).__qaVis as (e: Element) => boolean;
    const out = new Set<string>();
    const walker = document.createTreeWalker(document.querySelector('main') || document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 8 && re.test(t) && n.parentElement && vis(n.parentElement)) out.add(t.slice(0, 120));
    }
    return [...out];
  }, PLACEHOLDER.source).catch(() => []);
}
