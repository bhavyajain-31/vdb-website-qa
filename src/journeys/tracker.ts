// Daily monitoring tracker: TC-01 … TC-33 (TC-26, TC-29, TC-30 stay manual).
// Shopper flows end at the cart; checkout is never opened and nothing is ordered or submitted.
import type { Browser, Page, Response } from 'playwright';
import type { Config } from '../config.js';
import { gotoSettled, settle } from '../browser.js';
import { Case, Suite, StepError, fmt$, forgetFilters, isVisible, journeyContext, list, money, must, navMs, recordPerf, visible, watchDialogs } from './harness.js';
import { DS, isPage1 } from './diamond.js';
import { GS } from './gemstone.js';
import { afterChange, facetOptions, loadAllImages, openSearch, productData, products, submitSearch, tickOption } from './search.js';
import { TRACKER } from './tracker-catalog.js';

const RB = 'apps/ring-creator/';
const post = (r: Response) => r.request().postData() ?? '';
const nf = (x: number | undefined) => x == null ? '?' : x.toLocaleString('en-US');
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
const sameShape = (a?: string | null, b?: string | null) => { const x = norm(a ?? ''), y = norm(b ?? ''); return !!x && !!y && (x === y || x.startsWith(y.slice(0, 4)) || y.startsWith(x.slice(0, 4))); };

/** Registers the tracker rows so results carry the sheet's wording. */
export function defineTracker(suite: Suite) {
  for (const t of TRACKER) if (!t.manual) suite.define({ id: t.id, area: t.area, title: t.title, steps: t.steps, expected: t.expected, priority: t.priority });
}

// ------------------------------------------------------------------ shared helpers


/**
 * Opens a page like a shopper. The store is sometimes slow or answers "too many requests" (429):
 * then the test waits (15 s, 30 s, 45 s) and tries again instead of giving up, and the wait is recorded.
 */
async function open(page: Page, cfg: Config, url: string, c?: Case, what = 'the page') {
  c?.step(`Open ${what}`);
  const full = url.startsWith('http') ? url : cfg.baseUrl + url;
  let waited = 0, last: { status?: number; error?: string } = {};
  for (let attempt = 1; attempt <= 4; attempt++) {
    const t0 = Date.now();
    const g = await gotoSettled(page, full, { ...cfg, navTimeoutMs: 60_000 });
    const ms = (await navMs(page)) ?? Date.now() - t0; // the browser's own page-load time
    last = g;
    const busy = g.status === 429 || g.status === 503 || /Timeout/i.test(g.error ?? '');
    const ok = !g.error && !(g.status && g.status >= 400);
    if (ok || !busy || attempt === 4) {
      recordPerf(page, { kind: 'Page load', url: full.replace(cfg.baseUrl, '/'), name: what.replace(/^the /, ''), ms, status: g.status, tries: attempt, waitedMs: waited, ok });
      if (attempt > 1 && ok) c?.note(`(${what} was busy and opened on try ${attempt}, after ${Math.round(waited / 1000)} s.)`);
      if (!ok) throw new StepError(`Could not open ${what} (${g.error ?? 'HTTP ' + g.status}${attempt > 1 ? `, still busy after ${attempt} tries over ${Math.round(waited / 1000)} s` : ''})`);
      return g;
    }
    const wait = 15_000 * attempt;
    c?.step(`${what} is busy (${g.status ?? 'timeout'}): wait ${wait / 1000} s and try again`);
    await page.waitForTimeout(wait);
    waited += wait;
  }
  return last;
}

/** Picks a ring size from whichever size dropdown the page has (US sizes or mm sizes), like a shopper. */
async function chooseSize(page: Page, c: Case, want: number): Promise<string> {
  c.step(`Choose ring size ${want}`);
  const picked = await page.evaluate((want) => {
    const sels = [...document.querySelectorAll('select')] as HTMLSelectElement[];
    const sizeSel = sels.find(s => /size/i.test(s.id + ' ' + s.name + ' ' + s.className) && s.offsetWidth > 0)
      ?? sels.find(s => /ring|size|mm/i.test(s.id + ' ' + s.name + ' ' + s.className) && [...s.options].filter(o => /^\d+(\.\d+)?$/.test(o.text.trim())).length > 3);
    if (!sizeSel) return null;
    const opts = [...sizeSel.options].filter(o => /^\d+(\.\d+)?$/.test(o.text.trim()));
    const o = opts.find(x => Number(x.text.trim()) === want) ?? opts[Math.floor(opts.length / 2)];
    if (!o) return null;
    sizeSel.value = o.value;
    sizeSel.dispatchEvent(new Event('input', { bubbles: true }));
    sizeSel.dispatchEvent(new Event('change', { bubbles: true }));
    (window as any).jQuery?.(sizeSel).trigger('change');
    return `${sizeSel.id || sizeSel.name || sizeSel.className}=${o.text.trim()}`;
  }, want);
  if (!picked) throw new StepError('Could not find a ring size dropdown on the setting page');
  await page.waitForTimeout(600);
  return picked.split('=').pop()!;
}

/** The ring size currently selected, read from the same dropdown chooseSize uses (US sizes, or mm sizes such as "6.0" on some settings). */
async function sizeShown(page: Page): Promise<string> {
  return page.evaluate(() => {
    const sels = [...document.querySelectorAll('select')] as HTMLSelectElement[];
    const s = sels.find(x => /size/i.test(x.id + ' ' + x.name + ' ' + x.className) && x.offsetWidth > 0)
      ?? sels.find(x => /ring|size|mm/i.test(x.id + ' ' + x.name + ' ' + x.className) && [...x.options].filter(o => /^\d+(\.\d+)?$/.test(o.text.trim())).length > 3);
    return s && s.selectedIndex > 0 ? s.options[s.selectedIndex].text.trim() : '';
  });
}

async function mainText(page: Page) { return (await page.locator('#MainContent').innerText().catch(() => '')).replace(/\s+/g, ' ').trim(); }

/** Header links, read once from the homepage (label + absolute URL). */
async function headerLinks(page: Page, cfg: Config): Promise<{ label: string; href: string }[]> {
  if (!page.url().startsWith(cfg.baseUrl) || new URL(page.url()).pathname !== '/') await open(page, cfg, cfg.baseUrl);
  return page.$$eval('header a[href]', as => as.map(a => ({ label: (a.textContent ?? '').replace(/\s+/g, ' ').trim(), href: (a as HTMLAnchorElement).href })).filter(x => x.label && x.href));
}

/** Ring Builder list rows the store sent (stones, settings or gemstones). */
async function rbRows(r: Response | null): Promise<any[]> {
  if (!r) return [];
  try { const j = await r.json(); const m = typeof j.main_data === 'string' ? JSON.parse(j.main_data) : j.main_data; const b = m?.response?.body; return b?.diamonds ?? b?.jewelry ?? b?.gemstones ?? []; } catch { return []; }
}
const isRbList = (kind: 'stone' | 'setting') => (r: Response) => new RegExp(`rb-${kind}-list\\.php`).test(r.url()) && !/only_count_fetch/.test(post(r));

/** Opens a Ring Builder list and returns the rows the store sent for it. */
async function rbList(page: Page, cfg: Config, url: string, kind: 'stone' | 'setting', c: Case, what: string) {
  const wait = page.waitForResponse(isRbList(kind), { timeout: 45_000 }).catch(() => null);
  const t0 = Date.now();
  await open(page, cfg, url, c, what);
  const r = await wait;
  const part = kind === 'stone' ? 'rb-stone-details' : 'rb-setting-details';
  await page.waitForFunction(p => [...document.querySelectorAll(`a[href*="${p}"]`)].some(a => (a as HTMLElement).offsetWidth > 0 && (a as HTMLElement).innerText.trim()), part, { timeout: 20_000 }).catch(() => {});
  recordPerf(page, { kind: 'Results shown', url: page.url().replace(cfg.baseUrl, '/'), name: `${what} – ${kind}s on screen`, ms: Date.now() - t0 });
  await page.waitForTimeout(800);
  return { rows: await rbRows(r), req: r ? post(r) : '' };
}

const visibleLinks = (page: Page, part: string) => page.$$eval(`a[href*="${part}"]`, as => as.filter(a => (a as HTMLElement).offsetWidth > 0 && (a as HTMLElement).innerText.trim()).map(a => ({ href: (a as HTMLAnchorElement).href, text: (a as HTMLElement).innerText.split('\n')[0].trim() })));

