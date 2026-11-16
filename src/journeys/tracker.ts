// Daily monitoring tracker: TC-01 … TC-33 (TC-26, TC-29, TC-30 stay manual).
// Shopper flows end at the cart; checkout is never opened and nothing is ordered or submitted.
import type { Browser, Page, Response } from 'playwright';
import type { Config } from '../config.js';
import { gotoSettled, settle } from '../browser.js';
import { Case, Suite, StepError, fmt$, forgetFilters, isVisible, journeyContext, list, money, must, visible, watchDialogs } from './harness.js';
import { DS, isPage1 } from './diamond.js';
import { GS } from './gemstone.js';
import { afterChange, facetOptions, productData, products, resultCount, submitSearch, tickOption } from './search.js';
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

async function open(page: Page, cfg: Config, url: string, c?: Case, what = 'the page') {
  c?.step(`Open ${what}`);
  const g = await gotoSettled(page, url.startsWith('http') ? url : cfg.baseUrl + url, cfg);
  if (g.error || (g.status && g.status >= 400)) throw new StepError(`Could not open ${what} (${g.error ?? 'HTTP ' + g.status})`);
  return g;
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
  await open(page, cfg, url, c, what);
  const r = await wait;
  await page.waitForTimeout(1500);
  return { rows: await rbRows(r), req: r ? post(r) : '' };
}

const visibleLinks = (page: Page, part: string) => page.$$eval(`a[href*="${part}"]`, as => as.filter(a => (a as HTMLElement).offsetWidth > 0 && (a as HTMLElement).innerText.trim()).map(a => ({ href: (a as HTMLAnchorElement).href, text: (a as HTMLElement).innerText.split('\n')[0].trim() })));

