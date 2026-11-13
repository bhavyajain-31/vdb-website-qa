// Phase 2 · Week 1 · Global search in the header (SR-01 … SR-07)
import type { Browser, Page } from 'playwright';
import type { Config } from '../config.js';
import { gotoSettled, settle } from '../browser.js';
import { Case, Suite, StepError, fmt$, isVisible, journeyContext, list, money, must, visible, watchDialogs } from './harness.js';

interface Product { title: string; price?: number; soldOut: boolean }

async function openSearch(page: Page, cfg: Config, c: Case, fresh = true) {
  if (fresh) {
    c.step('Open the homepage');
    const g = await gotoSettled(page, cfg.baseUrl, cfg);
    if (g.error || (g.status && g.status >= 400)) throw new StepError(`Could not open the homepage (${g.error ?? 'HTTP ' + g.status})`);
  }
  c.step('Click the search icon');
  await page.evaluate(() => { const s = document.querySelector('details-modal.header__search summary, .header__icon--search') as HTMLElement | null; s?.click(); });
  return must(visible(page.locator('input[type="search"][name="q"]'), 8000), 'open the search box from the search icon');
}

async function submitSearch(page: Page, cfg: Config, c: Case, term: string) {
  const input = await openSearch(page, cfg, c);
  c.step(`Type "${term}" and press Enter`);
  await input.fill(term);
  await Promise.all([page.waitForURL(/\/search\?/, { timeout: 20_000 }).catch(() => {}), input.press('Enter')]);
  await settle(page, 600);
}

async function products(page: Page): Promise<Product[]> {
  return page.$$eval('#product-grid > li, ul.product-grid > li', els => els.filter(e => (e as HTMLElement).offsetWidth > 0).map(e => {
    const sale = e.querySelector('.price--on-sale .price-item--sale');
    const reg = e.querySelector('.price__regular .price-item--regular, .price-item--regular');
    const priceText = (sale ?? reg)?.textContent ?? '';
    return {
      title: (e.querySelector('.card__heading a, .card__heading, h3')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      priceText,
      soldOut: /sold out/i.test(e.querySelector('.badge, .card__badge')?.textContent ?? ''),
    };
  })).then(xs => xs.map(x => ({ title: x.title, price: money(x.priceText), soldOut: x.soldOut })));
}

/** Waits for the results grid to refresh after a filter or sort change (the theme swaps the grid in place). */
async function afterChange(page: Page, urlPart: RegExp, what: string) {
  await page.waitForURL(urlPart, { timeout: 15_000 }).catch(() => { throw new StepError(`The page did not update after ${what}`); });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(900);
}

async function resultCount(page: Page): Promise<number | undefined> {
  const t = await page.locator('#ProductCountDesktop, .product-count__text').locator('visible=true').first().innerText().catch(() => '');
  const m = t.replace(/,/g, '').match(/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

async function openFacet(page: Page, name: string) {
  const sum = page.locator('facet-filters-form details > summary, #FacetFiltersForm details > summary').filter({ hasText: new RegExp(`^\\s*${name}`, 'i') }).locator('visible=true').first();
  if (!(await sum.count())) return null;
  const det = sum.locator('xpath=..');
  if (!(await det.evaluate(d => (d as HTMLDetailsElement).open))) { await sum.click(); await page.waitForTimeout(400); }
  return det;
}

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
      const sugg = await page.$$eval('#predictive-search-results-queries-list a, #predictive-search-results-queries-list li', es => es.map(e => (e as HTMLElement).innerText.trim()).filter(Boolean));
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
        c.check(!sold.length, `"In stock" still shows sold-out products: ${list(sold.map(x => x.title))}`);
        done.push(`In stock → ${(await resultCount(page)) ?? ps.length}`);
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
        const out = ps.filter(x => x.price != null && (x.price < 500 || x.price > 3000));
        c.check(!out.length, `${out.length} products are outside $500 – $3,000: ${list(out.map(x => `${x.title} ${fmt$(x.price)}`))}`);
        done.push(`$500–$3,000 → ${(await resultCount(page)) ?? ps.length}`);
      }

      // Metal Type: first option
      await page.goto(SEARCH); await settle(page, 600);
      const mt = await openFacet(page, 'Metal');
      if (c.check(!!mt, 'There is no Metal Type filter')) {
        const opt = mt!.locator('label').filter({ hasText: /\w/ }).first();
        const val = (await opt.innerText().catch(() => '')).replace(/\(\d+\)/, '').replace(/\s+/g, ' ').trim();
        c.step(`Metal Type: tick ${val}`);
        await must(opt.click({ timeout: 8000 }), `tick metal type "${val}"`);
        await afterChange(page, /filter\.p\.m\.custom\.metal_type=/, `ticking ${val}`);
        const after = await resultCount(page);
        const ps = await products(page);
        c.check(ps.length > 0, `Metal Type "${val}" shows no products`);
        if (base != null && after != null) c.check(after <= base, `Metal Type "${val}" shows more results (${after}) than without it (${base})`);
        done.push(`${val} → ${after ?? ps.length}`);
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

export const SEARCH_IDS = ['SR-01', 'SR-02', 'SR-03', 'SR-04', 'SR-05', 'SR-06', 'SR-07'];