interface Detail { stock?: string; title?: string; price?: number; shape?: string; shapes: string[]; button?: string }
async function readDetail(page: Page): Promise<Detail> {
  const t = await page.locator('#MainContent').innerText().catch(() => '');
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
  const si = lines.findIndex(l => /^Stock #/.test(l));
  const stock = lines[si]?.replace(/^Stock #\s*/, '') || undefined;
  const title = si >= 0 ? lines[si + 1] : undefined;
  const priceLine = lines.slice(Math.max(0, si)).find(l => /^\$[\d,]+(\.\d\d)?$/.test(l));
  const shapeIdx = lines.findIndex(l => /^Shape$/i.test(l));
  const shapeColon = lines.find(l => /^Shape:/i.test(l));
  const shapes = await page.$$eval('button.vdbrb_list_item_a_supported_shapes_option', bs => bs.map(b => (b as HTMLElement).innerText.trim()).filter(Boolean)).catch(() => [] as string[]);
  return { stock, title, price: money(priceLine), shape: shapeIdx >= 0 ? lines[shapeIdx + 1] : shapeColon?.replace(/^Shape:\s*/i, ''), shapes };
}

async function cartJson(page: Page) {
  return page.evaluate(async () => (await fetch('/cart.js')).json()).catch(() => null) as Promise<{ item_count: number; total_price: number; items: { key: string; title: string; sku: string; quantity: number; final_line_price: number; properties: Record<string, string> | null }[] } | null>;
}
const lineStock = (i: { sku: string; properties: Record<string, string> | null }) => i.properties?.['_Stock #'] ?? i.properties?.['Stock No.'] ?? i.sku?.replace(/^\d{8}-/, '');

// ------------------------------------------------------------------ Ring Builder flows

/** Stone → setting → completed ring. Leaves the page on the review screen. Returns what was chosen. */
async function stoneFirst(page: Page, cfg: Config, c: Case, type: 'natural' | 'labgrown' | 'gemstone', toReview = true) {
  const url = type === 'gemstone' ? `${RB}rb-stone-list?in_journey=true&diamond_type=gemstone&view_type=grid` : `${RB}rb-stone-list?diamond_type=${type}&view_type=grid&color_type=White`;
  const { rows } = await rbList(page, cfg, url, 'stone', c, `Design Your Own Ring › Start with a ${type === 'labgrown' ? 'Lab-Grown Diamond' : type === 'gemstone' ? 'Gemstone' : 'Natural Diamond'}`);
  const stones = await visibleLinks(page, 'rb-stone-details');
  if (!stones.length) { c.fail(`No stones are shown on the ${type} stone list (${rows.length} sent by the store)`); throw new StepError('No stone to pick'); }
  c.step(`Pick "${stones[0].text}"`);
  await open(page, cfg, stones[0].href, undefined);
  const stone = await readDetail(page);
  stone.button = (await page.locator('a.vdb-rc-stone-pdp__select-btn').locator('visible=true').first().innerText().catch(() => '')).trim();
  c.step(`Click "${stone.button || 'Select'}" for ${stone.title ?? stones[0].text}`);
  const settingWait = page.waitForResponse(isRbList('setting'), { timeout: 45_000 }).catch(() => null);
  await must((await visible(page.locator('a.vdb-rc-stone-pdp__select-btn'))).click(), 'click the stone\'s "Select" button');
  await page.waitForURL(/rb-setting-list|rb-ring-review/, { timeout: 30_000 }).catch(() => { throw new StepError('Selecting the stone did not move on to the setting step'); });
  const settingRows = await rbRows(await settingWait);
  await page.waitForTimeout(1500);
  const header = await mainText(page);
  const kept = !!stone.title && header.toLowerCase().includes(stone.title.toLowerCase().split(' ').slice(0, 3).join(' '));
  c.check(kept || header.includes(stone.stock ?? '#'), `The chosen stone (${stone.title}) is not shown at the setting step`);
  if (!toReview) return { stone, settingRows, setting: undefined as Detail | undefined };
  const settings = await visibleLinks(page, 'rb-setting-details');
  const withStock = settings.filter(s => /stock_num/.test(s.href));
  const pick = withStock.find(s => stone.shape && new RegExp(stone.shape.split(' ')[0], 'i').test(s.text)) ?? withStock[0];
  if (!pick) { c.fail(`No settings are offered for the ${stone.shape ?? ''} stone (${settingRows.length} sent by the store)`); throw new StepError('No setting to pick'); }
  const wrongShape = settingRows.filter(r => r.shape && stone.shape && !sameShape(r.shape, stone.shape));
  if (wrongShape.length) c.note(`(${wrongShape.length} of ${settingRows.length} settings listed are made for another centre shape, e.g. ${wrongShape[0].shape}; the chosen setting was checked for ${stone.shape}.)`);
  c.step(`Pick setting "${pick.text}"`);
  await open(page, cfg, pick.href, undefined);
  const first = await readDetail(page);
  if (stone.shape && first.shapes.length) c.check(first.shapes.some(s => sameShape(s, stone.shape)), `The setting offered (${first.title}) does not support the ${stone.shape} stone (it supports ${first.shapes.join(', ')})`);
  await chooseMetal(page, c);
  await chooseSize(page, c, 7);
  const setting = await readDetail(page); // after the metal change (the stock number follows the metal)
  c.step('Click Select Setting');
  await must((await visible(page.locator('a.vdb-rc-setting-pdp__select-btn'))).click(), 'click "Select Setting"');
  await page.waitForURL(/rb-ring-review/, { timeout: 30_000 }).catch(() => { throw new StepError('Select Setting did not open the completed ring'); });
  await page.waitForTimeout(2500);
  return { stone, settingRows, setting };
}

/** Clicks a metal option different from the current one; reports whether the page followed. */
async function chooseMetal(page: Page, c: Case) {
  const before = (await mainText(page)).match(/Metal Color:\s*([^|]+?)(?= Ring Size| Shape| Head| Shank|$)/)?.[1]?.trim();
  const opts = page.locator('button.vdbrb_list_item_a_metal_type_option').locator('visible=true');
  const n = await opts.count();
  if (n < 2) return;
  c.step('Choose another metal');
  for (let i = 0; i < n; i++) {
    const o = opts.nth(i);
    if (/active|selected/.test((await o.getAttribute('class')) ?? '')) continue;
    await o.click().catch(() => {});
    await page.waitForTimeout(2500);
    break;
  }
  const after = (await mainText(page)).match(/Metal Color:\s*([^|]+?)(?= Ring Size| Shape| Head| Shank|$)/)?.[1]?.trim();
  if (before && after && before === after) c.note(`(Metal still shows ${after} after choosing another metal.)`);
}

/** On the completed-ring screen: both parts, ring size, subtotal = stone + setting. */
async function checkReview(page: Page, c: Case, stoneStock?: string, settingStock?: string, settingTitle?: string) {
  const t = await mainText(page);
  c.check(/Your Completed Ring/i.test(t), 'The "Your Completed Ring" summary is not shown');
  const stocks = [...t.matchAll(/Stock # (\S+)/g)].map(m => m[1]);
  if (stoneStock) c.check(stocks.includes(stoneStock), `The chosen stone ${stoneStock} is not in the completed ring`);
  if (settingStock) c.check(stocks.includes(settingStock) || (!!settingTitle && t.includes(settingTitle)), `The chosen setting ${settingTitle ?? ''} (${settingStock}) is not in the completed ring's details (found ${stocks.join(', ') || 'no stock numbers'})`);
  const prices = [...t.matchAll(/\$([\d,]+\.\d\d) (Stone|Setting) Price/g)].map(m => money(m[1])!);
  const sub = money(t.match(/Subtotal \$([\d,]+\.\d\d)/)?.[1]);
  if (prices.length === 2 && sub != null) c.check(Math.abs(prices[0] + prices[1] - sub) < 0.01, `Subtotal ${fmt$(sub)} is not stone + setting (${fmt$(prices[0])} + ${fmt$(prices[1])})`);
  const img = await page.locator('#MainContent img').evaluateAll(is => is.some(i => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0 && i.getBoundingClientRect().width > 120)).catch(() => false);
  c.check(img, 'No ring preview image is shown');
  return { stocks, prices, sub };
}

/** Add to Cart on the completed ring: compares the cart before and after the click, so only the lines this click added
 *  are counted; checks both parts are there, linked as one ring, with the ring size and a total equal to the subtotal. */
async function ringToCart(page: Page, c: Case, sub?: number, wantSize?: string) {
  const shown = await sizeShown(page);
  if (!shown) {
    c.note('(No ring size was selected on the summary, so one was chosen there.)');
    await chooseSize(page, c, Number(wantSize) || 7).catch(() => {});
    await page.waitForTimeout(2500); // the summary refreshes after a size change
  }
  const stocks = [...(await mainText(page)).matchAll(/Stock # (\S+)/g)].map(m => m[1]);
  const before = await cartJson(page);
  const had = new Map((before?.items ?? []).map(i => [i.key, i.quantity]));
  c.step('Click Add to Cart');
  await must((await visible(page.locator('button.vdb-rc-pdp-actions__primary-btn'))).click(), 'click "Add to Cart" on the completed ring');
  await page.waitForURL(/\/cart/, { timeout: 25_000 }).catch(() => {});
  // wait until the cart actually holds the new lines (up to 15 s)
  let cart = await cartJson(page);
  for (let k = 0; k < 10 && cart && cart.item_count <= (before?.item_count ?? 0); k++) { await page.waitForTimeout(1500); cart = await cartJson(page); }
  if (!cart) throw new StepError('Could not read the cart');
  const added = cart.items.filter(i => (had.get(i.key) ?? 0) < i.quantity);
  if (!c.check(added.length > 0, `Add to Cart put nothing new in the cart (cart has ${cart.item_count} item${cart.item_count === 1 ? '' : 's'})`)) return 'Cart: nothing added.';
  const lines = stocks.length ? added.filter(i => stocks.includes(lineStock(i) ?? '')) : added;
  if (stocks.length) c.check(lines.length === stocks.length, `The cart got ${lines.length} of the ${stocks.length} ring parts (${stocks.join(', ')}); added: ${added.map(l => `${l.title} (${lineStock(l)})`).join(', ')}`);
  const groups = new Set(lines.map(l => l.properties?.['_Order Group ID']).filter(Boolean));
  if (lines.length > 1) c.check(groups.size === 1, 'The stone and setting are not linked as one ring in the cart');
  const total = lines.reduce((s, l) => s + l.final_line_price, 0) / 100;
  if (sub != null) c.check(Math.abs(total - sub) < 0.01, `Cart total for the ring ${fmt$(total)} differs from the subtotal ${fmt$(sub)}`);
  const size = lines.map(l => Object.entries(l.properties ?? {}).find(([k, v]) => /ring ?size/i.test(k) && v)?.[1]).find(Boolean);
  const want = shown || wantSize;
  if (want) c.check(!!size && Number(size) === Number(want), `The cart shows ring size ${size ?? 'none'}, but ${want} was chosen`);
  return `Cart: ${lines.map(l => `"${l.title}"`).join(' + ')}${size ? `, ring size ${size}` : ''}, total ${fmt$(total)}.`;
}

// ------------------------------------------------------------------ groups

/** TC-01, 02, 03, 31, 33: homepage, menus, content pages, header/footer deeplink. */
export async function trackerHome(browser: Browser, cfg: Config, suite: Suite) {
  const ctx = await journeyContext(browser, cfg);
  const page = await ctx.newPage();
  try {
    await suite.run('TC-01', page, async c => {
      c.step('Open shopify.vdbapp.com');
      const t0 = Date.now();
      const g = await gotoSettled(page, cfg.baseUrl, cfg);
      if (g.error || (g.status && g.status >= 400)) throw new StepError(`The homepage did not open (${g.error ?? 'HTTP ' + g.status})`);
      const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined; return n ? { dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd } : null; });
      const ms = nav?.load || nav?.dcl || Date.now() - t0;
      c.check(ms <= 5000, `The homepage took ${(ms / 1000).toFixed(1)} s to load (target under 5 s)`);
      const text = (await page.locator('body').innerText()).toLowerCase();
      c.check(await isVisible(page.locator('.announcement-bar, .utility-bar, .announcement-bar-section')), 'The announcement banner is not visible');
      c.check(/create your own ring now/i.test(text), 'The "Create your own ring now" hero is not on the homepage');
      c.check((await page.locator('a[href*="/products/"]').count()) > 3, 'No product carousels with products are shown');
      c.check(await isVisible(page.locator('footer')), 'The footer is not visible');
      c.step('Scroll to the bottom so every image loads');
      await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 700) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); } window.scrollTo(0, 0); });
      await page.waitForTimeout(2500);
      const broken = await page.$$eval('img', is => is.filter(i => { const im = i as HTMLImageElement; return im.getBoundingClientRect().width > 4 && im.complete && im.naturalWidth === 0 && (im.currentSrc || im.src); }).map(i => (i as HTMLImageElement).currentSrc || (i as HTMLImageElement).src));
      c.check(!broken.length, `${broken.length} images are broken: ${list(broken)}`);
      c.actual = `Loaded in ${(ms / 1000).toFixed(1)} s; banner, "Create your own ring now" hero, product carousels and footer shown; no broken images.`;
    });

    await suite.run('TC-02', page, async c => {
      if (new URL(page.url()).pathname !== '/') await open(page, cfg, cfg.baseUrl, c, 'the homepage');
      const tops = page.locator('header details > summary.header__menu-item').locator('visible=true');
      const n = await tops.count();
      if (!n) throw new StepError('Could not find the top menu');
      const out: string[] = [];
      for (let i = 0; i < n; i++) {
        const s = tops.nth(i);
        const name = (await s.innerText()).trim();
        if (!/engagement|diamond|gemstone|fine jewel/i.test(name)) continue;
        c.step(`Hover ${name}`);
        await s.hover(); await page.waitForTimeout(700);
        let links = await s.locator('xpath=..').locator('a[href]').evaluateAll(as => as.filter(a => (a as HTMLElement).offsetWidth > 0).length);
        if (!links) { await s.click(); await page.waitForTimeout(700); links = await s.locator('xpath=..').locator('a[href]').evaluateAll(as => as.filter(a => (a as HTMLElement).offsetWidth > 0).length); }
        c.check(links > 0, `The ${name} menu opens empty`);
        out.push(`${name}: ${links} links`);
        await page.mouse.move(5, 600); await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(300);
      }
      c.check(out.length >= 4, `Only ${out.length} of the 4 menus were found`);
      c.actual = out.join('; ') + '.';
    });

    await suite.run('TC-03', page, async c => {
      if (new URL(page.url()).pathname !== '/') await open(page, cfg, cfg.baseUrl, c, 'the homepage');
      const picks = await page.evaluate(() => {
        const out: { menu: string; label: string; href: string }[] = [];
        for (const d of document.querySelectorAll('header details')) {
          const menu = (d.querySelector('summary')?.textContent ?? '').trim();
          if (!/engagement|diamond|gemstone|fine jewel/i.test(menu)) continue;
          const cols = d.querySelectorAll('.mega-menu__list > li, .header__submenu > li');
          for (const col of [...cols].slice(0, 4)) {
            const a = [...col.querySelectorAll('a[href]')].find(x => !/^#|javascript/.test(x.getAttribute('href') ?? '') && (x.textContent ?? '').trim());
            const sub = col.querySelectorAll('a[href]')[1] ?? a;
            const link = (sub ?? a) as HTMLAnchorElement | undefined;
            if (link && !out.some(o => o.href === link.href)) out.push({ menu, label: (link.textContent ?? '').replace(/\s+/g, ' ').trim(), href: link.href });
          }
        }
        return out;
      });
      if (!picks.length) throw new StepError('Could not read the menu columns');
      const bad: string[] = [];
      for (const k of picks) {
        c.step(`${k.menu} › ${k.label}`);
        const g = await gotoSettled(page, k.href, cfg);
        const path = new URL(page.url()).pathname;
        const t = await mainText(page);
        if (g.error || (g.status && g.status >= 400)) bad.push(`${k.menu} › ${k.label}: ${g.error ?? 'HTTP ' + g.status}`);
        else if (/page not found|404/i.test(t.slice(0, 300))) bad.push(`${k.menu} › ${k.label}: "Page not found"`);
        else if (path === '/' && new URL(k.href).pathname !== '/') bad.push(`${k.menu} › ${k.label}: sent back to the homepage`);
        else if (t.length < 80) bad.push(`${k.menu} › ${k.label}: blank page`);
      }
      c.check(!bad.length, `${bad.length} menu links do not open a page with content: ${list(bad, 4)}`);
      c.actual = `Opened ${picks.length} links (one per menu column): ${list(picks.map(p => `${p.menu} › ${p.label}`), 6)}${bad.length ? '' : '; all show content'}.`;
    });

    await suite.run('TC-31', page, async c => {
      const out: string[] = [];
      for (const [path, name] of [['pages/about', 'About'], ['policies/refund-policy', 'Refund policy'], ['policies/privacy-policy', 'Privacy policy'], ['policies/terms-of-service', 'Terms of service']]) {
        const g = await open(page, cfg, path, c, name);
        void g;
        const h = await page.locator('#MainContent h1, #MainContent h2').first().innerText().catch(() => '');
        const t = await mainText(page);
        if (c.check(!!h && t.length > 200, `The ${name} page has no heading or text`)) out.push(name);
      }
      await open(page, cfg, cfg.baseUrl, c, 'the homepage FAQ');
      const qs = page.locator('#MainContent details > summary').filter({ hasText: /\?/ });
      const nq = await qs.count();
      let opened = 0;
      for (let i = 0; i < nq; i++) {
        const q = qs.nth(i);
        await q.scrollIntoViewIfNeeded().catch(() => {});
        await q.click().catch(() => {});
        await page.waitForTimeout(300);
        const ok = await q.locator('xpath=..').evaluate(d => (d as HTMLDetailsElement).open && ((d as HTMLElement).innerText.length > ((d.querySelector('summary') as HTMLElement)?.innerText.length ?? 0) + 10));
        if (ok) opened++;
      }
      c.check(nq > 0, 'No FAQ questions were found on the homepage');
      c.check(opened === nq, `${nq - opened} of ${nq} FAQ questions do not expand`);
      const social = await page.$$eval('footer a[href*="facebook"], footer a[href*="instagram"], footer a[href*="youtube"]', as => as.map(a => ({ href: (a as HTMLAnchorElement).href, t: a.getAttribute('target') })));
      const sameTab = social.filter(s => s.t !== '_blank');
      c.check(social.length > 0, 'No social icons in the footer');
      c.check(!sameTab.length, `${sameTab.length} social icons do not open in a new tab: ${list(sameTab.map(s => s.href))}`);
      c.actual = `${out.join(', ')} load with text; ${opened} of ${nq} FAQ answers expand; ${social.length} social icons open in a new tab.`;
    });

    await suite.run('TC-33', page, async c => {
      const header = (await headerLinks(page, cfg)).find(l => /create ring with natural/i.test(l.label));
      const footer = await page.$$eval('footer a[href]', as => as.map(a => ({ label: (a.textContent ?? '').replace(/\s+/g, ' ').trim(), href: (a as HTMLAnchorElement).href })).find(x => /create ring with natural/i.test(x.label)));
      if (!c.check(!!header, 'No "Create Ring with Natural Diamonds" link in the header') || !c.check(!!footer, 'No "Create Ring with Natural Diamond" link in the footer')) return;
      const land = async (href: string, where: string) => {
        const { rows } = await rbList(page, cfg, href, 'stone', c, `the ${where} link`);
        const u = new URL(page.url());
        return { key: u.pathname + '?' + [...u.searchParams.entries()].filter(([k]) => k !== 'in_journey').sort().map(([k, v]) => `${k}=${v}`).join('&'), rows: rows.length, cards: (await visibleLinks(page, 'rb-stone-details')).length };
      };
      const h = await land(header!.href, 'header'), f = await land(footer!.href, 'footer');
      c.check(h.key === f.key, `Header and footer links open different pages: ${h.key} vs ${f.key}`);
      c.check(h.cards > 0 && f.cards > 0, `${h.cards ? 'The footer' : 'The header'} link opens a page with no stones`);
      c.actual = `Both open ${h.key} with stones (${h.cards} / ${f.cards} shown).`;
    });
  } finally { await ctx.close().catch(() => {}); }
}

