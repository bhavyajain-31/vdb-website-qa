// Phase 2 · Week 1 · Gemstone Search (GS-01 … GS-11)
import type { Browser, Page, Response } from 'playwright';
import type { Config } from '../config.js';
import { gotoSettled } from '../browser.js';
import { Case, Suite, StepError, during, fmt$, isVisible, journeyContext, list, money, must, visible, watchDialogs } from './harness.js';

const GS_PATH = (gem: string) => `apps/vdb-app/gemstone?&gem_type=${gem}`;

interface Gem {
  id: number; stock_num: string; gem_type: string; shape: string; color: string; size: string; total_sales_price: string;
  lab: string | null; treatment: string | null; meas_ratio: string | null; pair: unknown; is_linked_pair_parent: unknown;
}
interface Card { id: string; name: string; price?: number }

const post = (r: Response) => r.request().postData() ?? '';
const isList = (r: Response) => /gemstone\.php/.test(r.url()) && /action=get_gemstone_list/.test(post(r)) && !/only_count_fetch/.test(post(r));
const isPage1 = (r: Response) => isList(r) && /[&]page_number=1(&|$)/.test(post(r));

async function gemsOf(r: Response): Promise<Gem[]> {
  try { const j = await r.json(); const m = typeof j.main_data === 'string' ? JSON.parse(j.main_data) : j.main_data; return m?.response?.body?.gemstones ?? []; } catch { return []; }
}

class GS {
  byId = new Map<string, Gem>();
  dialogs: string[];
  lastReq = '';
  constructor(public page: Page, public cfg: Config) {
    this.dialogs = watchDialogs(page);
    page.on('response', async r => { if (isList(r) && r.ok()) for (const g of await gemsOf(r)) this.byId.set(String(g.id), g); });
  }

  async open(c: Case | undefined, gem = 'Ruby') {
    c?.step(`Open GEMSTONES › ${gem}`);
    const listWait = this.page.waitForResponse(isPage1, { timeout: 45_000 }).catch(() => null);
    const g = await gotoSettled(this.page, this.cfg.baseUrl + GS_PATH(gem), this.cfg);
    if (g.error || (g.status && g.status >= 400)) throw new StepError(`Could not open Gemstone Search (${g.error ?? 'HTTP ' + g.status})`);
    const r = await listWait;
    if (r) this.lastReq = post(r);
    await this.waitCount('opening the page');
    await this.page.waitForTimeout(800);
  }

  async waitCount(what: string) {
    await this.page.waitForFunction(() => [...document.querySelectorAll('.vdbgs_search_diamond_count')].some(e => (e as HTMLElement).offsetParent && /\d/.test((e as HTMLElement).innerText)), null, { timeout: 30_000 })
      .catch(() => { throw new StepError(`Results did not appear after ${what}`); });
  }

  /** Runs a filter action and waits for the list the store sends back (the page updates by itself, no Search button). */
  async apply(c: Case, what: string, action: () => Promise<unknown>, expect?: RegExp): Promise<Gem[]> {
    c.step(what);
    const r = await during(this.page, x => isPage1(x) && (!expect || expect.test(post(x))), action, what.toLowerCase());
    this.lastReq = post(r);
    await this.page.waitForTimeout(900);
    await this.waitCount(what.toLowerCase());
    return gemsOf(r);
  }

  async count(): Promise<number | undefined> {
    const t = await this.page.locator('.vdbgs_search_diamond_count').locator('visible=true').first().innerText().catch(() => '');
    const m = t.replace(/,/g, '').match(/(\d+)/);
    return m ? Number(m[1]) : undefined;
  }

