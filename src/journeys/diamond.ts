// Phase 2 · Week 1 · Diamond Search (DS-01 … DS-26)
import type { Browser, Page, Response } from 'playwright';
import type { Config } from '../config.js';
import { gotoSettled } from '../browser.js';
import { Case, Suite, StepError, during, fmt$, isVisible, journeyContext, list, money, must, setSlider, visible, watchDialogs } from './harness.js';

const DS_PATH = 'apps/vdb-app/search-filters?structure=new';

interface Diamond {
  id: number; stock_num: string; shape: string; size: string; color: string | null; clarity: string; cut: string | null; polish: string | null; symmetry: string | null;
  total_sales_price: string; fluor_intensity: string | null; depth_percent: string | null; table_percent: number | string | null; lab_grown?: boolean;
  fancy_color_dominant_color: string | null; fancy_color_intensity: string | null; short_title?: string;
}
interface Card { id: string; name: string; cat: string; price?: number; shape?: string; carat?: number; color?: string; clarity?: string }
interface SearchResult { total?: number; items: Diamond[]; req: string }

const post = (r: Response) => r.request().postData() ?? '';
const isList = (r: Response) => /search-filters\.php/.test(r.url()) && /method=getProduct/.test(post(r)) && !/only_count_fetch|share_proids/.test(post(r));
const isPage1 = (r: Response) => isList(r) && /[&]page_number=1(&|$)/.test(post(r));
const isCount = (r: Response) => /search-filters\.php/.test(r.url()) && /only_count_fetch=true/.test(post(r));
export const param = (body: string, k: string) => decodeURIComponent(((body.match(new RegExp('(?:^|&)' + k.replace(/[.[\]]/g, '\\$&') + '=([^&]*)')) || [])[1] || '').replace(/\+/g, ' '));

async function diamondsOf(r: Response): Promise<Diamond[]> {
  try {
    const j = await r.json();
    const m = typeof j.main_data === 'string' ? JSON.parse(j.main_data) : j.main_data;
    return m?.response?.body?.diamonds ?? [];
  } catch { return []; }
}

export function parseCardName(n: string): Pick<Card, 'shape' | 'carat' | 'color' | 'clarity'> {
  const m = n.replace(/\s+/g, ' ').trim().match(/^(.*?) (\d+\.\d+) (.*) (\S+)$/);
  return m ? { shape: m[1], carat: Number(m[2]), color: m[3], clarity: m[4] } : {};
}

/** One Diamond Search page under test. */
class DS {
  byId = new Map<string, Diamond>();
  dialogs: string[];
  constructor(public page: Page, public cfg: Config) {
    this.dialogs = watchDialogs(page);
    page.on('response', async r => { if (isList(r) && r.ok()) for (const d of await diamondsOf(r)) this.byId.set(String(d.id), d); });
  }

  async open(c?: Case, url = DS_PATH) {
    c?.step('Open Diamond Search');
    const g = await gotoSettled(this.page, this.cfg.baseUrl + url, this.cfg);
    if (g.error || (g.status && g.status >= 400)) throw new StepError(`Could not open Diamond Search (${g.error ?? 'HTTP ' + g.status})`);
    await must(visible(this.page.locator('a.vdb-search-diamond-data-wrap'), 30_000), 'see the Diamond Search form (it did not appear within 30 s)');
    await this.page.waitForTimeout(1200); // the app wires its buttons just after they appear
  }

  /** Presses Search (or runs `action`) and waits for the results the app shows. */
  async search(c: Case | undefined, action?: () => Promise<unknown>, what = 'pressing Search', pred: (r: Response) => boolean = isPage1): Promise<SearchResult> {
    c?.step(what.replace(/^pressing/, 'Press'));
    const countWait = this.page.waitForResponse(isCount, { timeout: 30_000 }).catch(() => null);
    const r = await during(this.page, pred, action ?? (() => this.page.locator('a.vdb-search-diamond-data-wrap').locator('visible=true').first().click()), what);
    const items = await diamondsOf(r);
    const cr = await countWait;
    let total: number | undefined;
    try { total = cr ? (await cr.json())?.main_data_for_count?.response?.body?.total_diamonds_found : undefined; } catch { /* ignore */ }
    await this.page.waitForFunction(() => {
      const el = [...document.querySelectorAll('#search_diamond_count')].find(e => (e as HTMLElement).offsetParent) as HTMLElement | undefined;
      const cover = document.querySelector('#main_page_cover') as HTMLElement | null;
      return !!el && /\d/.test(el.innerText) && (!cover || getComputedStyle(cover).display === 'none');
    }, null, { timeout: 25_000 }).catch(() => { throw new StepError(`Results did not appear after ${what}`); });
    await this.page.waitForTimeout(600);
    const shown = await this.shownCount();
    return { total: shown ?? total, items, req: post(r) };
  }

  async shownCount(): Promise<number | undefined> {
    const t = await this.page.locator('#search_diamond_count').locator('visible=true').first().innerText().catch(() => '');
    const m = t.replace(/,/g, '').match(/(\d+)/);
    return m ? Number(m[1]) : undefined;
  }