/** TC-04, 05, 21, 22, 23, 24, 25: search, collections, product page, cart. */
export async function trackerShop(browser: Browser, cfg: Config, suite: Suite) {
  const ctx = await journeyContext(browser, cfg);
  const page = await ctx.newPage();
  try {
    await suite.run('TC-04', page, async c => {
      const input = await openSearch(page, cfg, c);
      c.step('Type "halo ring"');
      await input.pressSequentially('halo ring', { delay: 60 });
      await visible(page.locator('#predictive-search-results'), 15_000).catch(() => { throw new StepError('No suggestions appear while typing "halo ring"'); });
      await page.waitForTimeout(800);
      const sugg = (await page.$$eval('#predictive-search-results-queries-list li', es => es.map(e => (e as HTMLElement).innerText.trim()))).filter(Boolean);
      const idx = sugg.findIndex(t => /halo ring/i.test(t));
      if (!c.check(idx >= 0, `No "halo ring" suggestion is offered (suggestions: ${list(sugg) || 'none'})`)) return;
      c.step(`Select the suggestion "${sugg[idx]}" and press Enter`);
      for (let k = 0; k <= idx; k++) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(150); }
      await Promise.all([page.waitForURL(u => !/^\/$/.test(u.pathname), { timeout: 25_000 }).catch(() => {}), page.keyboard.press('Enter')]);
      await settle(page, 800);
      const landed = new URL(page.url()).pathname;
      c.check(landed !== '/', `Pressing Enter on "${sugg[idx]}" does not open anything`);
      await loadAllImages(page);
      const ps = await products(page);
      if (!c.check(ps.length > 0, `"${sugg[idx]}" (${landed}) shows no products`)) return;
      const halo = ps.filter(p => /halo/i.test(p.title));
      c.check(halo.length >= Math.ceil(ps.length / 2), `Only ${halo.length} of ${ps.length} products on ${landed} are halo rings`);
      // pictures only need to load: a product may show the picture of the selected metal (rose gold, yellow gold …)
      const noImg = ps.filter(p => !p.imgOk);
      c.check(!noImg.length, `${noImg.length} products show no picture (broken or missing): ${list(noImg.map(p => `${p.title} (${p.href})`))}`);
      const pick = halo[0] ?? ps[0];
      c.step(`Open "${pick.title}"`);
      await open(page, cfg, pick.href, undefined, `"${pick.title}"`);
      const h1 = (await page.locator('#MainContent h1').first().innerText().catch(() => '')).trim();
      const main = await page.locator('#MainContent .product__media img, #MainContent media-gallery img').first().evaluate(i => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0).catch(() => false);
      c.check(h1.toLowerCase() === pick.title.toLowerCase(), `Clicking "${pick.title}" opens "${h1 || 'a page without a title'}"`);
      c.check(main, `"${pick.title}" opens without a product picture`);
      c.actual = `Suggestion "${sugg[idx]}" + Enter opens ${landed}: ${halo.length} of ${ps.length} products are halo rings, all with pictures; "${h1}" opens with its picture.`;
    });

    await suite.run('TC-05', page, async c => {
      await submitSearch(page, cfg, c, 'xyz123');
      const ps = await products(page);
      const t = await mainText(page);
      const msg = t.match(/No results found[^.]*\.?[^.]*\./i)?.[0];
      c.check(!ps.length, `A word that matches nothing shows ${ps.length} products: ${list(ps.map(p => p.title))}`);
      c.check(!!msg, 'No friendly "no results" message is shown');
      c.actual = msg ? `Shows: ${msg}` : '';
    });

    await suite.run('TC-21', page, async c => {
      const cols: [string, string][] = [['collections/solitaire-rings', 'Solitaire'], ['collections/stud-earrings', 'Stud Earrings'], ['collections/tennis-bracelet', 'Tennis Bracelets'], ['collections/pendants', 'Pendants'], ['collections/hoop-earrings', 'Hoop Earrings']];
      const out: string[] = [];
      for (const [path, name] of cols) {
        await open(page, cfg, path, c, `the ${name} collection`);
        await loadAllImages(page); // pictures load as you scroll; scroll first, like a shopper
        const ps = await products(page);
        if (!c.check(ps.length > 0, `${name} (/${path}) shows no products`)) continue;
        const noImg = ps.filter(p => !p.imgOk);
        const noPrice = ps.filter(p => !p.price);
        c.check(!noImg.length, `${name} (/${path}): ${noImg.length} of ${ps.length} products show no picture: ${list(noImg.map(p => `${p.title} – ${p.href}`))}`);
        c.check(!noPrice.length, `${name} (/${path}): ${noPrice.length} of ${ps.length} products show no price: ${list(noPrice.map(p => `${p.title} – ${p.href}`))}`);
        const data = await productData(page);
        const fromWrong = ps.flatMap(p => {
          const d = data.find(x => x.handle === p.handle);
          if (!d || p.price == null || !d.variants.length) return [];
          const lo = Math.min(...d.variants.map(v => v.price));
          return Math.abs(p.price - lo) > 0.01 ? [`${p.title}: card says ${fmt$(p.price)} but its cheapest option is ${fmt$(lo)} – ${p.href}`] : [];
        });
        c.check(!fromWrong.length, `${name}: the card price is not the product's lowest price for ${fromWrong.length} product${fromWrong.length > 1 ? 's' : ''}: ${list(fromWrong, 4)}`);
        out.push(`${name} ${ps.length}`);
      }
      // the menu's "Yellow Gold" opens the Ring Builder setting list
      const { rows } = await rbList(page, cfg, `${RB}rb-setting-list?jewelry_type=ring&view_type=grid&metal_type=Yellow%20Gold%7C18K`, 'setting', c, 'Yellow Gold (Ring Builder)');
      const yg = await visibleLinks(page, 'rb-setting-details');
      c.check(yg.length > 0, `Yellow Gold shows no settings (${rows.length} sent by the store)`);
      out.push(`Yellow Gold ${yg.length}`);
      c.actual = `Products with image, name and "From" price: ${out.join(', ')}.`;
    });

    await suite.run('TC-22', page, async c => {
      await open(page, cfg, 'collections/solitaire-rings', c, 'the Solitaire Rings collection');
      const facets = await page.$$eval('facet-filters-form details > summary, #FacetFiltersForm details > summary', es => [...new Set(es.filter(e => (e as HTMLElement).offsetWidth > 0).map(e => (e as HTMLElement).innerText.split('\n')[0].trim()))]);
      const metalFacet = facets.find(f => /metal|shank colou?r/i.test(f));
      if (!c.check(!!metalFacet, `There is no metal filter on the collection (filters: ${facets.join(', ')})`)) return;
      const opts = await facetOptions(page, metalFacet!);
      const val = opts[0];
      c.step(`${metalFacet}: tick ${val}`);
      await tickOption(page, metalFacet!, val, /filter\./);
      const data = await productData(page);
      const wrong = data.filter(p => !p.variants.some(v => v.options.some(o => o.toLowerCase() === val.toLowerCase())) && !p.title.toLowerCase().includes(val.toLowerCase()));
      c.check(data.length > 0, `${val} shows no products`);
      c.check(!wrong.length, `${wrong.length} of ${data.length} products are not available in ${val}: ${list(wrong.map(p => p.title))}`);
      c.step('Sort by Price, low to high');
      const sel = page.locator('select[name="sort_by"]').locator('visible=true').first();
      await must(sel.selectOption('price-ascending'), 'choose "Price, low to high"');
      await afterChange(page, /sort_by=price-ascending/, 'sorting by price');
      const ps = (await products(page)).filter(p => p.price != null);
      const bad = ps.findIndex((p, i) => i > 0 && p.price! < ps[i - 1].price!);
      c.check(bad < 0, `Sorted by price but ${ps[bad - 1]?.title} (${fmt$(ps[bad - 1]?.price)}) comes before ${ps[bad]?.title} (${fmt$(ps[bad]?.price)})`);
      c.actual = `${metalFacet} = ${val}: ${data.length - wrong.length} of ${data.length} products come in it; sorted low to high ${fmt$(ps[0]?.price)} … ${fmt$(ps[ps.length - 1]?.price)}.`;
    });

    await suite.run('TC-23', page, async c => {
      const handle = '14k-rose-gold-round-halo-engagement-ring-7';
      await open(page, cfg, `products/${handle}`, c, '"14K Rose Gold Round Halo engagement ring"');
      const js = await page.evaluate(async h => (await fetch(`/products/${h}.js`)).json(), handle) as { options: (string | { name: string })[]; variants: { id: number; price: number; options: string[]; available: boolean; featured_image?: { src: string } | null }[] };
      const names = js.options.map(o => typeof o === 'string' ? o : o.name);
      const shown = async () => {
        const p = await page.locator('.product__info-container .price').first().evaluate(el => ((el.classList.contains('price--on-sale') ? el.querySelector('.price-item--sale') : el.querySelector('.price__regular .price-item--regular, .price-item--regular'))?.textContent ?? '').trim()).catch(() => '');
        const img = await page.locator('.product__media-item.is-active img, .product__media-list img').first().getAttribute('src').catch(() => '');
        const vid = new URL(page.url()).searchParams.get('variant');
        return { price: money(p), img, vid };
      };
      const out: string[] = [];
      const missingOpts = ['metal', 'carat', 'ring size'].filter(k => !names.some(n => n.toLowerCase().includes(k === 'metal' ? 'color' : k) || n.toLowerCase().includes(k)));
      for (const name of names) {
        const radios = page.locator(`input[type="radio"][name="${name}"]`);
        const n = await radios.count();
        if (n < 2) continue;
        const before = await shown();
        let target = '';
        for (let i = 0; i < n; i++) { const r = radios.nth(i); if (!(await r.isChecked())) { target = (await r.getAttribute('value')) ?? ''; const id = await r.getAttribute('id'); c.step(`Change ${name} to ${target}`); await page.locator(`label[for="${id}"]`).click(); break; } }
        await page.waitForTimeout(1800);
        const after = await shown();
        const v = js.variants.find(x => String(x.id) === after.vid);
        c.check(after.vid !== before.vid, `Changing ${name} to ${target} does not change the selected option`);
        if (v) c.check(after.price != null && Math.abs(after.price - v.price / 100) < 0.01, `After choosing ${target}, the page shows ${fmt$(after.price)} but that option costs ${fmt$(v.price / 100)}`);
        if (v?.featured_image && before.img) c.check(after.img !== before.img, `The image does not change after choosing ${target}`);
        out.push(`${name} → ${target}: ${fmt$(after.price)}${v && before.price != null && Math.abs(v.price / 100 - before.price) < 0.01 ? ' (same price as before)' : ''}`);
      }
      const add = page.locator('button[name="add"]').locator('visible=true').first();
      const enabled = await add.isEnabled().catch(() => false);
      const nowVid = (await shown()).vid;
      const sel = js.variants.find(x => String(x.id) === nowVid);
      if (sel?.available) c.check(enabled, 'Add to cart is disabled for an option that is in stock');
      if (missingOpts.length) c.note(`(This product has no ${missingOpts.join(' / ')} option to change; options are ${names.join(', ')}.)`);
      c.actual = `${out.join('; ')}; Add to cart ${enabled ? 'enabled' : 'disabled'}.`;
    });

    await suite.run('TC-24', page, async c => {
      await open(page, cfg, 'collections/wedding-bands', c, 'the Wedding Bands collection');
      const ps = await products(page);
      const sold = ps.find(p => p.soldOut);
      if (!sold) { c.skip('No wedding band is sold out right now, so the sold-out page could not be checked'); c.actual = `${ps.length} bands, none sold out.`; return; }
      const link = page.locator('#product-grid > li, ul.product-grid > li').filter({ hasText: sold.title }).locator('a[href*="/products/"]').first();
      c.step(`Open "${sold.title}"`);
      await Promise.all([page.waitForURL(/\/products\//, { timeout: 20_000 }).catch(() => {}), link.click()]);
      await settle(page, 500);
      const t = await mainText(page);
      const add = page.locator('button[name="add"]').locator('visible=true').first();
      const disabled = !(await add.isEnabled().catch(() => true));
      c.check(/sold out/i.test(t), `"${sold.title}" does not say Sold out on its page`);
      c.check(disabled, `"${sold.title}" can still be added to the cart`);
      c.actual = `"${sold.title}" shows Sold out and Add to cart is ${disabled ? 'disabled' : 'enabled'}.`;
    });

    await suite.run('TC-25', page, async c => {
      await open(page, cfg, 'collections/stud-earrings', c, 'Stud Earrings');
      const data = (await productData(page)).filter(p => p.available);
      if (!data.length) { c.blocked('No product in stock to add'); return; }
      const p = data[0];
      await open(page, cfg, `products/${p.handle}`, c, `"${p.title}"`);
      c.step('Click Add to cart');
      await must((await visible(page.locator('button[name="add"]'))).click(), 'click "Add to cart"');
      await page.waitForTimeout(2500);
      let cart = await cartJson(page);
      c.check(!!cart && cart.item_count >= 1, 'The product was not added to the cart');
      await open(page, cfg, 'cart', c, 'the cart page');
      const line = page.locator('.cart-item').first();
      const unit = cart?.items[0] ? cart.items[0].final_line_price / 100 / cart.items[0].quantity : undefined;
      c.step('Change quantity to 2');
      const plus = line.locator('button[name="plus"]');
      await must(plus.click(), 'press + on the cart line');
      await page.waitForTimeout(2500);
      cart = await cartJson(page);
      const q = cart?.items[0]?.quantity ?? 0;
      const errText = (await page.locator('.cart-item__error-text, #cart-errors').allInnerTexts().catch(() => [] as string[])).join(' ').trim();
      if (q === 2) {
        const totalShown = money(await page.locator('.totals__total-value, .totals__subtotal-value').first().innerText().catch(() => ''));
        c.check(unit != null && Math.abs((cart!.items[0].final_line_price / 100) - unit * 2) < 0.01, 'The line total did not double');
        c.check(totalShown != null && Math.abs(totalShown - cart!.total_price / 100) < 0.01, `The estimated total on the page (${fmt$(totalShown)}) does not match the cart (${fmt$(cart!.total_price / 100)})`);
      } else if (errText) c.note(`(Only 1 in stock: the cart says "${errText}", which is the correct behaviour.)`);
      else c.fail('Quantity did not change to 2 and no message explained why');
      c.step('Remove the item');
      await must(page.locator('cart-remove-button a, cart-remove-button button, .cart-item__remove').first().click(), 'remove the cart line');
      await page.waitForTimeout(2500);
      const empty = /your cart is empty/i.test(await mainText(page));
      cart = await cartJson(page);
      c.check(empty && cart?.item_count === 0, 'The cart does not show "Your cart is empty" after removing the item');
      c.actual = `Added "${p.title}"; quantity ${q === 2 ? '2 with line and estimated totals updated' : 'stayed 1 (stock 1)'}; removed and "Your cart is empty" shown.`;
    });
  } finally { await ctx.close().catch(() => {}); }
}

/** TC-06 … TC-12: Diamond Search from the menus, filters, sort, detail, lab-grown, shape and colour shortcuts. */
export async function trackerDiamonds(browser: Browser, cfg: Config, suite: Suite) {
  const ctx = await journeyContext(browser, cfg);
  const page = await ctx.newPage();
  const s = new DS(page, cfg);
  let links: { label: string; href: string }[] = [];
  const dsLinks = async () => (links.length ? links : (links = await headerLinks(page, cfg)));
  try {
    await suite.run('TC-06', page, async c => {
      const l = (await dsLinks()).find(x => /^search diamonds?$/i.test(x.label) && !/Lab_grown/i.test(x.href));
      if (!c.check(!!l, 'No "Search Diamonds" link under Diamonds › Natural')) return;
      await forgetFilters(page);
      await open(page, cfg, l!.href, c, 'Diamonds › Natural › Search Diamonds');
      const form = await visible(page.locator('a.vdb-search-diamond-data-wrap'), 30_000).then(() => true).catch(() => false);
      if (!c.check(form, 'The link does not open the Diamond Search form')) return;
      await page.waitForTimeout(1200);
      const r = await s.search(c);
      c.check((r.total ?? 0) > 0, 'Pressing Search shows no results');
      c.actual = `Opens the search form; Search shows ${nf(r.total)} results.`;
    });

    await suite.run('TC-07', page, async c => {
      await s.open(c);
      const base = (await s.search(c, undefined, 'pressing Search without filters')).total;
      await s.open(c);
      await s.shape('Oval', c);
      await s.fill('vdbrb_min_carat_web', '1.00', 'minimum carat', c);
      await s.fill('vdbrb_max_carat_web', '2.00', 'maximum carat', c);
      await s.slider('vbdrb_white_color_web', 'G', 'H', 'Color', c);
      await s.slider('vbdrb_clarity_web', 'VS1', 'VS2', 'Clarity', c);
      await s.fill('vdbrb_min_budget_web', '50', 'minimum price', c);
      await s.fill('vdbrb_max_budget_web', '60000', 'maximum price', c);
      const r = await s.search(c);
      c.check(r.total !== base, `The result count did not change (${nf(r.total)})`);
      const cards = await s.cards();
      if (!cards.length) { c.blocked(`No diamonds match these filters (${nf(r.total)} results)`); return; }
      const bad = cards.filter(k => { const d = s.byId.get(k.id); const ct = Number(d?.size ?? k.carat), p = Number(d?.total_sales_price ?? k.price); return !(sameShape(d?.shape ?? k.shape, 'Oval') && ct >= 1 && ct <= 2 && ['G', 'H'].includes(d?.color ?? k.color ?? '') && ['VS1', 'VS2'].includes(d?.clarity ?? k.clarity ?? '') && p >= 50 && p <= 60000); });
      c.check(!bad.length, `${bad.length} of ${cards.length} diamonds do not match every filter: ${list(bad.map(b => b.name))}`);
      c.actual = `${nf(r.total)} results (was ${nf(base)}); ${cards.length - bad.length} of ${cards.length} diamonds match Oval, 1–2 ct, G–H, VS1–VS2, $50–$60,000.`;
    });

    await suite.run('TC-08', page, async c => {
      await s.open(c);
      await s.search(c);
      c.step('Open Sort');
      await must((await visible(page.getByText('Sort', { exact: true }))).click(), 'open "Sort"');
      await page.waitForTimeout(800);
      const overlaps = await page.evaluate(() => {
        const els = [...document.querySelectorAll('a.vdb-available_sorting, .vdb-selected_sorting, [class*=sort_nav] a, [class*=sort_nav] li')].filter(e => (e as HTMLElement).offsetWidth > 0 && (e as HTMLElement).innerText.trim());
        const rs = els.map(e => ({ t: (e as HTMLElement).innerText.trim(), r: e.getBoundingClientRect() }));
        const out: string[] = [];
        for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
          const a = rs[i].r, b = rs[j].r;
          if (a.width * a.height === 0 || b.width * b.height === 0 || els[i].contains(els[j]) || els[j].contains(els[i])) continue;
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (w > 4 && h > 4 && w * h > 0.3 * Math.min(a.width * a.height, b.width * b.height)) out.push(`"${rs[i].t}" / "${rs[j].t}"`);
        }
        return out;
      });
      c.check(!overlaps.length, `Sort options overlap each other: ${list(overlaps)}`);
      const asc = await s.search(c, async () => (await visible(page.locator('a.vdb-available_sorting', { hasText: /^\s*Total Price\s*$/ }))).click(), 'choosing Total Price', r => isPage1(r) && /total_sales_price%22%3A%22ASC/.test(post(r)));
      const pr = asc.items.map(d => Number(d.total_sales_price));
      const bad = pr.findIndex((v, i) => i > 0 && v < pr[i - 1]);
      c.check(bad < 0, `Sorted by price but ${fmt$(pr[bad - 1])} comes before ${fmt$(pr[bad])}`);
      await page.locator('a.vdb-grid_sort_nav_con_close').locator('visible=true').first().click().catch(() => {});
      const n0 = (await s.cards()).length;
      c.step('Scroll to load more');
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight - 1700));
      await page.waitForFunction(n => document.querySelectorAll('.vdb-search-result-block').length > n, n0, { timeout: 15_000 }).catch(() => {});
      const n1 = (await s.cards()).length;
      c.check(n1 > n0, 'Scrolling does not load more diamonds');
      c.actual = `Price low → high in order (${fmt$(pr[0])} first); sort options do not overlap; scrolling loads ${n0} → ${n1} cards.`;
    });

    await suite.run('TC-09', page, async c => {
      await s.open(c);
      await s.search(c);
      const card = (await s.cards())[0];
      if (!card) { c.blocked('No diamond to open'); return; }
      await s.openDetail(card, c);
      const t = await page.locator('.vdb-w-50.vdb-padd-right-0').locator('visible=true').first().innerText().catch(() => '');
      const miss = ['Shape', 'Carat', 'Cut', 'Color', 'Clarity'].filter(l => !new RegExp('(^|\\n)\\s*' + l + '\\s*(\\n|$)').test(t));
      c.check(!miss.length, `Specs missing: ${miss.join(', ')}`);
      c.check(await isVisible(page.locator('a.vdb-open_cert_url')), 'No certificate link');
      const media = await page.locator('.vdb-w-50, .vdb-custom-modal').locator('visible=true').evaluateAll(() => [...document.querySelectorAll('a.vdb-video_url_open, [class*="360"], iframe, video, img')].some(e => { const r = e.getBoundingClientRect(); return r.width > 80 && r.height > 80 && (e.tagName !== 'IMG' || ((e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth > 0)); }));
      c.check(media, 'No picture, video or 360 view is shown for the diamond');
      c.check(/\$\s*[\d,]+\.\d\d/.test(t), 'No price');
      c.check(await isVisible(page.locator('button.vdb-addbutton')), 'No Add to cart button');
      c.actual = `"${card.name}": specs, certificate, picture/video, price and Add to cart shown (Diamond Search app: Add to cart is expected here; Add to ring is part of the Ring Builder, checked in TC-14).`;
    });

    await suite.run('TC-10', page, async c => {
      const l = (await dsLinks()).find(x => /^search diamonds?$/i.test(x.label) && /Lab_grown/i.test(x.href));
      if (!c.check(!!l, 'No "Search Diamond" link under Diamonds › Lab-Grown')) return;
      await forgetFilters(page);
      await open(page, cfg, l!.href, c, 'Diamonds › Lab-Grown › Search Diamond');
      await must(visible(page.locator('a.vdb-search-diamond-data-wrap'), 30_000), 'see the lab-grown search form');
      await page.waitForTimeout(1200);
      const r = await s.search(c);
      c.check((r.total ?? 0) > 0, 'The lab-grown search shows no results');
      c.check(r.items.every(d => d.lab_grown !== false), 'Natural diamonds appear in the lab-grown results');
      await s.open(c, 'apps/vdb-app/search-filters?structure=new&diamondSearchType=Lab_grown_Diamond');
      await s.shape('Round', c);
      const r2 = await s.search(c, undefined, 'pressing Search with Round');
      const cards = await s.cards();
      const bad = cards.filter(k => !sameShape(s.byId.get(k.id)?.shape ?? k.shape, 'Round'));
      c.check(r2.total !== r.total, 'The lab-grown count does not change when Round is chosen');
      c.check(!bad.length, `${bad.length} lab-grown diamonds are not Round after choosing Round`);
      c.actual = `${nf(r.total)} lab-grown results; with Round: ${nf(r2.total)}, all Round.`;
    });

    await suite.run('TC-11', page, async c => {
      const want = ['Round', 'Princess', 'Cushion', 'Emerald', 'Oval', 'Heart'];
      const all = await dsLinks();
      const out: string[] = [];
      for (const sh of want) {
        const l = all.find(x => x.label === sh && /search-filters/.test(x.href) && !/Lab_grown/i.test(x.href));
        if (!c.check(!!l, `No ${sh} shortcut under Diamonds`)) continue;
        await forgetFilters(page);
        const wait = page.waitForResponse(isPage1, { timeout: 20_000 }).catch(() => null);
        await open(page, cfg, l!.href, c, `the ${sh} shortcut`);
        if (!(await wait)) await s.search(c, undefined, `pressing Search on the ${sh} page`).catch(() => null);
        await page.waitForTimeout(1500);
        const cards = await s.cards();
        if (!cards.length) { c.fail(`The ${sh} shortcut shows no diamonds`); continue; }
        const bad = cards.filter(k => !sameShape(s.byId.get(k.id)?.shape ?? k.shape, sh));
        c.check(!bad.length, `${sh}: ${bad.length} of ${cards.length} diamonds are another shape (${list(bad.map(b => b.name), 2)})`);
        out.push(`${sh} ${cards.length - bad.length}/${cards.length}`);
      }
      c.actual = `Each shortcut opens Diamond Search filtered to its shape: ${out.join(', ')} diamonds shown match.`;
    });

    await suite.run('TC-12', page, async c => {
      const fancy = (await dsLinks()).filter(x => /fancy=/.test(x.href));
      const uniq = [...new Map(fancy.map(f => [f.href, f])).values()];
      if (!c.check(uniq.length > 0, 'No coloured-diamond links in the Diamonds menu')) return;
      const out: string[] = [];
      for (const l of uniq) {
        const col = new URL(l.href).searchParams.get('fancy') ?? l.label;
        const lab = /Lab_grown/i.test(l.href);
        const name = `${lab ? 'Colored Lab-Grown' : 'Colored Natural'} › ${l.label}`;
        await forgetFilters(page);
        const wait = page.waitForResponse(isPage1, { timeout: 20_000 }).catch(() => null);
        await open(page, cfg, l.href, c, name);
        if (!(await wait)) await s.search(c, undefined, `pressing Search on ${name}`).catch(() => null);
        await page.waitForTimeout(1500);
        const cards = await s.cards();
        if (!cards.length) { c.fail(`${name}: no results`); out.push(`${name}: none`); continue; }
        const bad = cards.filter(k => { const d = s.byId.get(k.id); return d ? !new RegExp(col, 'i').test(d.fancy_color_dominant_color ?? '') : !new RegExp(col, 'i').test(k.name); });
        c.check(!bad.length, `${name}: ${bad.length} of ${cards.length} diamonds are not ${col}`);
        out.push(`${name}: ${cards.length - bad.length}/${cards.length}`);
      }
      c.actual = `${out.join('; ')}.`;
    });
  } finally { await ctx.close().catch(() => {}); }
}