  async cards(): Promise<Card[]> {
    const raw = await this.page.$$eval('.vdbgs-get_show_pro_data', els => els.filter(e => (e as HTMLElement).offsetWidth > 0).map(e => ({
      id: e.getAttribute('data-prids') ?? '',
      name: (e.querySelector('.vdb-gem-product-title-and-price p')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      price: (e.querySelector('.vdb-gem-product-title-and-price h3')?.textContent ?? '').trim(),
    })));
    return raw.map(x => ({ ...x, price: money(x.price) }));
  }

  /** Opens a sidebar section (Shape, Carat, …) and returns its content. */
  async section(name: string) {
    const head = this.page.locator('.vdb-gem-type-header', { hasText: name }).locator('visible=true').first();
    await must(head.waitFor({ state: 'visible', timeout: 10_000 }), `find the "${name}" filter`);
    const body = head.locator('xpath=following-sibling::*[1]');
    if (!(await body.isVisible().catch(() => false))) { await head.click(); await this.page.waitForTimeout(500); }
    return body;
  }

  async tick(section: string, option: string) {
    const body = await this.section(section);
    const li = body.locator('li', { hasText: new RegExp(`^\\s*${option}\\s*$`) }).first();
    await must(li.locator('label').click({ timeout: 10_000 }), `tick ${option} under ${section}`);
  }

  async type(section: string, cls: string, v: string) {
    await this.section(section);
    const i = await must(visible(this.page.locator('input.' + cls)), `find the ${section} box`);
    await i.fill(v); await i.press('Tab');
  }
}

const n = (x: number | undefined) => x == null ? 'an unknown number of' : x.toLocaleString('en-US');

function every(c: Case, s: GS, cards: Card[], ok: (k: Card, g?: Gem) => boolean, what: string) {
  const bad = cards.filter(k => !ok(k, s.byId.get(k.id)));
  c.check(!bad.length, `${bad.length} of ${cards.length} gemstones shown ${what}: ${list(bad.map(b => b.name))}`);
  return cards.length - bad.length;
}

/** Ruby list: loads, collapse panel, infinite scroll, detail panel, add to cart. */
export async function gemstoneListGroup(browser: Browser, cfg: Config, suite: Suite) {
  const ctx = await journeyContext(browser, cfg);
  const page = await ctx.newPage();
  const s = new GS(page, cfg);
  try {
    await suite.run('GS-01', page, async c => {
      await s.open(c, 'Ruby');
      c.check(await isVisible(page.getByText('Gemstone Search', { exact: true })), 'The heading "Gemstone Search" is missing');
      const total = await s.count();
      c.check((total ?? 0) > 0, 'Ruby shows 0 results');
      const cards = await s.cards();
      c.check(cards.length > 0, 'No gemstone cards are shown');
      const bad = cards.filter(k => !/\b\d+(\.\d+)?\s*ct\b/i.test(k.name) || !/ruby/i.test(k.name) || !k.price);
      c.check(!bad.length, `${bad.length} cards are missing shape, colour, type, carat or price: ${list(bad.map(b => b.name || b.id))}`);
      c.actual = `"Gemstone Search" with ${n(total)} results; cards show shape, colour, type, carat and price (e.g. ${cards[0]?.name}, ${fmt$(cards[0]?.price)}).`;
    });

    await suite.run('GS-11', page, async c => {
      const head = page.getByText('Search Options', { exact: true }).locator('visible=true').first();
      await must(head.waitFor({ timeout: 10_000 }), 'find the "Search Options" header');
      const type = page.locator('.vdb-gem-type-header', { hasText: 'Type' });
      const open0 = await isVisible(type);
      c.step('Click the Search Options header');
      await head.click(); await page.waitForTimeout(900);
      const open1 = await isVisible(type);
      c.step('Click it again');
      await head.click(); await page.waitForTimeout(900);
      const open2 = await isVisible(type);
      c.check(open0 !== open1, 'Clicking "Search Options" does not collapse the filter panel');
      c.check(open2 === open0, 'Clicking "Search Options" again does not bring the filter panel back');
      c.actual = open0 !== open1 && open2 === open0 ? 'The filter panel collapses and expands.' : '';
    }, ['GS-01']);

    await suite.run('GS-07', page, async c => {
      const total = await s.count();
      let cards = await s.cards();
      const counts = [cards.length];
      for (let i = 0; i < 4; i++) {
        c.step('Scroll to the end of the results');
        const before = cards.length;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight - 1500));
        await page.waitForFunction(b => [...document.querySelectorAll('.vdbgs-get_show_pro_data')].filter(e => (e as HTMLElement).offsetWidth > 0).length > b, before, { timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(1200);
        cards = await s.cards();
        counts.push(cards.length);
        if (counts[counts.length - 1] === counts[counts.length - 2] && i > 0) break;
      }
      const ids = cards.map(k => k.id);
      const unique = new Set(ids).size;
      c.check(unique === ids.length, `Scrolling keeps loading the same gemstones again: ${ids.length} cards but only ${unique} different stones (cards: ${counts.join(' → ')})`);
      if (total != null) c.check(unique === total, `${unique} different gemstones could be reached by scrolling, but the page says ${n(total)} results`);
      c.check(ids.length <= (total ?? Infinity), `More cards (${ids.length}) than results (${n(total)})`);
      c.actual = `Cards: ${counts.join(' → ')} as you scroll; ${unique} different stones for "${n(total)} Results".`;
      await page.evaluate(() => window.scrollTo(0, 0));
    }, ['GS-01']);

    let card: Card | undefined;
    await suite.run('GS-09', page, async c => {
      await s.open(c, 'Ruby');
      card = (await s.cards())[0];
      if (!card) { c.blocked('No gemstone cards to open'); return; }
      c.step(`Open "${card.name}"`);
      await must(page.locator(`.vdbgs-get_show_pro_data[data-prids="${card.id}"] .vdb-gem-product-img-link`).first().click({ timeout: 10_000 }), `open "${card.name}"`);
      await must(visible(page.locator('#vdbgs_back_to_search_a'), 20_000), 'see the gemstone detail panel');
      await page.waitForTimeout(800);
      const text = await page.locator('#vdbgs_back_to_search_a').locator('xpath=ancestor::*[.//*[@id="vdbgs_add_to_cart_btn"]][1]').innerText().catch(async () => page.locator('main').innerText());
      const missing = ['Type', 'Color', 'Shape', 'Carat', 'Lab', 'Report #', 'Measurements', 'Ratio', 'Treatment', 'Share'].filter(l => !new RegExp('(^|\\n)\\s*' + l.replace('#', '\\#') + '\\s*:?\\s*(\\n|$)').test(text));
      c.check(!missing.length, `These details are missing from the panel: ${missing.join(', ')}`);
      c.check(text.includes(card.name), `The panel does not show the gemstone name "${card.name}"`);
      c.check(/\$\s*[\d,]+\.\d\d/.test(text), 'No price is shown');
      c.check(await isVisible(page.locator('#vdbgs_add_to_cart_btn')), 'There is no "Add to Cart" button');
      c.check(await isVisible(page.locator('#vdbgs_ask_que_modal_open')), 'There is no "Ask a Question" button');
      c.actual = `Panel opens for ${card.name}: price, Share, all details, Add to Cart and Ask a Question.`;
    }, ['GS-01']);

    await suite.run('GS-10', page, async c => {
      if (!card) return;
      const g = s.byId.get(card.id);
      c.step('Click Add to Cart');
      await must((await visible(page.locator('#vdbgs_add_to_cart_btn'))).click(), 'click "Add to Cart"');
      await page.waitForURL(/\/cart/, { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const cart = await page.evaluate(async () => (await fetch('/cart.js')).json()).catch(() => null) as { items: { title: string; sku: string; final_price: number }[] } | null;
      if (!cart) throw new StepError('Could not read the cart');
      const line = cart.items.find(i => (g?.stock_num && i.sku === g.stock_num) || i.title.includes(card!.name.replace(/\s+\d+(\.\d+)?ct$/i, '')));
      c.check(!!line, `The cart does not contain ${card.name} after Add to Cart`);
      if (line) c.check(Math.abs(line.final_price / 100 - (card.price ?? 0)) < 0.01, `The cart price ${fmt$(line.final_price / 100)} differs from the gemstone price ${fmt$(card.price)}`);
      c.actual = line ? `Cart shows "${line.title}" at ${fmt$(line.final_price / 100)}, same as the gemstone.` : '';
    }, ['GS-09']);
  } finally { await ctx.close().catch(() => {}); }
}

/** Type, pair, shape/carat/price, ratio/lab/treatment, sort, clear. */
export async function gemstoneFilterGroup(browser: Browser, cfg: Config, suite: Suite) {
  const ctx = await journeyContext(browser, cfg);
  const page = await ctx.newPage();
  const s = new GS(page, cfg);
  try {
    await suite.run('GS-02', page, async c => {
      await s.open(c, 'Ruby');
      const out: string[] = [];
      for (const gem of ['Sapphire', 'Emerald']) {
        const items = await s.apply(c, `Choose ${gem}`, async () => (await visible(page.locator(`.vdbgem_type[data-value="${gem}"]`))).click(), new RegExp(`gem_type=${gem}(&|$)`));
        const total = await s.count();
        const cards = await s.cards();
        if (!cards.length) { c.blocked(`No ${gem} gemstones were shown`); continue; }
        const ok = every(c, s, cards, (k, g) => new RegExp(gem, 'i').test(k.name) && (!g || g.gem_type === gem), `are not ${gem}`);
        out.push(`${gem}: ${n(total)} results, ${ok} of ${cards.length} shown are ${gem}`);
        void items;
      }
      c.actual = out.join('; ') + '.';
    });

    await suite.run('GS-03', page, async c => {
      await s.open(c, 'Ruby');
      await s.apply(c, 'Choose Pair', async () => (await visible(page.locator('.vdbgem_pair[data-value="PAIR"]'))).click(), /gem_type_pair=PAIR/);
      const total = await s.count();
      const cards = await s.cards();
      if (!cards.length) { c.blocked(`No ruby pairs are in stock (${n(total)} results), so "only pairs shown" could not be checked`); return; }
      every(c, s, cards, (_k, g) => !g || !!g.pair || !!g.is_linked_pair_parent, 'are single stones, not pairs');
      c.actual = `${n(total)} results, all pairs.`;
    });

    await suite.run('GS-04', page, async c => {
      await s.open(c, 'Sapphire');
      await s.apply(c, 'Tick shape Oval', () => s.tick('Shape', 'Oval'), /shapes=Oval/);
      await s.apply(c, 'Enter carat from 0.50', () => s.type('Carat', 'vdbgem_carat_min', '0.50'), /carat_min=0\.50/);
      await s.apply(c, 'Enter carat to 2.00', () => s.type('Carat', 'vdbgem_carat_max', '2.00'), /carat_max=2\.00/);
      await s.apply(c, 'Enter price from 100', () => s.type('Price', 'vdbgem_price_min', '100'), /price_min=100/);
      await s.apply(c, 'Enter price to 3000', () => s.type('Price', 'vdbgem_price_max', '3000'), /price_max=3000/);
      const total = await s.count();
      const cards = await s.cards();
      if (!cards.length) { c.blocked(`No oval sapphires of 0.50–2.00 ct priced $100–$3,000 (${n(total)} results), so nothing could be checked`); return; }
      const k = every(c, s, cards, (card, g) => {
        const ct = Number(g?.size ?? card.name.match(/(\d+(?:\.\d+)?)ct/i)?.[1]), price = Number(g?.total_sales_price ?? card.price);
        return /^Oval\b/i.test(g?.shape ?? card.name) && ct >= 0.5 && ct <= 2 && price >= 100 && price <= 3000;
      }, 'do not match Oval, 0.50–2.00 ct and $100–$3,000');
      c.actual = `${n(total)} results; ${k} of ${cards.length} shown are oval, 0.50–2.00 ct and $100–$3,000.`;
    });

    await suite.run('GS-05', page, async c => {
      await s.open(c, 'Sapphire');
      await s.apply(c, 'Enter ratio from 1.00', () => s.type('Ratio', 'vdbgem_ratio_min', '1.00'), /ratio[^=]*min=1/i);
      await s.apply(c, 'Enter ratio to 1.50', () => s.type('Ratio', 'vdbgem_ratio_max', '1.50'), /ratio[^=]*max=1\.5/i);
      await s.apply(c, 'Tick lab GIA', () => s.tick('Lab', 'GIA'), /GIA/);
      let treat = '';
      try {
        await s.apply(c, 'Tick treatment No', () => s.tick('Treatment', 'No'), /treat/i);
        const k = [...new URLSearchParams(s.lastReq).keys()].find(x => /treat/i.test(x));
        treat = k ? `${k}=${new URLSearchParams(s.lastReq).get(k)}` : '';
      } catch { c.note('(Ticking Treatment "No" did not change the search.)'); }
      const total = await s.count();
      const cards = await s.cards();
      if (!cards.length) { c.blocked(`No gemstones match these filters (${n(total)} results), so nothing could be checked`); return; }
      every(c, s, cards, (_k, g) => !g || g.meas_ratio == null || (Number(g.meas_ratio) >= 1 && Number(g.meas_ratio) <= 1.5), 'have a ratio outside 1.00–1.50');
      every(c, s, cards, (_k, g) => !g || (g.lab ?? '').toUpperCase() === 'GIA', 'are not GIA certified');
      const treatments = [...new Set(cards.map(k => s.byId.get(k.id)?.treatment ?? 'not stated'))];
      c.actual = `${n(total)} results; ratio 1.00–1.50 and lab GIA match on every card shown${treat ? `; treatment filter sent (${treat})` : ''}; treatments shown: ${treatments.join(', ')}.`;
      c.note('(Measurements was not tested: the sheet gives no values.)');
    });

    await suite.run('GS-06', page, async c => {
      await s.open(c, 'Sapphire');
      c.step('Open Sort');
      await must((await visible(page.locator('#vdbgs_sorting_opener'))).click(), 'open "Sort"');
      await page.waitForTimeout(700);
      const items = await s.apply(c, 'Choose Total Price', async () => (await visible(page.locator('li.vdbgs_available_sorting[data-field="total_sales_price"]'))).click(), /total_sales_price/);
      const prices = items.map(g => Number(g.total_sales_price));
      const bad = prices.findIndex((v, i) => i > 0 && v < prices[i - 1]);
      const cards = await s.cards();
      const cp = cards.map(k => k.price ?? 0);
      const cbad = cp.findIndex((v, i) => i > 0 && v < cp[i - 1]);
      c.check(bad < 0 && cbad < 0, `Prices are not in order after sorting by Total Price: ${fmt$(cbad >= 0 ? cp[cbad - 1] : prices[bad - 1])} comes before ${fmt$(cbad >= 0 ? cp[cbad] : prices[bad])}`);
      c.actual = bad < 0 && cbad < 0 ? `Sorted by price, low to high: ${fmt$(cp[0])} first, ${fmt$(cp[cp.length - 1])} last of ${cp.length} shown.` : '';
      await page.locator('.vdbgs_sorting_closer').locator('visible=true').first().click().catch(() => {});
    });

    await suite.run('GS-08', page, async c => {
      await s.open(c, 'Ruby');
      const full = await s.count();
      await s.apply(c, 'Choose Sapphire', async () => (await visible(page.locator('.vdbgem_type[data-value="Sapphire"]'))).click(), /gem_type=Sapphire/);
      await s.apply(c, 'Tick shape Oval', () => s.tick('Shape', 'Oval'), /shapes=Oval/);
      const filtered = await s.count();
      await s.apply(c, 'Click Clear Search', async () => (await visible(page.locator('#vdbgs_clear_search_btn'))).click());
      const after = await s.count();
      const oval = await page.locator('#ovalShape, input.vdbgem_shapes[data-value="Oval"]').evaluateAll(es => es.some(e => (e as HTMLInputElement).checked)).catch(() => false);
      const carat = await page.locator('input.vdbgem_carat_min').evaluateAll(es => es.map(e => (e as HTMLInputElement).value).filter(Boolean)).catch(() => [] as string[]);
      c.check(!oval, 'The Oval shape is still ticked after Clear Search');
      c.check(!carat.length, `The carat box still shows ${carat[0]}`);
      c.check((after ?? 0) > (filtered ?? 0), `The result count did not go back up after Clear Search (${n(filtered)} → ${n(after)})`);
      c.actual = `Filtered: ${n(filtered)} results; after Clear Search: ${n(after)} results (Ruby page opened with ${n(full)}); filters reset.`;
    });
  } finally { await ctx.close().catch(() => {}); }
}

export const GEM_LIST = ['GS-01', 'GS-11', 'GS-07', 'GS-09', 'GS-10'];
export const GEM_FILTERS = ['GS-02', 'GS-03', 'GS-04', 'GS-05', 'GS-06', 'GS-08'];