  async cards(): Promise<Card[]> {
    const raw = await this.page.$$eval('.vdb-search-result-block', els => els.filter(e => (e as HTMLElement).getClientRects().length && (e as HTMLElement).offsetWidth > 0).map(e => ({
      id: e.getAttribute('data-prids') ?? '',
      name: (e.querySelector('.vdb-product-name')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      cat: (e.querySelector('.vdb-product-cat')?.textContent ?? '').trim(),
      price: (e.querySelector('.vdb-product-prize')?.textContent ?? '').trim(),
    })));
    return raw.map(x => ({ ...x, price: money(x.price), ...parseCardName(x.name) }));
  }

  async shape(name: string, c?: Case) {
    c?.step(`Select shape ${name}`);
    const t = this.page.locator('a.vdbrb_list_item_a_shape_style', { hasText: new RegExp(`^\\s*${name}\\s*$`) });
    await must((await visible(t)).click(), `select the ${name} shape`);
    await this.page.waitForTimeout(250);
  }

  async shapeActive(name: string): Promise<boolean> {
    return this.page.locator('a.vdbrb_list_item_a_shape_style', { hasText: new RegExp(`^\\s*${name}\\s*$`) }).locator('visible=true').first()
      .evaluate(e => !!e.querySelector('.vdb-rb-list-item-active')).catch(() => false);
  }

  async fill(cls: string, v: string, label: string, c?: Case) {
    c?.step(`Enter ${label}: ${v}`);
    const i = await must(visible(this.page.locator('input.' + cls)), `find the ${label} box`);
    await i.fill(v); await i.press('Tab'); await this.page.waitForTimeout(200);
  }

  async value(cls: string): Promise<string> {
    return this.page.evaluate(cls => {
      const all = [...document.querySelectorAll('input.' + cls)] as HTMLInputElement[];
      const v = all.find(i => i.offsetWidth > 0 || (i.previousElementSibling as HTMLElement | null)?.offsetWidth) ?? all[0];
      return v?.value ?? '';
    }, cls);
  }

  async slider(cls: string, from: string, to: string, label: string, c?: Case) {
    c?.step(`Set ${label} ${from} – ${to}`);
    await setSlider(this.page, cls, from, to, label);
  }

  /** Diamond data behind the cards on screen (falls back to the card text). */
  dataFor(cards: Card[]) { return cards.map(k => ({ card: k, d: this.byId.get(k.id) })); }

  async openDetail(card: Card, c?: Case) {
    c?.step(`Open "${card.name}"`);
    const img = this.page.locator(`.vdb-search-result-block[data-prids="${card.id}"] .vdb-search-result-image`).locator('visible=true').first();
    await must(img.click({ timeout: 10_000 }), `open "${card.name}"`);
    await must(visible(this.page.locator('#back_to_search_a'), 20_000), `see the detail panel for "${card.name}"`);
    await this.page.waitForTimeout(800);
  }
}

const results = (n: number | undefined) => n == null ? 'an unknown number of' : n.toLocaleString('en-US');
const badList = (xs: { card: Card }[]) => list(xs.map(x => x.card.name), 3);

/** Everything on the first results screens must satisfy `ok`. */
function everyCard(c: Case, s: DS, cards: Card[], ok: (card: Card, d?: Diamond) => boolean, what: string) {
  const rows = s.dataFor(cards);
  const bad = rows.filter(r => !ok(r.card, r.d));
  c.check(!bad.length, `${bad.length} of ${rows.length} diamonds shown ${what}: ${badList(bad)}`);
  return rows.length - bad.length;
}

// ------------------------------------------------------------------ groups

/** Form, shape, Modify / New / Clear, carat, colour & clarity. */
export async function diamondFormGroup(browser: Browser, cfg: Config, suite: Suite, shared: { baseline?: number }) {
  const ctx = await journeyContext(browser, cfg);
  const page = await ctx.newPage();
  const s = new DS(page, cfg);
  try {
    await suite.run('DS-01', page, async c => {
      await s.open(c);
      for (const [sel, t] of [['#vdbrb_natural_tab', 'Natural Diamonds'], ['#vdbrb_labgrown_tab', 'Lab-Grown Diamonds'], ['#vdbrb_gemstone_tab', 'Colored Gemstones']]) {
        const txt = await page.locator(sel).locator('visible=true').first().innerText().catch(() => '');
        c.check(txt.includes(t), `The "${t}" tab is missing`);
      }
      const text = await page.locator('main').innerText();
      const missing = ['Shape', 'Carat', 'Color', 'Fancy', 'Clarity', 'Cut Grade', 'Polish', 'Symmetry', 'Budget', 'Advanced Filters'].filter(h => !new RegExp('(^|\\n)\\s*' + h + '\\s*(\\n|$)', 'i').test(text));
      c.check(!missing.length, `These filters are missing from the form: ${missing.join(', ')}`);
      c.check(await isVisible(page.locator('#search-stock-number')), 'The "Enter Stock #" box is missing');
      c.check(await isVisible(page.locator('a.vdb-clear-search', { hasText: 'Clear Search' })), 'The "Clear Search" button is missing');
      c.check(await isVisible(page.locator('a.vdb-search-diamond-data-wrap')), 'The "Search" button is missing');
      if (/This is a placeholder text/i.test(text)) c.note('(The placeholder line above the tabs is still shown: known, accepted.)');
      c.actual = missing.length ? '' : 'Form shows the 3 tabs, all 10 filters, the Stock # box, Search and Clear Search.';
    });

    await suite.run('DS-02', page, async c => {
      const r = await s.search(c);
      const cards = await s.cards();
      c.check((r.total ?? 0) > 0, 'Search with the default filters shows 0 results');
      c.check(cards.length > 0, 'No result cards are shown');
      const bad = cards.filter(k => !k.shape || !k.carat || !k.color || !k.clarity || !/^[A-Z]{1,3}\.[A-Z]{1,3}\.[A-Z]{1,3}\/\S+/.test(k.cat) || !k.price);
      c.check(!bad.length, `${bad.length} cards are missing shape, carat, colour, clarity, cut/polish/symmetry/fluorescence or price: ${list(bad.map(b => b.name || b.id))}`);
      shared.baseline = r.total;
      c.actual = `${results(r.total)} results; ${cards.length} cards shown, each with shape, carat, colour, clarity, cut/polish/symmetry/fluorescence and price.`;
    }, ['DS-01']);

    await suite.run('DS-03', page, async c => {
      await s.open(c);
      await s.shape('Oval', c);
      c.check(await s.shapeActive('Oval'), 'The Oval shape does not show as selected after clicking it');
      const r = await s.search(c);
      c.check(param(r.req, 'shape_data_wrap') === 'Oval', `The search used shapes "${param(r.req, 'shape_data_wrap')}" instead of only Oval`);
      if (shared.baseline != null) c.check(r.total !== shared.baseline, `The result count did not change (${results(r.total)} with and without the Oval filter)`);
      const cards = await s.cards();
      if (!cards.length) { c.blocked('No diamonds were shown, so the shape could not be checked'); return; }
      const n = everyCard(c, s, cards, (k, d) => (d?.shape ?? k.shape) === 'Oval' && (k.shape ?? 'Oval') === 'Oval', 'are not Oval');
      c.actual = `${results(r.total)} results (was ${results(shared.baseline)} without the filter); ${n} of ${cards.length} diamonds shown are Oval.`;
    }, ['DS-01']);

    await suite.run('DS-15', page, async c => {
      c.step('Click Modify Search');
      await must((await visible(page.locator('a.vdb-modify-search'))).click(), 'click "Modify Search"');
      const form = await visible(page.locator('a.vdb-search-diamond-data-wrap'), 10_000).then(() => true).catch(() => false);
      c.check(form, 'The filter form did not open');
      c.check(await s.shapeActive('Oval'), 'The previously selected Oval shape is no longer selected');
      c.actual = form ? 'Filter form opened with Oval still selected.' : '';
    }, ['DS-03']);

    await suite.run('DS-16', page, async c => {
      await s.search(c);
      c.step('Click New Search');
      await must((await visible(page.locator('a.vdb-new-search'))).click(), 'click "New Search"');
      await page.waitForTimeout(2000);
      const form = await isVisible(page.locator('a.vdb-search-diamond-data-wrap'));
      const oval = await s.shapeActive('Oval');
      const cmin = await s.value('vdbrb_min_carat_web'), cmax = await s.value('vdbrb_max_carat_web');
      c.check(form, 'The filter form was not shown after New Search');
      c.check(!oval, 'Oval is still selected after New Search');
      c.check(Number(cmin) === 0 && Number(cmax) === 7, `Carat was not reset (shows ${cmin} – ${cmax})`);
      c.actual = 'All filters cleared and the empty search form shown.';
    }, ['DS-03']);

    await suite.run('DS-17', page, async c => {
      await s.open(c);
      await s.shape('Oval', c);
      await s.fill('vdbrb_min_carat_web', '1.00', 'minimum carat', c);
      await s.fill('vdbrb_max_carat_web', '2.00', 'maximum carat', c);
      await s.slider('vbdrb_white_color_web', 'G', 'H', 'Color', c);
      c.step('Click Clear Search');
      await must((await visible(page.locator('a.vdb-clear-search', { hasText: 'Clear Search' }))).click(), 'click "Clear Search"');
      await page.waitForTimeout(1500);
      const left: string[] = [];
      if (await s.shapeActive('Oval')) left.push('Oval shape still selected');
      const cmin = await s.value('vdbrb_min_carat_web'), cmax = await s.value('vdbrb_max_carat_web');
      if (Number(cmin) !== 0 || Number(cmax) !== 7) left.push(`carat still ${cmin} – ${cmax}`);
      const col = await s.value('vbdrb_white_color_web');
      if (col && col !== 'D,J') left.push(`colour still ${col.replace(',', ' – ')}`);
      c.check(!left.length, `Not everything was reset: ${left.join('; ')}`);
      c.actual = left.length ? '' : 'Shape, carat and colour went back to their defaults.';
    }, ['DS-01']);

    await suite.run('DS-04', page, async c => {
      await s.open(c);
      await s.fill('vdbrb_min_carat_web', '1.00', 'minimum carat', c);
      await s.fill('vdbrb_max_carat_web', '2.00', 'maximum carat', c);
      const r = await s.search(c);
      c.check(Number(param(r.req, 'carat_min')) === 1 && Number(param(r.req, 'carat_max')) === 2, `The search used carat ${param(r.req, 'carat_min')} – ${param(r.req, 'carat_max')} instead of 1.00 – 2.00`);
      const cards = await s.cards();
      if (!cards.length) { c.blocked('No diamonds between 1 and 2 ct were shown, so nothing could be checked'); return; }
      const n = everyCard(c, s, cards, (k, d) => { const ct = Number(d?.size ?? k.carat); return ct >= 1 && ct <= 2; }, 'are outside 1.00 – 2.00 ct');
      c.actual = `${results(r.total)} results; ${n} of ${cards.length} diamonds shown are between 1.00 and 2.00 ct.`;
    }, ['DS-01']);

    await suite.run('DS-05', page, async c => {
      await s.open(c);
      await s.slider('vbdrb_white_color_web', 'G', 'H', 'Color', c);
      await s.slider('vbdrb_clarity_web', 'VS1', 'VS2', 'Clarity', c);
      const r = await s.search(c);
      const cols = param(r.req, 'color_data_wrap'), cls = param(r.req, 'clarity_data_wrap');
      c.check(cols === 'G,H', `The search used colours "${cols}" instead of G, H`);
      c.check(cls === 'VS1,VS2', `The search used clarities "${cls}" instead of VS1, VS2`);
      const cards = await s.cards();
      if (!cards.length) { c.blocked('No diamonds were shown for G–H / VS1–VS2, so nothing could be checked'); return; }
      const n = everyCard(c, s, cards, (k, d) => ['G', 'H'].includes(d?.color ?? k.color ?? '') && ['VS1', 'VS2'].includes(d?.clarity ?? k.clarity ?? ''), 'are not colour G–H with clarity VS1–VS2');
      c.actual = `${results(r.total)} results; ${n} of ${cards.length} diamonds shown are G–H and VS1–VS2.`;
    }, ['DS-01']);
  } finally { await ctx.close().catch(() => {}); }
}

/** Budget, fancy colour, cut grades, advanced filters, stock number, combined, no results, lab-grown. */
export async function diamondFilterGroup(browser: Browser, cfg: Config, suite: Suite) {
  const ctx = await journeyContext(browser, cfg);
  const page = await ctx.newPage();
  const s = new DS(page, cfg);
  try {
    await suite.run('DS-06', page, async c => {
      await s.open(c);
      await s.fill('vdbrb_min_budget_web', '1000', 'minimum budget', c);
      await s.fill('vdbrb_max_budget_web', '5000', 'maximum budget', c);
      const r = await s.search(c);
      c.check(Number(param(r.req, 'budget_min')) === 1000 && Number(param(r.req, 'budget_max')) === 5000, `The search used a budget of ${param(r.req, 'budget_min')} – ${param(r.req, 'budget_max')} instead of 1,000 – 5,000`);
      const cards = await s.cards();
      if (!cards.length) { c.blocked(`No diamonds are priced between $1,000 and $5,000 (${results(r.total)} results), so the prices could not be checked. The demo stones are mostly $100 or $50,000.`); return; }
      const n = everyCard(c, s, cards, (k, d) => { const p = Number(d?.total_sales_price ?? k.price); return p >= 1000 && p <= 5000; }, 'are priced outside $1,000 – $5,000');
      c.actual = `${results(r.total)} results; ${n} of ${cards.length} prices are within $1,000 – $5,000.`;
    });

    await suite.run('DS-07', page, async c => {
      await s.open(c);
      c.step('Use Next and Previous on the Fancy colours');
      const next = page.locator('.vdbrb_fancy_color button.slick-next, button.slick-next').locator('visible=true').first();
      const prev = page.locator('.vdbrb_fancy_color button.slick-prev, button.slick-prev').locator('visible=true').first();
      await must(next.evaluate(e => (e as HTMLElement).click()), 'use the Fancy "Next" arrow');
      await page.waitForTimeout(500);
      await must(prev.evaluate(e => (e as HTMLElement).click()), 'use the Fancy "Previous" arrow');
      await page.waitForTimeout(500);
      c.step('Choose Yellow');
      await must((await visible(page.locator('a.vdbrb_list_item_a_fancy_color_style', { hasText: /^\s*Yellow\s*$/ }))).click(), 'choose the Yellow fancy colour');
      const r = await s.search(c);
      c.check(param(r.req, 'fcolor_data_wrap') === 'Yellow', `The search used fancy colour "${param(r.req, 'fcolor_data_wrap')}" instead of Yellow`);
      const cards = await s.cards();
      if (!cards.length) { c.blocked('No yellow fancy diamonds were shown, so nothing could be checked'); return; }
      const n = everyCard(c, s, cards, (k, d) => /fancy/i.test(k.name) && /yellow/i.test(k.name) && (!d || /yellow/i.test(d.fancy_color_dominant_color ?? '')), 'do not show "Fancy … Yellow"');
      c.actual = `${results(r.total)} results; ${n} of ${cards.length} cards show "Fancy … Yellow" (e.g. ${cards[0].name}).`;
    });

    await suite.run('DS-08', page, async c => {
      await s.open(c);
      await s.slider('vbdrb_cut_grade_web', 'Excellent', 'Excellent', 'Cut Grade', c);
      await s.slider('vbdrb_cut_polish_web', 'Excellent', 'Excellent', 'Polish', c);
      await s.slider('vbdrb_cut_symmetry_web', 'Excellent', 'Excellent', 'Symmetry', c);
      const r = await s.search(c);
      for (const [k, l] of [['cut_data_wrap', 'cut grade'], ['polish_data_wrap', 'polish'], ['symmetry_data_wrap', 'symmetry']]) c.check(param(r.req, k) === 'Excellent', `The search used ${l} "${param(r.req, k)}" instead of Excellent`);
      const cards = await s.cards();
      if (!cards.length) { c.blocked('No Excellent/Excellent/Excellent diamonds were shown, so nothing could be checked'); return; }
      const n = everyCard(c, s, cards, (k, d) => /^EX\.EX\.EX\//.test(k.cat) && (!d || (d.cut === 'Excellent' && d.polish === 'Excellent' && d.symmetry === 'Excellent')), 'are not EX for cut, polish and symmetry');
      c.actual = `${results(r.total)} results; ${n} of ${cards.length} cards show EX.EX.EX.`;
    });

    await suite.run('DS-09', page, async c => {
      await s.open(c);
      c.step('Open Advanced Filters');
      await must((await visible(page.locator('#vdbrb_advanced_filter'))).click(), 'open "Advanced Filters"');
      await page.waitForTimeout(1200);
      // find the Depth and Table number boxes by their headings
      const tagged = await page.evaluate(() => {
        const out: string[] = [];
        for (const name of ['Depth', 'Table']) {
          const h = [...document.querySelectorAll('p,span,label,div,h4,h5')].find(e => e.children.length <= 1 && (e as HTMLElement).innerText?.trim() === name && (e as HTMLElement).offsetWidth > 0) as HTMLElement | undefined;
          let box: HTMLElement | null = h ?? null;
          for (let i = 0; box && i < 6; i++) { const ins = [...box.querySelectorAll('input')].filter(x => (x as HTMLElement).offsetWidth > 0 && (x as HTMLInputElement).type !== 'hidden'); if (ins.length >= 2) { ins[0].setAttribute('data-qa', name + '-min'); ins[1].setAttribute('data-qa', name + '-max'); out.push(name); break; } box = box.parentElement; }
        }
        return out;
      });
      const text = await page.locator('main').innerText();
      const missing = ['Fluorescence', 'Depth', 'Table', 'Ratio', 'Origin'].filter(h => !new RegExp('(^|\\n)\\s*' + h + '\\s*(\\n|$)', 'i').test(text));
      await s.slider('vbdrb_fluorescence_web', 'None', 'None', 'Fluorescence', c);
      for (const [n, lo, hi] of [['Depth', '55', '70'], ['Table', '50', '65']] as const) {
        if (!tagged.includes(n)) continue;
        c.step(`Set ${n} ${lo} – ${hi}`);
        for (const [k, v] of [['min', lo], ['max', hi]]) { const i = page.locator(`[data-qa="${n}-${k}"]`); await i.fill(v); await i.press('Tab'); }
      }
      const r = await s.search(c);
      c.check(param(r.req, 'flour_data_wrap') === 'None', `The search used fluorescence "${param(r.req, 'flour_data_wrap')}" instead of None`);
      if (tagged.includes('Depth')) c.check(Number(param(r.req, 'depth_min')) === 55 && Number(param(r.req, 'depth_max')) === 70, `The search used depth ${param(r.req, 'depth_min')} – ${param(r.req, 'depth_max')} instead of 55 – 70`);
      if (tagged.includes('Table')) c.check(Number(param(r.req, 'table_min')) === 50 && Number(param(r.req, 'table_max')) === 65, `The search used table ${param(r.req, 'table_min')} – ${param(r.req, 'table_max')} instead of 50 – 65`);
      const cards = await s.cards();
      if (cards.length) {
        everyCard(c, s, cards, (_k, d) => !d || ((d.fluor_intensity ?? 'None') === 'None'), 'do not have fluorescence None');
        if (tagged.includes('Depth')) everyCard(c, s, cards, (_k, d) => !d || d.depth_percent == null || (Number(d.depth_percent) >= 55 && Number(d.depth_percent) <= 70), 'have a depth outside 55 – 70 %');
        if (tagged.includes('Table')) everyCard(c, s, cards, (_k, d) => !d || d.table_percent == null || (Number(d.table_percent) >= 50 && Number(d.table_percent) <= 65), 'have a table outside 50 – 65 %');
      } else c.blocked('No diamonds matched these advanced filters, so the results could not be checked');
      const notOffered = missing.filter(m => ['Ratio', 'Origin'].includes(m));
      const reallyMissing = missing.filter(m => !notOffered.includes(m));
      c.check(!reallyMissing.length, `These advanced filters are missing: ${reallyMissing.join(', ')}`);
      if (notOffered.length) c.warn(`${notOffered.join(' and ')} ${notOffered.length > 1 ? 'are' : 'is'} not offered in Advanced Filters, so ${notOffered.length > 1 ? 'they were' : 'it was'} not tested (the test case expects Origin = Canadian)`);
      c.actual = `Advanced Filters shows ${['Lab', 'Fluorescence', 'Depth', 'Table'].filter(h => !missing.includes(h)).join(', ')}; with Fluorescence None${tagged.length ? ', Depth 55–70, Table 50–65' : ''}: ${results(r.total)} results, all matching.`;
    });

    await suite.run('DS-10', page, async c => {
      await s.open(c);
      c.step('Enter stock number DemoStock471');
      await must((await visible(page.locator('#search-stock-number'))).fill('DemoStock471'), 'type in the "Enter Stock #" box');
      const r = await s.search(c, async () => (await visible(page.locator('.vdb-search-stock-number-wrap'))).click(), 'pressing the stock-number search icon', x => isList(x) && /stock_num=DemoStock471/.test(post(x)));
      const cards = await s.cards();
      const stocks = s.dataFor(cards).map(x => x.d?.stock_num ?? '?');
      c.check(cards.length === 1 && stocks[0] === 'DemoStock471', cards.length ? `Expected only DemoStock471 but ${cards.length} diamonds were shown (${list(stocks)})` : 'No diamond was found for stock number DemoStock471');
      c.actual = cards.length === 1 ? `Only that diamond is returned: ${cards[0].name} (${stocks[0]}), "${results(r.total)} Results".` : '';
    });

    await suite.run('DS-11', page, async c => {
      await s.open(c);
      await s.shape('Round', c);
      const single = await s.search(c, undefined, 'pressing Search with only Round selected');
      await s.open(c);
      await s.shape('Round', c);
      await s.fill('vdbrb_min_carat_web', '0.50', 'minimum carat', c);
      await s.fill('vdbrb_max_carat_web', '3.00', 'maximum carat', c);
      await s.slider('vbdrb_white_color_web', 'D', 'H', 'Color', c);
      await s.slider('vbdrb_clarity_web', 'VVS1', 'SI1', 'Clarity', c);
      await s.fill('vdbrb_min_budget_web', '0', 'minimum budget', c);
      await s.fill('vdbrb_max_budget_web', '1000', 'maximum budget', c);
      const r = await s.search(c, undefined, 'pressing Search with all filters');
      if (single.total != null && r.total != null) c.check(r.total <= single.total, `Combining filters shows more diamonds (${results(r.total)}) than Round alone (${results(single.total)})`);
      const cards = await s.cards();
      if (!cards.length) { c.blocked(`No diamonds match all filters together (${results(r.total)} results), so the cards could not be checked`); return; }
      const CL = ['FL', 'IF', 'VVS1', 'VVS2', 'VS1', 'VS2', 'SI1', 'SI2', 'SI3', 'I1'];
      const n = everyCard(c, s, cards, (k, d) => {
        const ct = Number(d?.size ?? k.carat), p = Number(d?.total_sales_price ?? k.price), col = d?.color ?? k.color ?? '', cl = d?.clarity ?? k.clarity ?? '';
        return (d?.shape ?? k.shape) === 'Round' && ct >= 0.5 && ct <= 3 && ['D', 'E', 'F', 'G', 'H'].includes(col) && CL.indexOf(cl) >= CL.indexOf('VVS1') && CL.indexOf(cl) <= CL.indexOf('SI1') && p <= 1000;
      }, 'do not meet every filter (Round, 0.50–3.00 ct, D–H, VVS1–SI1, up to $1,000)');
      c.actual = `${results(r.total)} results with all filters (Round alone: ${results(single.total)}); ${n} of ${cards.length} diamonds shown meet every filter.`;
    });

    await suite.run('DS-12', page, async c => {
      await s.open(c);
      await s.shape('Heart', c);
      await s.fill('vdbrb_min_carat_web', '6.00', 'minimum carat', c);
      await s.fill('vdbrb_max_carat_web', '7.00', 'maximum carat', c);
      await s.slider('vbdrb_white_color_web', 'D', 'D', 'Color', c);
      await s.slider('vbdrb_clarity_web', 'FL', 'FL', 'Clarity', c);
      await s.fill('vdbrb_max_budget_web', '500', 'maximum budget', c);
      const r = await s.search(c);
      const cards = await s.cards();
      c.check((r.total ?? 0) === 0 && cards.length === 0, `Expected no results but ${results(r.total)} were shown`);
      const loader = await page.locator('#main_page_cover').isVisible().catch(() => false);
      c.check(!loader, 'The loading animation keeps spinning');
      c.check(s.dialogs.length === 0, `An error pop-up appeared: "${s.dialogs[0]}"`);
      const txt = await page.locator('#search_diamond_count').locator('visible=true').first().innerText().catch(() => '');
      c.actual = `Shows "${txt.trim()}" with no cards; no error and no endless loader.`;
    });

    await suite.run('DS-25', page, async c => {
      await s.open(c);
      c.step('Click the Lab-Grown Diamonds tab');
      await must((await visible(page.locator('#vdbrb_labgrown_tab'))).click(), 'click the "Lab-Grown Diamonds" tab');
      await page.waitForURL(/Lab_grown_Diamond/i, { timeout: 20_000 }).catch(() => {});
      await must(visible(page.locator('a.vdb-search-diamond-data-wrap'), 30_000), 'see the Lab-Grown search form');
      await page.waitForTimeout(1200);
      const title = await page.getByText(/Lab-Grown Diamonds Search/i).locator('visible=true').count();
      c.check(title > 0, 'The page title does not say "Lab-Grown Diamonds Search"');
      const r = await s.search(c);
      c.check(/Lab_grown/i.test(param(r.req, 'diamondSearchType')), 'The search was not made for lab-grown diamonds');
      c.check((r.total ?? 0) > 0, 'The lab-grown search shows 0 results');
      const cards = await s.cards();
      const bad = s.dataFor(cards).filter(x => x.d && x.d.lab_grown === false);
      c.check(!bad.length, `${bad.length} natural diamonds appear in the lab-grown results: ${badList(bad)}`);
      c.actual = `${results(r.total)} lab-grown results load (${cards.length} cards shown).`;
    });
  } finally { await ctx.close().catch(() => {}); }
}

/** Sort, infinite scroll, price sanity, share, detail panel and its actions, add to cart. */
export async function diamondResultsGroup(browser: Browser, cfg: Config, suite: Suite) {
  const ctx = await journeyContext(browser, cfg);
  let page = await ctx.newPage();
  let s = new DS(page, cfg);
  const CO = ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'];
  try {
    await suite.run('DS-13', page, async c => {
      const sorts: [string, string, string, (d: Diamond) => number][] = [
        ['total_sales_price', 'Total Price', 'price', d => Number(d.total_sales_price)],
        ['size', 'Carat', 'carat', d => Number(d.size)],
        ['color', 'Color', 'colour', d => CO.indexOf(d.color ?? '') < 0 ? 99 : CO.indexOf(d.color ?? '')],
      ];
      const done: string[] = [];
      for (const [field, label, word, key] of sorts) {
        await s.open(c);
        await s.search(c);
        c.step(`Open Sort and choose ${label}`);
        await must((await visible(page.getByText('Sort', { exact: true }))).click(), 'open "Sort"');
        await page.waitForTimeout(800);
        const asc = await s.search(c, async () => (await visible(page.locator('a.vdb-available_sorting', { hasText: new RegExp(`^\\s*${label}\\s*$`) }))).click(), `choosing ${label}`, r => isPage1(r) && new RegExp(`${field}%22%3A%22ASC`).test(post(r)));
        const a = asc.items.map(key);
        const aBad = a.findIndex((v, i) => i > 0 && v < a[i - 1]);
        c.check(aBad < 0, `Sorting by ${label} (low to high) is out of order: ${word} ${asc.items[aBad - 1] ? describe(asc.items[aBad - 1]) : ''} comes before ${asc.items[aBad] ? describe(asc.items[aBad]) : ''}`);
        if (field === 'total_sales_price') {
          const desc = await s.search(c, async () => (await visible(page.locator(`a.vdb-selected_sorting_change_${field}`))).click(), `switching ${label} to high to low`, r => isPage1(r) && new RegExp(`${field}%22%3A%22DESC`).test(post(r)));
          const dd = desc.items.map(key);
          const dBad = dd.findIndex((v, i) => i > 0 && v > dd[i - 1]);
          c.check(dBad < 0, `Sorting by ${label} (high to low) is out of order`);
          done.push(`${label} low→high (${fmt$(a[0])} first) and high→low (${fmt$(dd[0])} first)`);
        } else done.push(`${label} (${word} ${field === 'color' ? (asc.items[0]?.color ?? '?') : a[0]} first)`);
        await page.locator('a.vdb-grid_sort_nav_con_close').locator('visible=true').first().click().catch(() => {});
      }
      c.actual = `Cards reorder correctly: ${done.join('; ')}.`;
    });

    await suite.run('DS-14', page, async c => {
      await s.open(c);
      await s.search(c);
      let cards = await s.cards();
      const counts = [cards.length];
      for (let i = 0; i < 3; i++) {
        c.step('Scroll to the bottom of the results');
        const before = cards.length;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight - 1700));
        await page.waitForFunction(n => document.querySelectorAll('.vdb-search-result-block').length > n, before, { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(1500);
        cards = await s.cards();
        counts.push(cards.length);
      }
      const grew = counts.every((n, i) => i === 0 || n > counts[i - 1]);
      c.check(grew, `No more diamonds loaded when scrolling (cards: ${counts.join(' → ')})`);
      const steps = counts.slice(1).map((n, i) => n - counts[i]);
      if (grew && steps.some(x => x % 12 !== 0)) c.note(`(Loaded ${steps.join(', ')} more per scroll, not always 12.)`);
      const ids = cards.map(k => k.id);
      const dupIds = ids.filter((x, i) => ids.indexOf(x) !== i);
      c.check(!dupIds.length, `${dupIds.length} diamonds are shown twice while scrolling`);
      const stocks = s.dataFor(cards).map(x => x.d?.stock_num).filter(Boolean) as string[];
      const dupStock = stocks.filter((x, i) => stocks.indexOf(x) !== i);
      c.check(!dupStock.length, `The same stock number appears more than once: ${list([...new Set(dupStock)])}`);
      const names = cards.map(k => k.name + ' ' + k.price);
      const lookAlike = names.filter((x, i) => names.indexOf(x) !== i).length;
      if (lookAlike) c.note(`(${lookAlike} cards look identical to another card, same shape, carat, colour, clarity and price, but are different stock numbers: demo data.)`);
      c.actual = `Cards: ${counts.join(' → ')} as you scroll; no diamond shown twice.`;
    });

    await suite.run('DS-26', page, async c => {
      let cards = await s.cards();
      if (cards.length < 48) {
        c.step('Scroll until 48 cards are loaded');
        for (let i = 0; i < 4 && cards.length < 48; i++) { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight - 1700)); await page.waitForTimeout(2500); cards = await s.cards(); }
      }
      const first = cards.slice(0, 48);
      if (!first.length) { c.blocked('No result cards to read'); return; }
      const zero = first.filter(k => !k.price);
      c.check(!zero.length, `${zero.length} diamonds show $0.00 or no price: ${list(zero.map(z => z.name))}`);
      const cheap = first.filter(k => (k.carat ?? 0) >= 1 && (k.price ?? 0) > 0 && (k.price ?? 0) / (k.carat ?? 1) < 200);
      if (cheap.length) c.warn(`${cheap.length} of ${first.length} stones of 1 ct or more are priced under $200 per carat (e.g. ${cheap[0].name} at ${fmt$(cheap[0].price)}). Demo data, to confirm.`);
      c.actual = `Read ${first.length} prices: none at $0.00; prices from ${fmt$(Math.min(...first.map(k => k.price ?? Infinity)))} to ${fmt$(Math.max(...first.map(k => k.price ?? 0)))}.`;
    });

    // fresh page for the detail-panel journey
    await page.close();
    page = await ctx.newPage();
    s = new DS(page, cfg);
    let card: Card | undefined;
    let cardTop = 0;

    await suite.run('DS-18', page, async c => {
      await s.open(c);
      await s.search(c);
      const cards = await s.cards();
      if (cards.length < 2) { c.blocked('Fewer than 2 diamonds were shown'); return; }
      c.step('Click Share with nothing ticked');
      const nd = s.dialogs.length;
      await (await visible(page.locator('#vdb_choose_pro_share_btn'))).click();
      await page.waitForTimeout(800);
      if (s.dialogs.length > nd) c.note(`(With nothing ticked it says "${s.dialogs[s.dialogs.length - 1]}".)`);
      c.step(`Tick the share box on "${cards[0].name}" and "${cards[1].name}"`);
      await page.evaluate(ids => ids.forEach(id => (document.querySelector(`label[for="shr_chkbx_grd_${id}"]`) as HTMLElement | null)?.click()), [cards[0].id, cards[1].id]);
      await page.waitForTimeout(500);
      const ticked = await page.evaluate(ids => ids.filter(id => (document.querySelector(`#shr_chkbx_grd_${id}`) as HTMLInputElement | null)?.checked).length, [cards[0].id, cards[1].id]);
      c.check(ticked === 2, `Only ${ticked} of the 2 share boxes could be ticked`);
      c.step('Click Share');
      await (await visible(page.locator('#vdb_choose_pro_share_btn'))).click();
      const form = page.locator('.vdb-question-popup, .vdb-modal-body').filter({ hasText: /Recipient/i });
      const opened = await visible(form, 10_000).then(() => true).catch(() => false);
      c.check(opened, 'No share form opened after ticking 2 diamonds and clicking Share');
      const head = opened ? (await form.locator('visible=true').first().innerText()).split('\n').map(x => x.trim()).filter(Boolean)[0] : '';
      c.actual = opened ? `The "${head}" share form opens (recipient name and email, your details). Not sent.` : '';
      await page.locator('[class*=modal]:visible [class*=close]:visible').last().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
    });

    await suite.run('DS-19', page, async c => {
      if (!(await s.cards()).length) { await s.open(c); await s.search(c); }
      await page.evaluate(() => window.scrollTo(0, 600));
      await page.waitForTimeout(600);
      const cards = await s.cards();
      card = cards[Math.min(5, cards.length - 1)];
      if (!card) { c.blocked('No result cards to open'); return; }
      cardTop = await page.evaluate(id => document.querySelector(`.vdb-search-result-block[data-prids="${id}"]`)!.getBoundingClientRect().top + window.scrollY, card.id);
      await s.openDetail(card, c);
      const panel = page.locator('.vdb-w-50.vdb-padd-right-0').locator('visible=true').first();
      const text = await panel.innerText().catch(() => '');
      const missing = ['Stock#', 'Shape', 'Carat', 'Color', 'Clarity', 'Cut', 'Polish', 'Symmetry', 'Fluorescence', 'Lab', 'Depth', 'Table', 'Girdle', 'Culet', 'Measurements', 'Ratio', 'BGM', 'Treatment']
        .filter(l => !new RegExp('(^|\\n)\\s*' + l.replace('#', '\\#') + '\\s*(\\n|$)').test(text));
      c.check(!missing.length, `These details are missing from the panel: ${missing.join(', ')}`);
      c.check(/\$\s*[\d,]+\.\d\d/.test(text), 'No price is shown');
      c.check((await page.locator('h2.vdb-short-title').locator('visible=true').count()) > 0, 'The diamond name is missing');
      const share = { email: '#single_share_btn', Facebook: '.vdb-share_with[data-social="facebook"]', Twitter: '.vdb-share_with[data-social*="twitter"], .vdb-share_with[data-social="x"]', Pinterest: '.vdb-share_with[data-social="pinterest"]', WhatsApp: '#single_whatsapp_btn' };
      const noShare: string[] = [];
      for (const [k, sel] of Object.entries(share)) if (!(await isVisible(page.locator(sel)))) noShare.push(k);
      c.check(noShare.length <= 1, `Share icons missing: ${noShare.join(', ')}`);
      if (noShare.length === 1) c.note(`(Share icon not found: ${noShare[0]}.)`);
      const imgOk = await page.locator('img.vdb-image-cover').locator('visible=true').first().evaluate(i => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0).catch(() => false);
      c.check(imgOk, 'The diamond image does not load');
      c.check(await isVisible(page.locator('a.vdb-video_url_open')), 'There is no video thumbnail');
      c.check(await isVisible(page.locator('a.vdb-open_cert_url')), 'There is no certificate thumbnail');
      c.actual = `Panel opens for ${card.name}: name, price, share icons, image, video and certificate thumbnails and all 18 details.`;
    });

    await suite.run('DS-20', page, async c => {
      const out: string[] = [];
      for (const [sel, what] of [['a.vdb-video_url_open', 'video'], ['a.vdb-open_cert_url', 'certificate']] as const) {
        c.step(`Click the ${what} thumbnail`);
        await must((await visible(page.locator(sel))).click(), `click the ${what} thumbnail`);
        const frame = page.locator('.vdb-custom-modal iframe').locator('visible=true').first();
        const shown = await frame.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
        if (!c.check(shown, `Clicking the ${what} thumbnail does not open anything`)) continue;
        const src = (await frame.getAttribute('src')) ?? '';
        let status = 0;
        try { status = (await page.request.get(src, { timeout: 20_000, maxRedirects: 5 })).status(); } catch { status = -1; }
        if (status < 0) c.note(`(The ${what} file could not be downloaded by the test: ${src}.)`);
        else c.check(status < 400, `The ${what} does not load (the file returns error ${status}): ${src}`);
        out.push(`${what} opens${status > 0 && status < 400 ? ' and loads' : ''}`);
        c.step(`Close the ${what}`);
        await page.locator('.vdb-custom-modal .vdb-close').locator('visible=true').first().click().catch(() => {});
        await page.waitForTimeout(500);
        c.check(!(await isVisible(page.locator('.vdb-custom-modal iframe'))), `The ${what} window does not close`);
      }
      c.actual = out.length ? out.join('; ').replace(/^./, x => x.toUpperCase()) + '.' : '';
    }, ['DS-19']);

    await suite.run('DS-21', page, async c => {
      if (!card) return;
      const text = await page.locator('.vdb-w-50.vdb-padd-right-0').locator('visible=true').first().innerText();
      const val = (l: string) => (text.match(new RegExp('(?:^|\\n)\\s*' + l + '\\s*\\n\\s*([^\\n]+)')) || [])[1]?.trim();
      const title = (await page.locator('h2.vdb-short-title').locator('visible=true').first().innerText()).replace(/\s+/g, ' ').trim();
      const price = money((await page.locator('.vdb-price-text').locator('visible=true').first().innerText().catch(() => '')));
      const diffs: string[] = [];
      if (title !== card.name) diffs.push(`name "${title}" vs card "${card.name}"`);
      if (price !== card.price) diffs.push(`price ${fmt$(price)} vs card ${fmt$(card.price)}`);
      if (card.shape && val('Shape') && !card.shape.startsWith(val('Shape')!.split(' ')[0])) diffs.push(`shape ${val('Shape')} vs card ${card.shape}`);
      if (card.carat && Number(val('Carat')) !== card.carat) diffs.push(`carat ${val('Carat')} vs card ${card.carat}`);
      if (card.clarity && val('Clarity') !== card.clarity) diffs.push(`clarity ${val('Clarity')} vs card ${card.clarity}`);
      if (card.color && val('Color') && !card.color.includes(val('Color')!)) diffs.push(`colour ${val('Color')} vs card ${card.color}`);
      c.check(!diffs.length, `The panel does not match the card: ${diffs.join('; ')}`);
      c.actual = diffs.length ? '' : `Shape, carat, colour, clarity and price match the card (${card.name}, ${fmt$(card.price)}).`;
    }, ['DS-19']);

    await suite.run('DS-23', page, async c => {
      c.step('Click Have a Question');
      await must((await visible(page.locator('#custom_dyn_quest_modal_open'))).click(), 'click "Have a Question"');
      const name = page.locator('input[name="vdb_haq_name"]');
      const q = await visible(name, 10_000).then(() => true).catch(() => false);
      if (c.check(q, 'Clicking "Have a Question" does not open a form')) {
        const fields = await page.$$eval('input, textarea, select', els => els.filter(e => (e as HTMLElement).offsetWidth > 0).map(e => (e as HTMLInputElement).name));
        const need = { vdb_haq_name: 'name', vdb_haq_email: 'email', vdb_haq_message: 'message' };
        const miss = Object.entries(need).filter(([k]) => !fields.includes(k)).map(([, v]) => v);
        c.check(!miss.length, `The question form has no ${miss.join(', ')} field`);
      }
      await page.locator('[class*=modal]:visible [class*=close]:visible').last().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(600);
      c.step('Click Book an Appointment');
      const before = await page.evaluate(() => [...document.querySelectorAll('input, select, textarea, iframe')].filter(e => (e as HTMLElement).offsetWidth > 0 && !/recaptcha/.test((e as HTMLIFrameElement).src ?? '')).length);
      const tabs: string[] = [];
      const onPage = (p: import('playwright').Page) => tabs.push(p.url());
      page.context().on('page', onPage);
      await must((await visible(page.getByText('Book an Appointment', { exact: true }))).click(), 'click "Book an Appointment"');
      let appt = '';
      for (let i = 0; i < 12 && !appt; i++) {
        await page.waitForTimeout(500);
        appt = await page.evaluate(n => {
          const vis = [...document.querySelectorAll('input, select, textarea, iframe')].filter(e => (e as HTMLElement).offsetWidth > 0 && !/recaptcha/.test((e as HTMLIFrameElement).src ?? ''));
          if (vis.length <= n) return '';
          const box = vis[vis.length - 1].closest('[class*=modal], [class*=popup], form') as HTMLElement | null;
          return (box?.innerText ?? 'form').replace(/\s+/g, ' ').slice(0, 300) || 'form';
        }, before);
        if (tabs.length) appt = 'tab:' + tabs[0];
      }
      page.context().off('page', onPage);
      if (c.check(!!appt, 'Clicking "Book an Appointment" shows nothing: no form or window opens')) {
        if (!appt.startsWith('tab:')) {
          c.check(/\+\d|country/i.test(appt) || (await page.locator('select:visible').count()) > 0, 'The appointment form has no phone country code');
          c.check(/time ?zone/i.test(appt), 'The appointment form has no time zone');
        }
        await page.locator('[class*=modal]:visible [class*=close]:visible').last().click({ timeout: 3000 }).catch(() => {});
      }
      c.actual = [q ? '"Have a Question" opens a form with name, email and message' : '', appt ? (appt.startsWith('tab:') ? `"Book an Appointment" opens ${appt.slice(4)}` : '"Book an Appointment" opens its form') : ''].filter(Boolean).join('; ') + (q || appt ? '. Not submitted.' : '');
    }, ['DS-19']);

    await suite.run('DS-24', page, async c => {
      if (!card) return;
      c.step('Click Close');
      await must((await visible(page.locator('#back_to_search_a'))).click(), 'click "Close" on the detail panel');
      const back = await visible(page.locator('.vdb-search-result-block'), 10_000).then(() => true).catch(() => false);
      if (!c.check(back, 'The results did not come back after closing the panel')) return;
      await page.waitForTimeout(800);
      const pos = await page.evaluate(id => { const e = document.querySelector(`.vdb-search-result-block[data-prids="${id}"]`); if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: window.innerHeight, y: window.scrollY }; }, card.id);
      c.check(!!pos, `"${card.name}" is no longer in the results`);
      if (pos) c.check(pos.bottom > 0 && pos.top < pos.h, `Back on the results but not at the same place: "${card.name}" is off screen (page scrolled to ${Math.round(pos.y)} px, the card is at ${Math.round(cardTop)} px)`);
      c.actual = pos && pos.bottom > 0 && pos.top < pos.h ? `Back on the same results with "${card.name}" still on screen.` : '';
    }, ['DS-19']);

