// Phase 2 · Week 1 · Global search in the header (SR-01 … SR-07)
import type { Browser, Page } from 'playwright';
import type { Config } from '../config.js';
import { gotoSettled, settle } from '../browser.js';
import { Case, Suite, StepError, fmt$, isVisible, journeyContext, list, money, must, visible, watchDialogs } from './harness.js';

export interface Product { title: string; price?: number; soldOut: boolean; href: string; handle: string; img: string; imgOk: boolean }

export async function openSearch(page: Page, cfg: Config, c: Case, fresh = true) {
  if (fresh) {
    c.step('Open the homepage');
    const g = await gotoSettled(page, cfg.baseUrl, cfg);
    if (g.error || (g.status && g.status >= 400)) throw new StepError(`Could not open the homepage (${g.error ?? 'HTTP ' + g.status})`);
  }
  c.step('Click the search icon');
  await page.evaluate(() => { const s = document.querySelector('details-modal.header__search summary, .header__icon--search') as HTMLElement | null; s?.click(); });
  return must(visible(page.locator('input[type="search"][name="q"]'), 8000), 'open the search box from the search icon');
}

export async function submitSearch(page: Page, cfg: Config, c: Case, term: string) {
  const input = await openSearch(page, cfg, c);
  c.step(`Type "${term}" and press Enter`);
  await input.fill(term);
  await Promise.all([page.waitForURL(/\/search\?/, { timeout: 20_000 }).catch(() => {}), input.press('Enter')]);
  await settle(page, 600);
}