/** TC-13, 14, 17, 16: gemstones, Ring Builder starting with a stone, ring to cart, lab-grown and gemstone starts. */
export async function trackerStoneFirst(browser: Browser, cfg: Config, suite: Suite) {
  const ctx = await journeyContext(browser, cfg);
  const page = await ctx.newPage();
  watchDialogs(page);
  try {
    await suite.run('TC-13', page, async c => {
      const g = new GS(page, cfg);
      const out: string[] = [];
      for (const [url, name, shape] of [['apps/vdb-app/gemstone?&gem_type=Ruby', 'Gemstones › Ruby', ''], ['apps/vdb-app/gemstone?&shapes=Oval', 'Gemstones › Shop by Shape › Oval', 'Oval']] as const) {
        await forgetFilters(page);
        await open(page, cfg, url, c, name);
        await g.waitCount(`opening ${name}`);
        await page.waitForTimeout(1500);
        const cards = await g.cards();
        if (!c.check(cards.length > 0, `${name} shows no gemstones`)) continue;
        const imgs = await page.$$eval('.vdbgs-get_show_pro_data', es => es.filter(e => (e as HTMLElement).offsetWidth > 0).map(e => { const i = e.querySelector('img') as HTMLImageElement | null; return { name: (e.querySelector('.vdb-gem-product-title-and-price p')?.textContent ?? '').trim(), ok: !!i && i.complete && i.naturalWidth > 0 && !/no-?image|placeholder/i.test(i.currentSrc || i.src) }; }));
        const noImg = imgs.filter(x => !x.ok);
        c.check(!noImg.length, `${name}: ${noImg.length} of ${imgs.length} gemstones have no image (${list(noImg.map(x => x.name))})`);
        const noPrice = cards.filter(k => !k.price);
        c.check(!noPrice.length, `${name}: ${noPrice.length} gemstones have no price`);
        if (shape) { const bad = cards.filter(k => !sameShape(g.byId.get(k.id)?.shape ?? k.name.split(' ')[0], shape)); c.check(!bad.length, `${name}: ${bad.length} gemstones are not ${shape}`); }
        out.push(`${name}: ${nf(await g.count())} results, ${imgs.length - noImg.length}/${imgs.length} with images`);
      }
      c.actual = out.join('; ') + '.';
    });

    let review: { sub?: number } = {};
    await suite.run('TC-14', page, async c => {
      await forgetFilters(page);
      const { stone, setting } = await stoneFirst(page, cfg, c, 'natural');
      const r = await checkReview(page, c, stone.stock, setting?.stock, setting?.title);
      review = { sub: r.sub };
      c.actual = `Stone ${stone.title} (${stone.stock}, ${fmt$(stone.price)}) added to the ring with "${stone.button || 'Select'}" + setting ${setting?.title} (${setting?.stock}, ${fmt$(setting?.price)}) → completed ring shows both in its details, subtotal ${fmt$(r.sub)}.`;
    });

    await suite.run('TC-17', page, async c => {
      c.actual = await ringToCart(page, c, review.sub);
    }, ['TC-14']);

    await suite.run('TC-16', page, async c => {
      const out: string[] = [];
      for (const type of ['labgrown', 'gemstone'] as const) {
        await forgetFilters(page);
        const { stone } = await stoneFirst(page, cfg, c, type, false);
        out.push(`${type === 'labgrown' ? 'Lab-grown' : 'Gemstone'}: ${stone.title} kept at the setting step`);
      }
      c.actual = out.join('; ') + '.';
    });
  } finally { await ctx.close().catch(() => {}); }
}