    await suite.run('DS-22', page, async c => {
      if (!card) return;
      await s.openDetail(card, c);
      const stock = (await page.locator('.vdb-w-50.vdb-padd-right-0').locator('visible=true').first().innerText()).match(/Stock#\s*\n\s*(\S+)/)?.[1];
      c.step('Click Add To Cart');
      await must((await visible(page.locator('button.vdb-addbutton'))).click(), 'click "Add To Cart"');
      await page.waitForURL(/\/cart/, { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const cart = await page.evaluate(async () => (await fetch('/cart.js')).json()).catch(() => null) as { items: { title: string; sku: string; final_price: number }[] } | null;
      if (!cart) throw new StepError('Could not read the cart');
      const line = cart.items.find(i => (stock && i.sku === stock) || i.title.replace(/\s+/g, ' ').startsWith(card!.name));
      c.check(!!line, `The cart does not contain ${card.name}${stock ? ` (${stock})` : ''} after Add To Cart`);
      if (line) c.check(Math.abs(line.final_price / 100 - (card.price ?? 0)) < 0.01, `The cart price ${fmt$(line.final_price / 100)} differs from the diamond price ${fmt$(card.price)}`);
      c.actual = line ? `Cart shows "${line.title}" (${line.sku}) at ${fmt$(line.final_price / 100)}, same as the diamond.` : '';
    }, ['DS-19']);
  } finally { await ctx.close().catch(() => {}); }
}

function describe(d: Diamond) { return `${d.short_title ?? d.shape} (${fmt$(Number(d.total_sales_price))})`; }

export const DIAMOND_FORM = ['DS-01', 'DS-02', 'DS-03', 'DS-15', 'DS-16', 'DS-17', 'DS-04', 'DS-05'];
export const DIAMOND_FILTERS = ['DS-06', 'DS-07', 'DS-08', 'DS-09', 'DS-10', 'DS-11', 'DS-12', 'DS-25'];
export const DIAMOND_RESULTS = ['DS-13', 'DS-14', 'DS-26', 'DS-18', 'DS-19', 'DS-20', 'DS-21', 'DS-23', 'DS-24', 'DS-22'];