/** Product cards on a search or collection page (testimonials and other blocks without a price are ignored). */
export async function products(page: Page): Promise<Product[]> {
  const raw = await page.evaluate(() => {
    const seen = new Set<string>();
    const out: { title: string; priceText: string; soldOut: boolean; href: string; img: string; imgOk: boolean }[] = [];
    for (const a of document.querySelectorAll('#MainContent a[href*="/products/"]')) {
      const card = a.closest('.card-wrapper, #product-grid > li, .product-grid > li, .grid__item') as HTMLElement | null;
      if (!card || !card.offsetWidth || !card.querySelector('.price')) continue;
      const href = (a as HTMLAnchorElement).href.split('?')[0];
      if (seen.has(href)) continue;
      seen.add(href);
      const priceBox = card.querySelector('.price') as HTMLElement;
      const sale = priceBox.classList.contains('price--on-sale') ? priceBox.querySelector('.price-item--sale') : null;
      const reg = priceBox.querySelector('.price__regular .price-item--regular, .price-item--regular');
      const im = card.querySelector('img') as HTMLImageElement | null;
      out.push({
        title: (card.querySelector('.card__heading a, .card__heading, h3')?.textContent ?? a.textContent ?? '').replace(/\s+/g, ' ').trim(),
        priceText: (sale ?? reg)?.textContent ?? '',
        soldOut: /sold out/i.test(card.querySelector('.badge, .card__badge')?.textContent ?? ''),
        href, img: im ? (im.currentSrc || im.src) : '', imgOk: !!im && im.complete && im.naturalWidth > 0,
      });
    }
    return out;
  });
  return raw.map(x => ({ title: x.title, price: money(x.priceText), soldOut: x.soldOut, href: x.href, handle: x.href.match(/\/products\/([^/?#]+)/)?.[1] ?? '', img: x.img, imgOk: x.imgOk }));
}

/** Scrolls the page so lazy images load, then waits a moment. */
export async function loadAllImages(page: Page) {
  await page.evaluate(async () => {
    document.querySelectorAll('img[loading="lazy"]').forEach(i => i.setAttribute('loading', 'eager'));
    for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 100)); }
    window.scrollTo(0, 0);
  });
  await page.waitForFunction(() => [...document.querySelectorAll('#MainContent img')].every(i => (i as HTMLImageElement).complete), null, { timeout: 15_000 }).catch(() => {});
}

/** Waits for the results grid to refresh after a filter or sort change (the theme swaps the grid in place). */
export async function afterChange(page: Page, urlPart: RegExp, what: string) {
  await page.waitForURL(urlPart, { timeout: 15_000 }).catch(() => { throw new StepError(`The page did not update after ${what}`); });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(900);
}

export async function resultCount(page: Page): Promise<number | undefined> {
  const t = await page.locator('#ProductCountDesktop, .product-count__text').locator('visible=true').first().innerText().catch(() => '');
  const m = t.replace(/,/g, '').match(/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

export async function openFacet(page: Page, name: string) {
  const sum = page.locator('facet-filters-form details > summary, #FacetFiltersForm details > summary').filter({ hasText: new RegExp(`^\\s*${name}`, 'i') }).locator('visible=true').first();
  if (!(await sum.count())) return null;
  const det = sum.locator('xpath=..');
  if (!(await det.evaluate(d => (d as HTMLDetailsElement).open))) { await sum.click(); await page.waitForTimeout(400); }
  return det;
}


export interface ProductData { handle: string; title: string; available: boolean; options: string[]; images: string[]; variants: { title: string; available: boolean; price: number; options: string[] }[] }

/** The products behind the result cards, read from the store (the same data the product page shows). */
export async function productData(page: Page): Promise<ProductData[]> {
  const handles = [...new Set((await products(page)).map(p => p.handle).filter(Boolean))];
  return page.evaluate(async handles => {
    const out = await Promise.all(handles.map(async h => {
      try {
        const j = await (await fetch(`/products/${h}.js`)).json();
        return { handle: h, title: j.title, available: !!j.available, options: (j.options ?? []).map((o: any) => typeof o === 'string' ? o : o.name),
          images: (j.images ?? []) as string[],
          variants: (j.variants ?? []).map((v: any) => ({ title: v.title, available: !!v.available, price: v.price / 100, options: v.options ?? [v.option1, v.option2, v.option3].filter(Boolean) })) };
      } catch { return null; }
    }));
    return out.filter(Boolean) as any;
  }, handles);
}

/** Does the product really come in this metal? (a variant whose "Metal …" option is that value) */
export function hasMetal(p: ProductData, metal: string): boolean {
  const i = p.options.findIndex(o => /metal/i.test(o));
  const want = metal.trim().toLowerCase();
  if (i >= 0) return p.variants.some(v => (v.options[i] ?? '').trim().toLowerCase() === want);
  return p.variants.some(v => v.title.toLowerCase().includes(want)) || p.title.toLowerCase().includes(want);
}

/** Opens one product like a shopper and confirms the metal is offered on its page. */
export async function metalOnProductPage(page: Page, cfg: Config, c: Case, p: ProductData, metal: string): Promise<boolean> {
  c.step(`Open "${p.title}" and look for ${metal} on the page`);
  const g = await gotoSettled(page, cfg.baseUrl + 'products/' + p.handle, cfg);
  if (g.error || (g.status && g.status >= 400)) { c.fail(`"${p.title}" does not open (${g.error ?? 'HTTP ' + g.status})`); return false; }
  const text = (await page.locator('main').innerText().catch(() => '')).toLowerCase();
  const opts = (await page.$$eval('variant-selects input, variant-radios input, variant-selects option, variant-radios option, select[name^="options"] option, fieldset input[type="radio"]', es => es.map(e => (e as HTMLInputElement).value || (e as HTMLElement).textContent || '')).catch(() => [] as string[])).map(x => x.trim().toLowerCase());
  return opts.includes(metal.toLowerCase()) || text.includes(metal.toLowerCase());
}

/** Ticks one option of a filter on the search results page; returns the option's value. */
export async function tickOption(page: Page, facet: string, option: string | number, urlRe: RegExp): Promise<string> {
  const det = await openFacet(page, facet);
  if (!det) throw new StepError(`There is no ${facet} filter`);
  const labels = det.locator('label').filter({ has: page.locator('input[type="checkbox"]') });
  const opt = typeof option === 'number' ? labels.nth(option) : labels.filter({ has: page.locator(`input[value="${option.replace(/"/g, '\\"')}"]`) }).first();
  const val = (await opt.locator('input[type="checkbox"]').getAttribute('value').catch(() => null)) ?? String(option);
  await must(opt.click({ timeout: 8000 }), `tick "${val}" under ${facet}`);
  await afterChange(page, urlRe, `ticking ${val}`);
  return val;
}

export async function facetOptions(page: Page, facet: string): Promise<string[]> {
  const det = await openFacet(page, facet);
  if (!det) return [];
  return det.locator('input[type="checkbox"]').evaluateAll(es => es.map(e => (e as HTMLInputElement).value).filter(Boolean));
}

const METAL_URL = /filter\.(p\.m\.custom\.metal_type|v\.option\.metal[^=]*)=/i;

export async function searchGroup(browser: Browser, cfg: Config, suite: Suite) {
  const ctx = await journeyContext(browser, cfg);
  const page = await ctx.newPage();
  const dialogs = watchDialogs(page);
  const SEARCH = cfg.baseUrl + 'search?q=halo&options%5Bprefix%5D=last';
  try {
    await suite.run('SR-01', page, async c => {
      const input = await openSearch(page, cfg, c);
      c.step('Type "halo" without pressing Enter');
      await input.pressSequentially('halo', { delay: 60 });
      const panel = page.locator('#predictive-search-results, predictive-search [id^="predictive-search-results"]');
      const shown = await visible(panel, 10_000).then(() => true).catch(() => false);
      if (!c.check(shown, 'No suggestions panel appears while typing "halo"')) return;
      await page.waitForTimeout(800);
      const sugg = await page.$$eval('#predictive-search-results-queries-list li', es => es.map(e => (e as HTMLElement).innerText.trim()).filter(Boolean));
      const prods = await page.$$eval('#predictive-search-results-products-list li', es => es.map(e => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()).filter(Boolean));
      c.check(sugg.length > 0, 'The panel has no SUGGESTIONS');
      c.check(prods.length > 0, 'The panel has no PRODUCTS');
      const first = page.locator('#predictive-search-results-queries-list a, #predictive-search-results-products-list a').locator('visible=true').first();
      const label = (await first.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      c.step(`Click "${label}"`);
      await Promise.all([page.waitForURL(u => !/\/(\?|$)/.test(u.pathname + u.search) || /collections|products|search/.test(u.pathname), { timeout: 20_000 }).catch(() => {}), first.click()]);
      await settle(page, 600);
      const path = new URL(page.url()).pathname;
      const content = await page.locator('main').innerText().catch(() => '');
      c.check(/\/(collections|products|search)/.test(path), `Clicking "${label}" did not open it (still on ${path})`);
      c.check(content.trim().length > 50, `"${label}" opened an empty page`);
      c.actual = `Panel shows SUGGESTIONS (${list(sugg, 3)}) and ${prods.length} PRODUCTS; clicking "${label}" opens ${path}.`;
    });

    await suite.run('SR-02', page, async c => {
      await submitSearch(page, cfg, c, 'halo');
      c.check(/\/search\?/.test(page.url()) && new URL(page.url()).searchParams.get('q') === 'halo', 'Pressing Enter did not open the search results page for "halo"');
      const ps = await products(page);
      const count = await resultCount(page);
      c.check(ps.length > 0, 'No product cards on the search results page');
      const noPrice = ps.filter(x => !x.price);
      c.check(!noPrice.length, `${noPrice.length} product cards have no price: ${list(noPrice.map(x => x.title))}`);
      c.actual = `Search results page: ${count ?? ps.length} results, ${ps.length} cards on the first page, all with prices (e.g. ${ps[0]?.title}, ${fmt$(ps[0]?.price)}).`;
    });

    await suite.run('SR-03', page, async c => {
      const done: string[] = [];
      const names = await (async () => { await page.goto(SEARCH); await settle(page, 600); return page.$$eval('facet-filters-form details > summary, #FacetFiltersForm details > summary', es => [...new Set(es.filter(e => (e as HTMLElement).offsetWidth > 0).map(e => (e as HTMLElement).innerText.split('\n')[0].trim()))]); })();
      c.step(`Filters offered: ${names.join(', ')}`);
      const base = await resultCount(page);

      // Availability: In stock
      const av = await openFacet(page, 'Availability');
      if (c.check(!!av, 'There is no Availability filter')) {
        c.step('Availability: tick In stock');
        const lab = av!.locator('label', { hasText: /in stock/i }).first();
        await must(lab.click({ timeout: 8000 }), 'tick "In stock"');
        await afterChange(page, /filter\.v\.availability=1/, 'ticking In stock');
        const ps = await products(page);
        const sold = ps.filter(x => x.soldOut);
        c.check(!sold.length, `"In stock" still shows products marked Sold out: ${list(sold.map(x => x.title))}`);
        const data = await productData(page);
        const none = data.filter(p => !p.available);
        c.check(!none.length, `"In stock" shows products that cannot be bought (no variant in stock): ${list(none.map(p => p.title))}`);
        done.push(`In stock → ${(await resultCount(page)) ?? ps.length} (all ${data.length} products checked have stock)`);
      }

      // Price range
      await page.goto(SEARCH); await settle(page, 600);
      const pr = await openFacet(page, 'Price');
      if (c.check(!!pr, 'There is no Price filter')) {
        c.step('Price: $500 to $3,000');
        const lo = pr!.locator('input[name="filter.v.price.gte"]').first(), hi = pr!.locator('input[name="filter.v.price.lte"]').first();
        await must(lo.fill('500'), 'type a minimum price'); await lo.dispatchEvent('input');
        await must(hi.fill('3000'), 'type a maximum price'); await hi.dispatchEvent('input');
        await afterChange(page, /filter\.v\.price\.lte=3000/, 'entering a price range');
        const ps = await products(page);
        const data = await productData(page);
        const out = data.filter(p => !p.variants.some(v => v.price >= 500 && v.price <= 3000));
        c.check(!out.length, `${out.length} products have no option priced $500 – $3,000: ${list(out.map(p => `${p.title} (${fmt$(Math.min(...p.variants.map(v => v.price)))}–${fmt$(Math.max(...p.variants.map(v => v.price)))})`))}`);
        done.push(`$500–$3,000 → ${(await resultCount(page)) ?? ps.length} (all ${data.length} products have an option in range)`);
      }

      // Metal Type: first option
      await page.goto(SEARCH); await settle(page, 600);
      const mt = await openFacet(page, 'Metal');
      if (c.check(!!mt, 'There is no Metal Type filter')) {
        c.step('Metal Type: tick the first option');
        const val = await tickOption(page, 'Metal', 0, METAL_URL);
        const after = await resultCount(page);
        const data = await productData(page);
        c.check(data.length > 0, `Metal Type "${val}" shows no products`);
        if (base != null && after != null) c.check(after <= base, `Metal Type "${val}" shows more results (${after}) than without it (${base})`);
        const wrong = data.filter(p => !hasMetal(p, val));
        c.check(!wrong.length, `${wrong.length} of ${data.length} products shown are not available in ${val}: ${list(wrong.map(p => p.title))}`);
        if (data[0]) c.check(await metalOnProductPage(page, cfg, c, data[0], val), `"${data[0].title}" does not offer ${val} on its product page`);
        done.push(`${val} → ${after ?? data.length} (all ${data.length - wrong.length} products come in ${val}; "${data[0]?.title}" opened and shows ${val})`);
      }
      if (!names.some(nm => /categor|product type/i.test(nm))) c.warn('There is no Category filter on the search results page, so it was not tested');
      c.actual = `Without filters ${base ?? '?'} results. ${done.join('; ')}. Each list updated and matched its filter.`;
    });

    await suite.run('SR-04', page, async c => {
      await page.goto(SEARCH); await settle(page, 600);
      const sel = page.locator('select[name="sort_by"]').locator('visible=true').first();
      if (!c.check((await sel.count()) > 0, 'There is no Sort menu on the search results page')) return;
      const out: string[] = [];
      for (const [v, label, cmp] of [['price-ascending', 'Price, low to high', (a: number, b: number) => a <= b], ['price-descending', 'Price, high to low', (a: number, b: number) => a >= b], ['relevance', 'Relevance', null]] as const) {
        c.step(`Sort by ${label}`);
        await must(sel.selectOption(v), `choose "${label}"`);
        await afterChange(page, new RegExp(`sort_by=${v}`), `sorting by ${label}`);
        const ps = (await products(page)).filter(x => x.price != null);
        if (!ps.length) { c.blocked(`No products after sorting by ${label}`); continue; }
        if (cmp) {
          const bad = ps.findIndex((x, i) => i > 0 && !cmp(ps[i - 1].price!, x.price!));
          c.check(bad < 0, `"${label}" is out of order: ${ps[bad - 1]?.title} (${fmt$(ps[bad - 1]?.price)}) comes before ${ps[bad]?.title} (${fmt$(ps[bad]?.price)})`);
          out.push(`${label}: ${fmt$(ps[0].price)} … ${fmt$(ps[ps.length - 1].price)}`);
        } else out.push(`${label}: ${ps.length} products`);
      }
      c.actual = out.join('; ') + '.';
    });

    await suite.run('SR-05', page, async c => {
      await submitSearch(page, cfg, c, 'xyz123qq');
      const ps = await products(page);
      const text = await page.locator('main').innerText();
      const msg = text.match(/No results found for[^\n]*(\n[^\n]*)?/i)?.[0].replace(/\s+/g, ' ').trim();
      c.check(ps.length === 0, `A word that matches nothing shows ${ps.length} product${ps.length > 1 ? 's' : ''}: ${list(ps.map(x => x.title))}`);
      c.check(!!msg, 'No "No results found" message is shown');
      c.actual = msg ? `Shows: ${msg}` : '';
    });

    await suite.run('SR-06', page, async c => {
      const out: string[] = [];
      for (const term of ['<script>', '@#$%']) {
        const nd = dialogs.length;
        await submitSearch(page, cfg, c, term);
        const st = await page.evaluate(() => document.title);
        c.check(dialogs.length === nd, `Searching "${term}" made a pop-up appear ("${dialogs[dialogs.length - 1]}")`);
        c.check(!/error|exception|liquid/i.test(st) && !(await page.locator('text=/Liquid error|Internal Server Error/i').count()), `Searching "${term}" shows an error page`);
        const typed = await page.locator('input[name="q"]').evaluateAll((es, t) => es.some(e => (e as HTMLInputElement).value === t), term);
        const shown = (await page.locator('main').innerText()).includes(term);
        c.check(typed || shown, `The search for "${term}" does not show the text as typed`);
        out.push(`"${term}": no pop-up or error, shown as typed`);
      }
      c.actual = out.join('; ') + '.';
    });

    await suite.run('SR-07', page, async c => {
      const input = await openSearch(page, cfg, c);
      void input;
      c.step('Click Close');
      await must((await visible(page.locator('.search-modal__close-button'))).click(), 'click "Close" on the search panel');
      await page.waitForTimeout(700);
      const still = await isVisible(page.locator('.search-modal input[name="q"]'));
      c.check(!still, 'The search panel stays open after clicking Close');
      c.actual = 'Search panel opens and closes.';
    });
  } finally { await ctx.close().catch(() => {}); }
}

/** Filter results on the search page: every Metal Type option (+ in stock / out of stock), each product checked. */
export async function searchFilterChecks(browser: Browser, cfg: Config, suite: Suite) {
  const ctx = await journeyContext(browser, cfg);
  const page = await ctx.newPage();
  const SEARCH = cfg.baseUrl + 'search?q=halo&options%5Bprefix%5D=last';
  const area = 'Global search · filter results';
  try {
    await page.goto(SEARCH); await settle(page, 600);
    const base = await resultCount(page);
    const metals = await facetOptions(page, 'Metal');
    const avail = await facetOptions(page, 'Availability');
    let i = 0;
    for (const m of metals) {
      const id = suite.define({ id: `SRF-${String(++i).padStart(2, '0')}`, area, title: `Metal Type ${m}`, expected: `Every product shown is available in ${m} (checked in each product's options, and on the first product's page)`, priority: 'P1' });
      await suite.run(id, page, async c => {
        c.step('Search "halo"');
        await page.goto(SEARCH); await settle(page, 600);
        c.step(`Tick Metal Type ${m}`);
        await tickOption(page, 'Metal', m, METAL_URL);
        const after = await resultCount(page);
        const data = await productData(page);
        if (!data.length) { c.blocked(`No products in ${m}, so there was nothing to check`); c.actual = '0 results.'; return; }
        if (base != null && after != null) c.check(after <= base, `${m} shows more results (${after}) than without the filter (${base})`);
        const wrong = data.filter(p => !hasMetal(p, m));
        c.check(!wrong.length, `${wrong.length} of ${data.length} products shown are not available in ${m}: ${list(wrong.map(p => p.title))}`);
        const pick = data.find(p => hasMetal(p, m)) ?? data[0];
        const onPage = await metalOnProductPage(page, cfg, c, pick, m);
        c.check(onPage, `"${pick.title}" does not show ${m} on its product page`);
        c.actual = `${after ?? data.length} results; ${data.length - wrong.length} of ${data.length} products come in ${m}${onPage ? `; "${pick.title}" opened and offers ${m}` : ''}.`;
      });
    }
    for (const a of avail) {
      const label = a === '1' ? 'In stock' : a === '0' ? 'Out of stock' : a;
      const id = suite.define({ id: `SRF-${String(++i).padStart(2, '0')}`, area, title: `Availability ${label}`, expected: label === 'In stock' ? 'Every product shown can be bought (at least one option in stock)' : 'Every product shown has at least one option out of stock', priority: 'P2' });
      await suite.run(id, page, async c => {
        await page.goto(SEARCH); await settle(page, 600);
        c.step(`Tick Availability ${label}`);
        await tickOption(page, 'Availability', a, new RegExp(`filter\\.v\\.availability=${a}`));
        const data = await productData(page);
        if (!data.length) { c.blocked(`No products are ${label.toLowerCase()}, so there was nothing to check`); c.actual = '0 results.'; return; }
        const wrong = label === 'In stock' ? data.filter(p => !p.available) : data.filter(p => p.variants.every(v => v.available));
        c.check(!wrong.length, `${wrong.length} of ${data.length} products do not match "${label}": ${list(wrong.map(p => p.title))}`);
        c.actual = `${data.length - wrong.length} of ${data.length} products match "${label}".`;
      });
    }
  } finally { await ctx.close().catch(() => {}); }
}

export const SEARCH_IDS = ['SR-01', 'SR-02', 'SR-03', 'SR-04', 'SR-05', 'SR-06', 'SR-07'];