/** TC-15, 18, 19, 20: Ring Builder starting with a setting (to cart), 3D builder, quiz, configurators. */
export async function trackerSettingFirst(browser: Browser, cfg: Config, suite: Suite) {
  const ctx = await journeyContext(browser, cfg);
  const page = await ctx.newPage();
  const dialogs = watchDialogs(page);
  try {
    await suite.run('TC-15', page, async c => {
      let { rows } = await rbList(page, cfg, `${RB}rb-setting-list?in_journey=true&jewelry_type=ring&view_type=grid`, 'setting', c, 'Design Your Own Ring › Start with Setting');
      let settings = (await visibleLinks(page, 'rb-setting-details')).filter(s => /ring_stock_num/.test(s.href));
      if (!settings.length) {
        c.step('No settings shown: wait 20 s and reload once');
        await page.waitForTimeout(20_000);
        ({ rows } = await rbList(page, cfg, `${RB}rb-setting-list?in_journey=true&jewelry_type=ring&view_type=grid`, 'setting', c, 'Start with Setting again'));
        settings = (await visibleLinks(page, 'rb-setting-details')).filter(s => /ring_stock_num/.test(s.href));
      }
      if (!settings.length) {
        c.fail(`"Start with Setting" shows no settings (the store's setting service returned ${rows.length})`);
        c.step('Continue the flow from the menu\'s Solitaire settings to check the rest');
        await rbList(page, cfg, `${RB}rb-setting-list?jewelry_type=ring&ring_style=Solitaire`, 'setting', c, 'Engagement Rings › Solitaire');
        settings = (await visibleLinks(page, 'rb-setting-details')).filter(s => /ring_stock_num/.test(s.href));
        if (!settings.length) throw new StepError('No settings could be found anywhere to continue');
      }
      // some settings take only one exact stone size (e.g. 0.63 ct Cushion) that may be out of stock:
      // then the test goes back and picks the next setting (up to 4), and notes the ones without stones
      let setting: Detail | undefined, size = '', stones: any[] = [], links: { href: string; text: string }[] = [];
      const empty: string[] = [];
      for (const pick of settings.slice(0, 4)) {
        c.step(`Pick setting "${pick.text}"`);
        await open(page, cfg, pick.href, undefined, `setting "${pick.text}"`);
        await chooseMetal(page, c);
        size = await chooseSize(page, c, 6);
        setting = await readDetail(page);
        const stoneWait = page.waitForResponse(isRbList('stone'), { timeout: 45_000 }).catch(() => null);
        const t0 = Date.now();
        c.step('Click Select Setting');
        await must((await visible(page.locator('a.vdb-rc-setting-pdp__select-btn'))).click(), 'click "Select Setting"');
        await page.waitForURL(/rb-stone-list|rb-ring-review/, { timeout: 30_000 }).catch(() => { throw new StepError('Select Setting did not move on to choosing a stone'); });
        stones = await rbRows(await stoneWait);
        await page.waitForFunction(() => [...document.querySelectorAll('a[href*="rb-stone-details"]')].some(a => (a as HTMLElement).offsetWidth > 0 && (a as HTMLElement).innerText.trim()), null, { timeout: 15_000 }).catch(() => {});
        recordPerf(page, { kind: 'Results shown', url: page.url().replace(cfg.baseUrl, '/'), name: `Stones for setting "${pick.text}"`, ms: Date.now() - t0 });
        links = await visibleLinks(page, 'rb-stone-details');
        if (links.length) break;
        const u = new URL(page.url()).searchParams;
        empty.push(`"${pick.text}" (needs ${[u.get('shape'), u.get('min_carat') && u.get('min_carat') === u.get('max_carat') ? `${u.get('min_carat')} ct` : u.get('min_carat') ? `${u.get('min_carat')}–${u.get('max_carat')} ct` : ''].filter(Boolean).join(' ') || 'its stone'}) – ${page.url().replace(cfg.baseUrl, '/')}`);
      }
      if (empty.length) c.note(`(No stones in stock for ${empty.length} setting${empty.length > 1 ? 's' : ''}, so the next one was used: ${list(empty, 3)}.)`);
      if (!links.length || !setting) { c.fail(`None of the first ${empty.length} settings offers any stone: ${list(empty, 4)}`); return; }
      const supported = setting.shapes.length ? setting.shapes : setting.shape ? [setting.shape] : [];
      const incompatible = stones.filter(r => supported.length && !supported.some(s => sameShape(s, r.shape)));
      c.check(!incompatible.length, `${incompatible.length} of ${stones.length} stones offered do not fit the setting (it takes ${supported.join(', ')}; offered e.g. ${incompatible[0]?.shape})`);
      c.step(`Pick "${links[0].text}"`);
      await open(page, cfg, links[0].href, undefined, `stone "${links[0].text}"`);
      const stone = await readDetail(page);
      c.step('Click Select …');
      await must((await visible(page.locator('a.vdb-rc-stone-pdp__select-btn'))).click(), 'click the stone\'s "Select" button');
      await page.waitForURL(/rb-ring-review/, { timeout: 30_000 }).catch(() => { throw new StepError('Selecting the stone did not open the completed ring'); });
      await page.waitForTimeout(2500);
      const r = await checkReview(page, c, stone.stock, setting.stock, setting.title);
      const kept = await sizeShown(page);
      c.check(!!kept && Number(kept) === Number(size), `The ring size chosen (${size}) is not kept on the summary (shows "${kept || 'none'}")`);
      const cartLine = await ringToCart(page, c, r.sub, kept || size);
      c.actual = `Setting ${setting.title} (${setting.stock}), ring size ${size} → ${stones.length} compatible stones offered → ${stone.title} → completed ring ${fmt$(r.sub)}, size ${kept || '–'} kept. ${cartLine}`;
    });

    await suite.run('TC-18', page, async c => {
      await open(page, cfg, `${RB}rb-setting-details?in_journey=true&ring_stock_num=SG-SL1003-RD-14W-14W&ring_reference_id=240081`, c, '3D Ring Builder');
      const canvas = page.locator('#webgl_vdb_canvas, canvas').locator('visible=true').first();
      if (!c.check(await canvas.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false), 'The 3D viewer does not appear')) return;
      // the test browser has no graphics card, so a picture of a 3D view takes ~25 s to take: allow 45 s per picture
      const shot = () => canvas.screenshot({ timeout: 45_000 }).catch(() => Buffer.alloc(0));
      const stock = async () => (await readDetail(page)).stock;
      // the 3D model can take a while to draw: wait up to 90 s for something to appear
      const t0 = Date.now();
      // the time counted is until the picture that shows the model was started (taking the picture itself is slow here)
      let tShot = Date.now(), a = await shot();
      while (a.length < 8000 && Date.now() - t0 < 90_000) { await page.waitForTimeout(3000); tShot = Date.now(); a = await shot(); }
      const renderS = Math.round((tShot - t0) / 1000);
      if (!c.check(a.length >= 8000, 'The 3D viewer stays blank after 90 s')) return;
      const changed = async (prev: Buffer) => { await page.waitForTimeout(3000); let x = await shot(); for (let k = 0; k < 2 && (x.equals(prev) || !x.length); k++) { await page.waitForTimeout(3000); x = await shot(); } return x; };
      c.step('Drag the model');
      const box = await canvas.boundingBox();
      if (box) { await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 15 }); await page.mouse.up(); }
      const b = await changed(a);
      c.check(!a.equals(b), 'Dragging does not rotate the model');
      const s0 = await stock();
      c.step('Change the metal');
      const metals = page.locator('button.vdbrb_list_item_a_metal_type_option').locator('visible=true');
      if (await metals.count() > 1) await metals.nth(1).click({ timeout: 8000 }).catch(() => metals.nth(1).evaluate(b => (b as HTMLElement).click()).catch(() => {}));
      const m = await changed(b); const s1 = await stock();
      c.check(s1 !== s0 || !m.equals(b), 'Changing the metal does not update the model or stock number');
      c.step('Change the shape to Oval');
      { const ov = page.locator('button.vdbrb_list_item_a_supported_shapes_option', { hasText: /^\s*Oval\s*$/ }).first(); await ov.click({ timeout: 8000 }).catch(() => ov.evaluate(b => (b as HTMLElement).click()).catch(() => {})); }
      const o = await changed(m); const s2 = await stock();
      c.check(s2 !== s1 && !o.equals(m), `Changing the shape to Oval does not update the model and stock number (${s1} → ${s2})`);
      c.note(`(The 3D model took about ${renderS} s to appear.)`);
      recordPerf(page, { kind: '3D model', url: page.url().replace(cfg.baseUrl, '/'), name: '3D Ring Builder – model drawn', ms: renderS * 1000 });
      c.actual = `3D model renders, rotates when dragged; stock ${s0} → ${s1} (metal) → ${s2} (Oval), model updated each time.`;
    }, [], 480_000);

    await suite.run('TC-20', page, async c => {
      // shoppers reach the configurable rings from the Fine Jewelry mega menu › "Configure Rings"
      await open(page, cfg, cfg.baseUrl, c, 'the homepage');
      const others = [
        ...(await headerLinks(page, cfg)).filter(l => /configure/i.test(l.label)).map(e => ({ ...e, where: 'menu' })),
        ...(await page.$$eval('#MainContent a[href]', as => as.filter(a => /configure/i.test(a.textContent ?? '')).map(a => ({ label: (a.textContent ?? '').replace(/\s+/g, ' ').trim(), href: (a as HTMLAnchorElement).href })))).map(e => ({ ...e, where: 'homepage' })),
      ];
      c.step('Hover "Fine Jewelry" in the menu');
      const fj = page.locator('header details > summary', { hasText: /fine jewel/i }).locator('visible=true').first();
      await must(fj.hover().then(() => page.waitForTimeout(800)), 'open the Fine Jewelry mega menu');
      const link = page.locator('header a', { hasText: /^\s*Configure Rings\s*$/i }).locator('visible=true').first();
      if (!(await link.count())) { await fj.click().catch(() => {}); await page.waitForTimeout(800); }
      if (!c.check(await link.count() > 0, 'The Fine Jewelry mega menu has no "Configure Rings" link')) return;
      const dest = new URL((await link.getAttribute('href')) ?? '/', cfg.baseUrl).pathname;
      const same = others.filter(e => new URL(e.href).pathname === dest && !/^configure rings$/i.test(e.label));
      if (same.length) c.note(`(${list(same.map(e => `${e.where} "${e.label}"`), 4)} open the same page.)`);
      // the products are drawn by the configurator app after the page loads: watch its product request
      let api = '';
      const onResp = (r: Response) => { if (/spjc|on-forge\.com\/api\/storefront\/products/.test(r.url()) && /products/.test(r.url())) api = `${r.status()} ${r.url().split('?')[0]}`; };
      page.on('response', onResp);
      c.step('Click "Configure Rings"');
      const t0 = Date.now();
      await Promise.all([page.waitForURL(u => u.pathname === dest, { timeout: 30_000 }).catch(() => {}), link.click()]);
      const label = `Fine Jewelry › Configure Rings (${dest})`;
      // wait up to 45 s where the products appear (no scrolling down to the footer)
      const first = await page.waitForFunction(() => (([...document.querySelectorAll('#MainContent a[href*="/products/"]')].find(a => (a as HTMLElement).offsetWidth > 0) as HTMLAnchorElement | undefined)?.href) || null, null, { timeout: 45_000 })
        .then(h => h.jsonValue() as Promise<string>).catch(() => undefined);
      page.off('response', onResp);
      recordPerf(page, { kind: 'Results shown', url: dest, name: `${label} – products on screen`, ms: Date.now() - t0, ok: !!first });
      if (!first) {
        await page.evaluate(() => window.scrollTo(0, 0));
        c.check(false, `${label} shows no products after 45 s (configurator product request: ${api || 'never sent'})`);
        return;
      }
      const count = await page.$$eval('#MainContent a[href*="/products/"]', as => new Set(as.filter(a => (a as HTMLElement).offsetWidth > 0).map(a => (a as HTMLAnchorElement).pathname)).size);
      c.note(`(${label}: ${count} products shown after ${Math.round((Date.now() - t0) / 100) / 10} s.)`);
      const out: string[] = [];
      {
        await open(page, cfg, first!, c, 'the first configurable product');
        await must(visible(page.locator('.vdb-spjc-config-panel__price'), 30_000), 'see the configurator (price panel)');
        await page.waitForTimeout(1500);
        const title = (await page.locator('.vdb-spjc-config-panel__title, #MainContent h1').first().innerText().catch(() => '')).trim();
        // tag every option by its section (Shape, Size, Metal Color, Head Metal Color, Shank Metal Color …):
        // each section is a .vdb-spjc-config-section with a label and swatch buttons named by title / aria-label
        const groups = await page.evaluate(() => {
          const out: Record<string, { i: number; text: string; active: boolean }[]> = {};
          document.querySelectorAll('.vdb-spjc-config-section').forEach(sec => {
            const lab = sec.querySelector('.vdb-spjc-config-section__label');
            const name = ((lab?.firstChild?.textContent ?? lab?.textContent ?? '').replace(/[:\s]+$/, '').trim()) || 'Option';
            if (/engrav/i.test(name)) return;
            const btns = ([...sec.querySelectorAll('button, [role="radio"], input[type="radio"] + label')] as HTMLElement[])
              .filter(b => !/nav|prev|next|share/i.test(b.className) && (b.getAttribute('title') || b.getAttribute('aria-label') || b.innerText.trim()));
            if (btns.length < 2) return;
            out[name] = btns.map((b, i) => { b.setAttribute('data-qa-opt', `${name}|${i}`); return { i, text: (b.getAttribute('title') || b.getAttribute('aria-label') || b.innerText).trim(), active: /active|selected|checked/i.test(b.className) || b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-checked') === 'true' }; });
          });
          return out;
        });
        const state = async () => ({
          price: money(await page.locator('.vdb-spjc-config-panel__price').first().innerText().catch(() => '')),
          stock: (await page.locator('.vdb-spjc-config-panel__stock').first().innerText().catch(() => '')).replace(/^Stock #\s*/i, '').trim() || (await mainText(page)).match(/Stock # (\S+)/)?.[1],
          img: await page.$$eval('#MainContent img', is => (is.filter(i => i.getBoundingClientRect().width > 200 && !/swatch/.test(i.className)).map(i => (i as HTMLImageElement).currentSrc || (i as HTMLImageElement).src)[0]) ?? ''),
        });
        const rows: string[] = [];
        const noStock: string[] = [], noImg: string[] = [];
        const samePrice: string[] = []; let metalTried = 0;
        const kindOf = (t: string) => (t.match(/\d+\s*K|platinum|silver/i)?.[0] ?? '').replace(/\s+/g, '').toLowerCase();
        const colourOf = (t: string) => (t.match(/white|yellow|rose|platinum|silver/i)?.[0] ?? '').toLowerCase();
        for (const [name, opts] of Object.entries(groups)) {
          let cur = opts.find(o => o.active) ?? opts[0];
          // metals: change to a different metal (e.g. 14K → 18K: stock and price change) and to another colour (picture and stock change)
          const targets = /metal/i.test(name)
            ? [{ o: opts.find(o => kindOf(o.text) && kindOf(o.text) !== kindOf(cur.text) && colourOf(o.text) === colourOf(cur.text)), why: 'metal' }, { o: undefined as typeof cur | undefined, why: 'colour' }]
            : [{ o: opts.find(o => o !== cur && o.text !== cur.text), why: 'option' }];
          for (const tg of targets) {
          const next = tg.why === 'colour' ? opts.find(o => colourOf(o.text) && colourOf(o.text) !== colourOf(cur.text)) : tg.o;
          if (!next) continue;
          const before = await state();
          c.step(`${name}: ${cur.text} → ${next.text}`);
          const optBtn = page.locator(`[data-qa-opt="${name}|${next.i}"]`);
          // options sit in a sliding row: if the shopper would have to slide to it, click it directly
          await optBtn.click({ timeout: 5000 }).catch(() => optBtn.evaluate(b => (b as HTMLElement).click()).catch(() => {}));
          let after = before;
          for (let k = 0; k < 8; k++) { await page.waitForTimeout(1000); after = await state(); if (after.stock !== before.stock && after.img !== before.img) break; }
          if (after.stock === before.stock) noStock.push(`${name} → ${next.text} (stays ${before.stock})`);
          if (after.img === before.img && tg.why !== 'metal' && !/size/i.test(name)) noImg.push(`${name} → ${next.text}`);
          // a different metal (14K → 18K, platinum) must change the price; a colour of the same gold may keep it
          if (tg.why === 'metal') { metalTried++; if (after.price === before.price) samePrice.push(`${name} ${cur.text} → ${next.text} (stays ${fmt$(after.price)})`); }
          rows.push(`${name} ${next.text}: stock ${before.stock} → ${after.stock}, price ${fmt$(before.price)} → ${fmt$(after.price)}, picture ${after.img !== before.img ? 'changed' : 'same'}`);
          cur = next;
          }
        }
        if (!rows.length) { c.blocked(`"${title}": no options to change were found`); return; }
        if (!Object.keys(groups).some(g => /size/i.test(g))) c.note(`("${title}" has no size option; options: ${Object.keys(groups).join(', ')}.)`);
        c.check(!noStock.length, `"${title}": the stock number does not change for ${list(noStock, 4)}`);
        c.check(!noImg.length, `"${title}": the picture does not change for ${list(noImg, 4)}`);
        if (metalTried) c.check(!samePrice.length, `"${title}": the price stays the same after changing to a different metal: ${list(samePrice, 3)}`);
        else if (Object.keys(groups).some(g => /metal/i.test(g))) c.note(`(Only one gold type is offered (no 14K/18K/platinum choice), so the price was not expected to change with the metal colour.)`);
        // 3D view for the chosen options
        const open3d = page.getByText(/Open 3D/i).locator('visible=true').first();
        if (await open3d.count()) {
          c.step('Click "Open 3D 360°"');
          const t3 = Date.now();
          await open3d.click().catch(() => {});
          const canvas = page.locator('canvas').locator('visible=true').first();
          let shot: Buffer = Buffer.alloc(0), tShot = Date.now();
          if (await canvas.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false)) {
            // no graphics card in the test browser: a picture of the 3D view takes ~25 s, so allow 45 s per picture
            while (shot.length < 8000 && Date.now() - t3 < 90_000) { await page.waitForTimeout(2500); tShot = Date.now(); shot = await canvas.screenshot({ timeout: 45_000 }).catch(() => Buffer.alloc(0)); }
          }
          const drawnMs = tShot - t3;
          recordPerf(page, { kind: '3D model', url: page.url().replace(cfg.baseUrl, '/'), name: `"${title}" – 3D view drawn`, ms: shot.length >= 8000 ? drawnMs : Date.now() - t3, ok: shot.length >= 8000 });
          c.check(shot.length >= 8000, `"${title}": the 3D view stays blank after 90 s`);
          rows.push(`3D view ${shot.length >= 8000 ? `shown (within ${Math.round(drawnMs / 1000)} s)` : 'blank'}`);
          await page.keyboard.press('Escape').catch(() => {});
        } else c.note(`("${title}" has no 3D button.)`);
        out.push(`${label} → "${title}": ${rows.join('; ')}`);
      }
      c.actual = out.join(' | ');
    }, [], 480_000);
    void dialogs;
  } finally { await ctx.close().catch(() => {}); }
}

/** TC-32: phone-size screen (390 px). */
export async function trackerMobile(browser: Browser, cfg: Config, suite: Suite) {
  const ctx = await journeyContext(browser, { ...cfg, viewport: 'mobile' });
  const page = await ctx.newPage();
  try {
    await suite.run('TC-32', page, async c => {
      const out: string[] = [];
      const fits = async (where: string) => { const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })); const ok = w.sw <= w.iw + 2; c.check(ok, `${where}: the page is wider than the phone screen (${w.sw} px vs ${w.iw} px), so it scrolls sideways`); return ok; };
      await open(page, cfg, cfg.baseUrl, c, 'the homepage on a 390 px phone screen');
      await fits('Homepage');
      c.step('Open the menu');
      await page.locator('summary.header__icon--menu, .header__icon--menu').first().click().catch(() => {});
      await page.waitForTimeout(1200);
      const menuLinks = await page.$$eval('.menu-drawer a[href], #menu-drawer a[href]', as => as.filter(a => (a as HTMLElement).offsetWidth > 0).length).catch(() => 0);
      c.check(menuLinks > 3, 'The phone menu does not open (no links shown)');
      out.push(`menu ${menuLinks} links`);
      const s = new DS(page, { ...cfg, viewport: 'mobile' });
      await s.open(c);
      const r = await s.search(c);
      c.check((r.total ?? 0) > 0 && (await s.cards()).length > 0, 'Diamond Search on a phone shows no results');
      await fits('Diamond Search');
      out.push(`Diamond Search ${nf(r.total)} results`);
      await open(page, cfg, 'products/14k-rose-gold-round-halo-engagement-ring-7', c, 'a product page');
      await fits('Product page');
      const add = page.locator('button[name="add"]').locator('visible=true').first();
      const ab = await add.boundingBox().catch(() => null);
      c.check(!!ab && ab.x >= 0 && ab.x + ab.width <= 392, 'Add to cart is not fully on screen on a phone');
      await add.click().catch(() => {});
      await page.waitForTimeout(2500);
      await open(page, cfg, 'cart', c, 'the cart');
      await fits('Cart');
      const lines = await page.locator('.cart-item').count();
      c.check(lines > 0, 'The cart is empty on a phone after Add to cart');
      out.push(`product added, cart shows ${lines} line${lines === 1 ? '' : 's'}`);
      c.actual = `On a 390 px screen: pages fit, ${out.join(', ')}.`;
    });
  } finally { await ctx.close().catch(() => {}); }
}

export const TRACKER_GROUPS = {
  home: ['TC-01', 'TC-02', 'TC-03', 'TC-31', 'TC-33'],
  shop: ['TC-04', 'TC-05', 'TC-21', 'TC-22', 'TC-23', 'TC-24', 'TC-25'],
  diamonds: ['TC-06', 'TC-07', 'TC-08', 'TC-09', 'TC-10', 'TC-11', 'TC-12'],
  stoneFirst: ['TC-13', 'TC-14', 'TC-17', 'TC-16'],
  settingFirst: ['TC-15', 'TC-18', 'TC-20'],
  mobile: ['TC-32'],
};