interface Detail { stock?: string; title?: string; price?: number; shape?: string; shapes: string[] }
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
  return page.evaluate(async () => (await fetch('/cart.js')).json()).catch(() => null) as Promise<{ item_count: number; total_price: number; items: { title: string; sku: string; quantity: number; final_line_price: number; properties: Record<string, string> | null }[] } | null>;
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
  c.step(`Click "Select …" for ${stone.title ?? stones[0].text}`);
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
  const setting = await readDetail(page);
  if (stone.shape && setting.shapes.length) c.check(setting.shapes.some(s => sameShape(s, stone.shape)), `The setting offered (${setting.title}) does not support the ${stone.shape} stone (it supports ${setting.shapes.join(', ')})`);
  await chooseMetal(page, c);
  c.step('Choose ring size 7');
  await must(page.selectOption('#vdb-rb-ring-size-dropdown', '7'), 'choose a ring size');
  c.step('Click Select Setting');
  await must((await visible(page.locator('a.vdb-rc-setting-pdp__select-btn'))).click(), 'click "Select Setting"');
  await page.waitForURL(/rb-ring-review/, { timeout: 30_000 }).catch(() => { throw new StepError('Select Setting did not open the completed ring'); });
  await page.waitForTimeout(2500);
  return { stone, settingRows, setting: await readDetail(page).then(() => setting) };
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
async function checkReview(page: Page, c: Case, stoneStock?: string, settingStock?: string) {
  const t = await mainText(page);
  c.check(/Your Completed Ring/i.test(t), 'The "Your Completed Ring" summary is not shown');
  const stocks = [...t.matchAll(/Stock # (\S+)/g)].map(m => m[1]);
  if (stoneStock) c.check(stocks.includes(stoneStock), `The chosen stone ${stoneStock} is not in the completed ring`);
  if (settingStock) c.check(stocks.includes(settingStock), `The chosen setting ${settingStock} is not in the completed ring`);
  const prices = [...t.matchAll(/\$([\d,]+\.\d\d) (Stone|Setting) Price/g)].map(m => money(m[1])!);
  const sub = money(t.match(/Subtotal \$([\d,]+\.\d\d)/)?.[1]);
  if (prices.length === 2 && sub != null) c.check(Math.abs(prices[0] + prices[1] - sub) < 0.01, `Subtotal ${fmt$(sub)} is not stone + setting (${fmt$(prices[0])} + ${fmt$(prices[1])})`);
  const img = await page.locator('#MainContent img').evaluateAll(is => is.some(i => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0 && i.getBoundingClientRect().width > 120)).catch(() => false);
  c.check(img, 'No ring preview image is shown');
  return { stocks, prices, sub };
}

/** Add to Cart on the completed ring; checks both parts land in the cart, grouped, with the right total. */
async function ringToCart(page: Page, c: Case, sub?: number) {
  if (!(await page.locator('#vdb-rb-ring-size-dropdown').locator('visible=true').first().inputValue().catch(() => ''))) {
    c.step('Ring size empty on the summary: choose 7');
    await page.selectOption('#vdb-rb-ring-size-dropdown', '7').catch(() => {});
  }
  const stocks = [...(await mainText(page)).matchAll(/Stock # (\S+)/g)].map(m => m[1]);
  c.step('Click Add to Cart');
  await must((await visible(page.locator('button.vdb-rc-pdp-actions__primary-btn'))).click(), 'click "Add to Cart" on the completed ring');
  await page.waitForURL(/\/cart/, { timeout: 25_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const cart = await cartJson(page);
  if (!cart) throw new StepError('Could not read the cart');
  const lines = cart.items.filter(i => stocks.includes(lineStock(i) ?? ''));
  c.check(lines.length === stocks.length, `The cart has ${lines.length} of the ${stocks.length} ring parts (${stocks.join(', ')})`);
  const groups = new Set(lines.map(l => l.properties?.['_Order Group ID']).filter(Boolean));
  if (lines.length > 1) c.check(groups.size === 1, 'The stone and setting are not linked as one ring in the cart');
  const total = lines.reduce((s, l) => s + l.final_line_price, 0) / 100;
  if (sub != null) c.check(Math.abs(total - sub) < 0.01, `Cart total for the ring ${fmt$(total)} differs from the subtotal ${fmt$(sub)}`);
  const size = lines.map(l => l.properties?.['Ring Size']).find(Boolean);
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
            if (link) out.push({ menu, label: (link.textContent ?? '').replace(/\s+/g, ' ').trim(), href: link.href });
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
      await submitSearch(page, cfg, c, 'halo ring');
      const ps = await products(page);
      const count = await resultCount(page);
      if (!c.check(ps.length > 0, 'Searching "halo ring" shows no products')) return;
      const halo = ps.filter(p => /halo/i.test(p.title));
      c.check(/halo/i.test(ps[0].title), `The first result is not a halo ring ("${ps[0].title}")`);
      c.check(halo.length >= Math.ceil(ps.length / 2), `Only ${halo.length} of ${ps.length} results are halo rings`);
      const first = page.locator('#product-grid > li a[href*="/products/"], ul.product-grid > li a[href*="/products/"]').first();
      c.step(`Click "${ps[0].title}"`);
      await Promise.all([page.waitForURL(/\/products\//, { timeout: 20_000 }).catch(() => {}), first.click()]);
      await settle(page, 500);
      const h1 = (await page.locator('#MainContent h1').first().innerText().catch(() => '')).trim();
      c.check(/\/products\//.test(page.url()) && !!h1, 'Clicking a result does not open its product page');
      c.actual = `${count ?? ps.length} results, ${halo.length} of ${ps.length} shown are halo rings; clicking opens "${h1}".`;
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
        const ps = await products(page);
        if (!c.check(ps.length > 0, `${name} shows no products`)) continue;
        const imgs = await page.$$eval('#product-grid > li, ul.product-grid > li', ls => ls.filter(l => (l as HTMLElement).offsetWidth > 0).map(l => { const i = l.querySelector('img') as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth > 0; }));
        const noImg = imgs.filter(x => !x).length;
        const noPrice = ps.filter(p => !p.price);
        c.check(!noImg, `${name}: ${noImg} products have no image`);
        c.check(!noPrice.length, `${name}: ${noPrice.length} products have no price`);
        const data = await productData(page);
        const fromWrong = data.filter(d => { const card = ps.find(p => p.title === d.title); const lo = Math.min(...d.variants.map(v => v.price)); return card?.price != null && Math.abs(card.price - lo) > 0.01; });
        c.check(!fromWrong.length, `${name}: the "From" price is not the lowest option price for ${list(fromWrong.map(d => d.title))}`);
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
      if (!sold) { c.blocked('No wedding band is sold out right now, so the sold-out page could not be checked'); c.actual = `${ps.length} bands, none sold out.`; return; }
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
      } else if (errText) c.warn(`Only 1 in stock: the cart says "${errText}"`);
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
      c.check(await isVisible(page.locator('a.vdb-video_url_open, [class*=360], .vdb-image-cover')), 'No media (video / 360 / image)');
      c.check(/\$\s*[\d,]+\.\d\d/.test(t), 'No price');
      c.check(await isVisible(page.locator('button.vdb-addbutton')), 'No Add to cart button');
      const ring = await isVisible(page.getByText(/add to ring/i));
      c.actual = `"${card.name}": specs, certificate, media, price and Add to cart shown${ring ? ', plus Add to ring' : ' (no Add to ring button on this page)'}.`;
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
      const r = await checkReview(page, c, stone.stock, setting?.stock);
      review = { sub: r.sub };
      c.actual = `Stone ${stone.title} (${stone.stock}, ${fmt$(stone.price)}) + setting ${setting?.title} (${setting?.stock}, ${fmt$(setting?.price)}) → completed ring, subtotal ${fmt$(r.sub)}.`;
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
      c.step(`Pick setting "${settings[0].text}"`);
      await open(page, cfg, settings[0].href);
      const setting = await readDetail(page);
      await chooseMetal(page, c);
      c.step('Choose ring size 6');
      await must(page.selectOption('#vdb-rb-ring-size-dropdown', '6'), 'choose a ring size');
      const stoneWait = page.waitForResponse(isRbList('stone'), { timeout: 45_000 }).catch(() => null);
      c.step('Click Select Setting');
      await must((await visible(page.locator('a.vdb-rc-setting-pdp__select-btn'))).click(), 'click "Select Setting"');
      await page.waitForURL(/rb-stone-list|rb-ring-review/, { timeout: 30_000 }).catch(() => { throw new StepError('Select Setting did not move on to choosing a stone'); });
      const sr = await stoneWait;
      const stones = await rbRows(sr);
      await page.waitForTimeout(1500);
      const supported = setting.shapes.length ? setting.shapes : setting.shape ? [setting.shape] : [];
      const incompatible = stones.filter(r => supported.length && !supported.some(s => sameShape(s, r.shape)));
      c.check(!incompatible.length, `${incompatible.length} of ${stones.length} stones offered do not fit the setting (it takes ${supported.join(', ')}; offered e.g. ${incompatible[0]?.shape})`);
      const links = await visibleLinks(page, 'rb-stone-details');
      if (!links.length) { c.fail('No stones are offered for the chosen setting'); return; }
      c.step(`Pick "${links[0].text}"`);
      await open(page, cfg, links[0].href);
      const stone = await readDetail(page);
      c.step('Click Select …');
      await must((await visible(page.locator('a.vdb-rc-stone-pdp__select-btn'))).click(), 'click the stone\'s "Select" button');
      await page.waitForURL(/rb-ring-review/, { timeout: 30_000 }).catch(() => { throw new StepError('Selecting the stone did not open the completed ring'); });
      await page.waitForTimeout(2500);
      const r = await checkReview(page, c, stone.stock, setting.stock);
      const size = await page.locator('#vdb-rb-ring-size-dropdown').locator('visible=true').first().inputValue().catch(() => '');
      c.check(size === '6', `The ring size chosen (6) is not kept on the summary (shows "${size || 'none'}")`);
      const cartLine = await ringToCart(page, c, r.sub);
      c.actual = `Setting ${setting.title} (${setting.stock}) → ${stones.length} compatible stones offered → ${stone.title} → completed ring ${fmt$(r.sub)}. ${cartLine}`;
    });

    await suite.run('TC-18', page, async c => {
      await open(page, cfg, `${RB}rb-setting-details?in_journey=true&ring_stock_num=SG-SL1003-RD-14W-14W&ring_reference_id=240081`, c, '3D Ring Builder');
      const canvas = page.locator('#webgl_vdb_canvas, canvas').locator('visible=true').first();
      if (!c.check(await canvas.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false), 'The 3D viewer does not appear')) return;
      await page.waitForTimeout(6000);
      const shot = () => canvas.screenshot({ timeout: 10_000 }).catch(() => Buffer.alloc(0));
      const stock = async () => (await readDetail(page)).stock;
      const a = await shot();
      c.check(a.length > 6000, 'The 3D viewer is blank (nothing rendered)');
      c.step('Drag the model');
      const box = await canvas.boundingBox();
      if (box) { await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 15 }); await page.mouse.up(); }
      await page.waitForTimeout(1500);
      const b = await shot();
      c.check(!a.equals(b), 'Dragging does not rotate the model');
      const s0 = await stock();
      c.step('Change the metal');
      const metals = page.locator('button.vdbrb_list_item_a_metal_type_option').locator('visible=true');
      if (await metals.count() > 1) { await metals.nth(1).click(); await page.waitForTimeout(4000); }
      const s1 = await stock(); const m = await shot();
      c.check(s1 !== s0 || !m.equals(b), 'Changing the metal does not update the model or stock number');
      c.step('Change the shape to Oval');
      await page.locator('button.vdbrb_list_item_a_supported_shapes_option', { hasText: /^\s*Oval\s*$/ }).first().click().catch(() => {});
      await page.waitForTimeout(4000);
      const s2 = await stock(); const o = await shot();
      c.check(s2 !== s1 && !o.equals(m), `Changing the shape to Oval does not update the model and stock number (${s1} → ${s2})`);
      c.actual = `3D model renders, rotates when dragged; stock ${s0} → ${s1} (metal) → ${s2} (Oval), model updated each time.`;
    });

    await suite.run('TC-19', page, async c => {
      const places = [`${RB}rb-stone-list?diamond_type=natural&view_type=grid&color_type=White`, `${RB}rb-stone-list?diamond_type=labgrown&view_type=grid&color_type=White`, 'apps/vdb-app/search-filters?structure=new', ''];
      let found = '';
      for (const u of places) {
        await open(page, cfg, u || cfg.baseUrl, c, u ? u.split('?')[0].split('/').pop() : 'the homepage');
        await page.waitForTimeout(2500);
        if (await isVisible(page.getByText(/take our (diamond |ring )?quiz/i))) { found = u || '/'; break; }
      }
      if (!found) { c.blocked('The "Take our Quiz" button was not found on the stone lists, Diamond Search or the homepage (the label exists in the app but is not shown). Please tell us where it is.'); return; }
      c.step('Click Take our Quiz');
      await page.getByText(/take our (diamond |ring )?quiz/i).locator('visible=true').first().click();
      await page.waitForTimeout(1500);
      for (let step = 0; step < 6; step++) {
        const modal = page.locator('[class*=quiz]').locator('visible=true').last();
        const opt = modal.locator('button, label, li, a').filter({ hasNotText: /next|back|close|retake|skip|×/i }).locator('visible=true').first();
        if (!(await opt.count())) break;
        c.step(`Answer step ${step + 1}: ${(await opt.innerText().catch(() => '')).trim().slice(0, 30)}`);
        await opt.click().catch(() => {});
        await page.waitForTimeout(800);
        const next = modal.getByText(/^\s*(next|continue|show results|see results)\s*$/i).locator('visible=true').first();
        if (await next.count()) await next.click().catch(() => {});
        await page.waitForTimeout(1200);
        if (await isVisible(page.getByText(/best (diamonds|rings) for you|recommend/i))) break;
      }
      const res = await isVisible(page.getByText(/best (diamonds|rings) for you|recommend/i));
      c.check(res, 'Finishing the quiz does not show recommendations');
      c.actual = res ? `Quiz found on ${found}; recommendations shown after answering.` : '';
    });

    await suite.run('TC-20', page, async c => {
      const out: string[] = [];
      for (const [col, name] of [['collections/configure-diamond-rings', 'Configure Rings'], ['collections/configure-pendants', 'Configure Fine Jewelry (pendants)']]) {
        await open(page, cfg, col, c, name);
        const first = await page.$$eval('#product-grid > li a[href*="/products/"], ul.product-grid > li a[href*="/products/"], a[href*="/products/configure"]', as => (as.find(a => (a as HTMLElement).offsetWidth > 0) as HTMLAnchorElement | undefined)?.href);
        if (!c.check(!!first, `${name} shows no products`)) continue;
        await open(page, cfg, first!, c, `the first ${name} product`);
        await must(visible(page.locator('.vdb-spjc-config-panel__price'), 30_000), `see the price on the ${name} configurator`);
        await page.waitForTimeout(1500);
        const state = async () => ({ price: money(await page.locator('.vdb-spjc-config-panel__price').first().innerText().catch(() => '')), stock: (await mainText(page)).match(/Stock # (\S+)/)?.[1], img: await page.$$eval('#MainContent img', is => (is.filter(i => i.getBoundingClientRect().width > 200).map(i => (i as HTMLImageElement).currentSrc || (i as HTMLImageElement).src)[0]) ?? '') });
        const s0 = await state();
        const changes: string[] = [];
        let priceMoved = false, imgMoved = false;
        const swatches = page.locator('button.vdb-spjc-swatch-circle').locator('visible=true');
        const labels = await swatches.allInnerTexts();
        for (const want of ['Platinum', '18K Yellow Gold', 'Oval']) {
          const i = labels.findIndex(l => l.trim() === want);
          if (i < 0) continue;
          const before = await state();
          c.step(`Choose ${want}`);
          await swatches.nth(i).click().catch(() => {});
          await page.waitForTimeout(2500);
          const after = await state();
          if (after.price !== before.price) priceMoved = true;
          if (after.img !== before.img || after.stock !== before.stock) imgMoved = true;
          changes.push(`${want}: ${fmt$(before.price)} → ${fmt$(after.price)}, stock ${after.stock}`);
        }
        if (!changes.length) { c.blocked(`${name}: no options to change were found`); continue; }
        c.check(imgMoved, `${name}: the image and stock number do not change with the options`);
        c.check(priceMoved, `${name}: the price stays ${fmt$(s0.price)} after changing metal and shape`);
        out.push(`${name} (${changes.join('; ')})`);
      }
      c.actual = out.join(' | ');
    });
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
  settingFirst: ['TC-15', 'TC-18', 'TC-19', 'TC-20'],
  mobile: ['TC-32'],
};
