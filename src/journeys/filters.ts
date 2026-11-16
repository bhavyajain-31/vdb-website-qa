// Filter-results checks: every value of every Diamond Search and Gemstone Search filter is applied,
// and every stone the store returns is checked against it (cards on screen + the data behind them).
import type { Browser, Page } from 'playwright';
import type { Config } from '../config.js';
import { Case, Suite, StepError, journeyContext, list, visible } from './harness.js';
import { DS, param, type Card, type Diamond } from './diamond.js';
import { GS, type Gem, type GemCard } from './gemstone.js';

const LAB = 'apps/vdb-app/search-filters?structure=new&diamondSearchType=Lab_grown_Diamond';
const nf = (x: number | undefined) => x == null ? '?' : x.toLocaleString('en-US');

/** Same grade written differently (EX / Excellent, VG / Very Good …). */
function canon(v: string | null | undefined): string {
  const s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const map: Record<string, string> = { ex: 'excellent', vg: 'very good', g: 'good', gd: 'good', f: 'fair', fr: 'fair', id: 'ideal', i: 'ideal', n: 'none', '': 'none', fnt: 'faint', fa: 'faint', med: 'medium', m: 'medium', stg: 'strong', st: 'strong', vst: 'very strong' };
  return map[s] ?? s;
}
const sameShape = (a?: string | null, b?: string | null) => {
  const x = String(a ?? '').toLowerCase().replace(/[^a-z]/g, ''), y = String(b ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return !!x && !!y && (x === y || x.startsWith(y.slice(0, 4)) || y.startsWith(x.slice(0, 4)));
};
/** The request value for a filter whose exact name is not known in advance (cut_data_wrap, polish…). */
const paramLike = (req: string, re: RegExp) => { for (const [k, v] of new URLSearchParams(req)) if (re.test(k)) return v; return undefined; };
const chunks = <T>(xs: T[], n: number) => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

interface DCheck {
  title: string;
  expected: string;
  url?: string;
  apply: (s: DS, c: Case) => Promise<void>;
  /** Value the request must carry, or null to skip that check. */
  sent?: (req: string) => string | null;
  ok: (d: Diamond | undefined, k: Card) => boolean;
  what: string;
}

/** Runs a list of Diamond Search filter checks on one page. */
async function runDiamondChecks(page: Page, cfg: Config, suite: Suite, prefix: string, area: string, checks: DCheck[], baseline: Record<string, number | undefined>) {
  const s = new DS(page, cfg);
  let i = 0;
  for (const ch of checks) {
    const id = suite.define({ id: `${prefix}-${String(++i).padStart(2, '0')}`, area, title: ch.title, expected: ch.expected, priority: 'P1' });
    await suite.run(id, page, async c => {
      const url = ch.url ?? 'apps/vdb-app/search-filters?structure=new';
      await s.open(c, url);
      if (baseline[url] == null) {
        // count of all diamonds (no filter), once per page type, to compare with
        baseline[url] = (await s.search(undefined, undefined, 'pressing Search without filters')).total;
        await s.open(undefined, url);
      }
      await ch.apply(s, c);
      const r = await s.search(c);
      const sentErr = ch.sent?.(r.req);
      if (sentErr) c.fail(sentErr);
      const total = r.total;
      const all = baseline[url];
      if (!total) { c.blocked(`No stock matches (0 results), so there was nothing to check`); c.actual = '0 results.'; return; }
      if (all != null) c.check(total <= all, `The filter shows more diamonds (${nf(total)}) than without any filter (${nf(all)})`);
      // check the cards on screen and every diamond the store sent for this search
      const cards = await s.cards();
      const seen = new Set<string>();
      const bad: string[] = [];
      for (const k of cards) { seen.add(k.id); if (!ch.ok(s.byId.get(k.id), k)) bad.push(k.name); }
      for (const d of r.items) if (!seen.has(String(d.id))) { seen.add(String(d.id)); if (!ch.ok(d, { id: String(d.id), name: d.short_title ?? `${d.shape} ${d.size} ${d.color ?? ''} ${d.clarity}`, cat: '' })) bad.push(d.short_title ?? `${d.shape} ${d.size} (${d.stock_num})`); }
      c.check(!bad.length, `${bad.length} of ${seen.size} diamonds returned ${ch.what}: ${list(bad)}`);
      c.actual = `${nf(total)} results (all diamonds: ${nf(all)}); ${seen.size - bad.length} of ${seen.size} diamonds checked match.`;
    });
  }
}

async function sliderValues(page: Page, cls: string): Promise<string[]> {
  return page.evaluate(cls => {
    const inp = [...document.querySelectorAll('input.' + cls)].find(i => (i.previousElementSibling as HTMLElement | null)?.offsetWidth) as HTMLInputElement | undefined;
    return inp ? ((window as any).jQuery?.(inp).data('ionRangeSlider')?.options?.values ?? []) as string[] : [];
  }, cls).catch(() => [] as string[]);
}

function sliderCheck(cls: string, label: string, vals: string[], field: (d: Diamond) => string | null, paramRe: RegExp, url?: string): DCheck {
  const from = vals[0], to = vals[vals.length - 1];
  const want = new Set(vals.map(canon));
  const span = from === to ? from : `${from} – ${to}`;
  return {
    title: `${label} ${span}${url ? ' (lab-grown)' : ''}`,
    expected: `Every diamond returned has ${label.toLowerCase()} ${vals.join(', ')}`,
    url,
    apply: (s, c) => s.slider(cls, from, to, label, c),
    sent: req => { const v = paramLike(req, paramRe); return v == null || vals.every(x => v.split(',').map(canon).includes(canon(x))) ? null : `The search was sent with ${label.toLowerCase()} "${v}" instead of ${vals.join(', ')}`; },
    ok: d => !d || want.has(canon(field(d))),
    what: `are not ${label.toLowerCase()} ${vals.join('/')}`,
  };
}

/** Diamond Search: shapes and fancy colours. */
export async function diamondShapeChecks(browser: Browser, cfg: Config, suite: Suite) {
  const ctx = await journeyContext(browser, cfg);
  const page = await ctx.newPage();
  const s = new DS(page, cfg);
  try {
    await s.open();
    const shapes = (await page.$$eval('a.vdbrb_list_item_a_shape_style', es => es.filter(e => (e as HTMLElement).offsetWidth > 0).map(e => (e as HTMLElement).innerText.trim()).filter(Boolean)));
    const fancy = (await page.$$eval('a.vdbrb_list_item_a_fancy_color_style', es => es.filter(e => !e.closest('.slick-cloned')).map(e => (e.textContent ?? '').trim()).filter(Boolean)));
    if (!shapes.length) throw new StepError('Could not read the list of shapes');
    const checks: DCheck[] = [...new Set(shapes)].map(sh => ({
      title: `Shape ${sh}`, expected: `Every diamond returned is ${sh}`,
      apply: (x, c) => x.shape(sh, c),
      sent: req => { const v = param(req, 'shape_data_wrap'); return v && !sameShape(v, sh) ? `The search was sent with shape "${v}" instead of ${sh}` : null; },
      ok: (d, k) => sameShape(d?.shape ?? k.shape, sh), what: `are not ${sh}`,
    }));
    for (const fc of [...new Set(fancy)]) checks.push({
      title: `Fancy colour ${fc}`, expected: `Every diamond returned is a fancy ${fc.toLowerCase()} diamond`,
      apply: async (x, c) => {
        c.step(`Choose fancy colour ${fc}`);
        const ok = await x.page.evaluate(fc => { const a = [...document.querySelectorAll('a.vdbrb_list_item_a_fancy_color_style')].find(e => !e.closest('.slick-cloned') && (e.textContent ?? '').trim() === fc) as HTMLElement | undefined; a?.click(); return !!a; }, fc);
        if (!ok) throw new StepError(`Could not choose the fancy colour ${fc}`);
        await x.page.waitForTimeout(300);
      },
      sent: req => { const v = param(req, 'fcolor_data_wrap'); return v && v.toLowerCase() !== fc.toLowerCase() ? `The search was sent with fancy colour "${v}" instead of ${fc}` : null; },
      ok: (d, k) => d ? new RegExp(fc, 'i').test(d.fancy_color_dominant_color ?? '') : (new RegExp(fc, 'i').test(k.name) && /fancy/i.test(k.name)),
      what: `are not fancy ${fc.toLowerCase()}`,
    });
    await runDiamondChecks(page, cfg, suite, 'DSF-A', 'Diamond Search · filter results: shape & fancy colour', checks, {});
  } finally { await ctx.close().catch(() => {}); }
}

/** Diamond Search: colour, clarity and carat bands. */
export async function diamondGradeChecks(browser: Browser, cfg: Config, suite: Suite) {
  const ctx = await journeyContext(browser, cfg);
  const page = await ctx.newPage();
  const s = new DS(page, cfg);
  try {
    await s.open();
    const colors = await sliderValues(page, 'vbdrb_white_color_web');
    const clarity = await sliderValues(page, 'vbdrb_clarity_web');
    if (!colors.length || !clarity.length) throw new StepError('Could not read the Color / Clarity values');
    const checks: DCheck[] = [
      ...chunks(colors, 3).map(v => sliderCheck('vbdrb_white_color_web', 'Color', v, d => d.color, /^color_data/)),
      ...chunks(clarity, 2).map(v => sliderCheck('vbdrb_clarity_web', 'Clarity', v, d => d.clarity, /^clarity_data/)),
      ...([[0.3, 0.69], [0.7, 0.99], [1, 1.49], [1.5, 1.99], [2, 2.99], [3, 7]] as const).map(([lo, hi]) => ({
        title: `Carat ${lo.toFixed(2)} – ${hi.toFixed(2)}`, expected: `Every diamond returned is ${lo.toFixed(2)} – ${hi.toFixed(2)} ct`,
        apply: async (x: DS, c: Case) => { await x.fill('vdbrb_min_carat_web', lo.toFixed(2), 'minimum carat', c); await x.fill('vdbrb_max_carat_web', hi.toFixed(2), 'maximum carat', c); },
        sent: (req: string) => Number(param(req, 'carat_min')) === lo && Number(param(req, 'carat_max')) === hi ? null : `The search was sent with carat ${param(req, 'carat_min')} – ${param(req, 'carat_max')} instead of ${lo.toFixed(2)} – ${hi.toFixed(2)}`,
        ok: (d: Diamond | undefined, k: Card) => { const ct = Number(d?.size ?? k.carat); return ct >= lo - 1e-9 && ct <= hi + 1e-9; },
        what: `are outside ${lo.toFixed(2)} – ${hi.toFixed(2)} ct`,
      })),
    ];
    await runDiamondChecks(page, cfg, suite, 'DSF-B', 'Diamond Search · filter results: colour, clarity & carat', checks, {});
  } finally { await ctx.close().catch(() => {}); }
}

/** Diamond Search: cut, polish, symmetry, fluorescence, budget, and lab-grown. */
export async function diamondFinishChecks(browser: Browser, cfg: Config, suite: Suite) {
  const ctx = await journeyContext(browser, cfg);
  const page = await ctx.newPage();
  const s = new DS(page, cfg);
  try {
    await s.open();
    const cut = await sliderValues(page, 'vbdrb_cut_grade_web');
    const pol = await sliderValues(page, 'vbdrb_cut_polish_web');
    const sym = await sliderValues(page, 'vbdrb_cut_symmetry_web');
    await page.locator('#vdbrb_advanced_filter').locator('visible=true').first().click().catch(() => {});
    await page.waitForTimeout(800);
    const flu = await sliderValues(page, 'vbdrb_fluorescence_web');
    const openAdv = async (x: DS) => {
      const shown = await x.page.evaluate(() => [...document.querySelectorAll('input.vbdrb_fluorescence_web')].some(i => (i.previousElementSibling as HTMLElement | null)?.offsetWidth));
      if (!shown) { await x.page.locator('#vdbrb_advanced_filter').locator('visible=true').first().click().catch(() => {}); await x.page.waitForTimeout(800); }
    };
    const checks: DCheck[] = [
      ...cut.map(v => sliderCheck('vbdrb_cut_grade_web', 'Cut Grade', [v], d => d.cut, /^cut/)),
      ...pol.map(v => sliderCheck('vbdrb_cut_polish_web', 'Polish', [v], d => d.polish, /polish/)),
      ...sym.map(v => sliderCheck('vbdrb_cut_symmetry_web', 'Symmetry', [v], d => d.symmetry, /symm/)),
      ...flu.map(v => { const ch = sliderCheck('vbdrb_fluorescence_web', 'Fluorescence', [v], d => d.fluor_intensity, /flour|fluor/); const a = ch.apply; ch.apply = async (x, c) => { await openAdv(x); await a(x, c); }; return ch; }),
      ...([[0, 200], [200, 1000], [1000, 10000], [10000, 999999]] as const).map(([lo, hi]) => ({
        title: `Budget $${lo.toLocaleString('en-US')} – $${hi.toLocaleString('en-US')}`, expected: `Every diamond returned is priced $${lo.toLocaleString('en-US')} – $${hi.toLocaleString('en-US')}`,
        apply: async (x: DS, c: Case) => { await x.fill('vdbrb_min_budget_web', String(lo), 'minimum budget', c); await x.fill('vdbrb_max_budget_web', String(hi), 'maximum budget', c); },
        sent: (req: string) => Number(param(req, 'budget_min')) === lo && Number(param(req, 'budget_max')) === hi ? null : `The search was sent with budget ${param(req, 'budget_min')} – ${param(req, 'budget_max')} instead of ${lo} – ${hi}`,
        ok: (d: Diamond | undefined, k: Card) => { const p = Number(d?.total_sales_price ?? k.price); return p >= lo && p <= hi; },
        what: `are priced outside $${lo.toLocaleString('en-US')} – $${hi.toLocaleString('en-US')}`,
      })),
      // the same filters on the Lab-Grown tab
      { title: 'Shape Round (lab-grown)', expected: 'Every lab-grown diamond returned is Round', url: LAB, apply: (x, c) => x.shape('Round', c), ok: (d, k) => sameShape(d?.shape ?? k.shape, 'Round') && d?.lab_grown !== false, what: 'are not lab-grown Round' },
      ...(await (async () => { const v = await sliderValues(page, 'vbdrb_white_color_web'); return v.length ? [sliderCheck('vbdrb_white_color_web', 'Color', v.slice(0, 3), d => d.color, /^color_data/, LAB)] : []; })()),
    ];
    await runDiamondChecks(page, cfg, suite, 'DSF-C', 'Diamond Search · filter results: cut, polish, symmetry, fluorescence, budget & lab-grown', checks, {});
  } finally { await ctx.close().catch(() => {}); }
}

// ------------------------------------------------------------------ gemstones

interface GCheck { title: string; expected: string; gem: string; apply: (s: GS, c: Case) => Promise<unknown>; ok: (g: Gem | undefined, k: GemCard) => boolean; what: string }

export async function gemstoneFilterChecks(browser: Browser, cfg: Config, suite: Suite) {
  const ctx = await journeyContext(browser, cfg);
  const page = await ctx.newPage();
  const s = new GS(page, cfg);
  const area = 'Gemstone Search · filter results';
  try {
    await s.open(undefined, 'Sapphire');
    const types = await page.$$eval('.vdbgem_type[data-value]', es => [...new Set(es.filter(e => (e as HTMLElement).offsetWidth > 0).map(e => e.getAttribute('data-value')!).filter(Boolean))]);
    const opts = async (section: string) => { const body = await s.section(section); return [...new Set((await body.locator('li').allInnerTexts()).map(t => t.trim()).filter(Boolean))]; };
    const shapes = await opts('Shape').catch(() => [] as string[]);
    const labs = await opts('Lab').catch(() => [] as string[]);
    const sapphireAll = await s.count();
    const checks: GCheck[] = [
      ...types.map(t => ({
        title: `Type ${t}`, expected: `Every gemstone returned is ${t}`, gem: 'Ruby',
        // the page opens on Ruby, so Ruby is checked as it is; other types are clicked
        apply: async (x: GS, c: Case) => t === 'Ruby' ? undefined : x.apply(c, `Choose ${t}`, async () => (await visible(x.page.locator(`.vdbgem_type[data-value="${t}"]`))).click()),
        ok: (g: Gem | undefined, k: GemCard) => g ? g.gem_type.toLowerCase() === t.toLowerCase() : new RegExp(t, 'i').test(k.name), what: `are not ${t}`,
      })),
      ...shapes.map(sh => ({
        title: `Shape ${sh} (Sapphire)`, expected: `Every sapphire returned is ${sh}`, gem: 'Sapphire',
        apply: (x: GS, c: Case) => x.apply(c, `Tick shape ${sh}`, () => x.tick('Shape', sh)),
        ok: (g: Gem | undefined, k: GemCard) => sameShape(g?.shape ?? k.name.split(' ')[0], sh), what: `are not ${sh}`,
      })),
      ...([[0.5, 0.99], [1, 1.99], [2, 5]] as const).map(([lo, hi]) => ({
        title: `Carat ${lo.toFixed(2)} – ${hi.toFixed(2)} (Sapphire)`, expected: `Every sapphire returned is ${lo.toFixed(2)} – ${hi.toFixed(2)} ct`, gem: 'Sapphire',
        apply: async (x: GS, c: Case) => { await x.apply(c, `Enter carat from ${lo.toFixed(2)}`, () => x.type('Carat', 'vdbgem_carat_min', lo.toFixed(2))); await x.apply(c, `Enter carat to ${hi.toFixed(2)}`, () => x.type('Carat', 'vdbgem_carat_max', hi.toFixed(2))); },
        ok: (g: Gem | undefined, k: GemCard) => { const ct = Number(g?.size ?? k.name.match(/(\d+(?:\.\d+)?)ct/i)?.[1]); return ct >= lo - 1e-9 && ct <= hi + 1e-9; }, what: `are outside ${lo.toFixed(2)} – ${hi.toFixed(2)} ct`,
      })),
      ...([[0, 300], [300, 1000], [1000, 100000]] as const).map(([lo, hi]) => ({
        title: `Price $${lo.toLocaleString('en-US')} – $${hi.toLocaleString('en-US')} (Sapphire)`, expected: `Every sapphire returned is priced $${lo.toLocaleString('en-US')} – $${hi.toLocaleString('en-US')}`, gem: 'Sapphire',
        apply: async (x: GS, c: Case) => { await x.apply(c, `Enter price from ${lo}`, () => x.type('Price', 'vdbgem_price_min', String(lo))); await x.apply(c, `Enter price to ${hi}`, () => x.type('Price', 'vdbgem_price_max', String(hi))); },
        ok: (g: Gem | undefined, k: GemCard) => { const p = Number(g?.total_sales_price ?? k.price); return p >= lo && p <= hi; }, what: `are priced outside $${lo.toLocaleString('en-US')} – $${hi.toLocaleString('en-US')}`,
      })),
      ...labs.map(l => ({
        title: `Lab ${l} (Sapphire)`, expected: `Every sapphire returned is certified by ${l}`, gem: 'Sapphire',
        apply: (x: GS, c: Case) => x.apply(c, `Tick lab ${l}`, () => x.tick('Lab', l)),
        ok: (g: Gem | undefined) => !g || (g.lab ?? '').toUpperCase() === l.toUpperCase(), what: `are not ${l} certified`,
      })),
    ];
    let i = 0;
    for (const ch of checks) {
      const id = suite.define({ id: `GSF-${String(++i).padStart(2, '0')}`, area, title: ch.title, expected: ch.expected, priority: 'P1' });
      await suite.run(id, page, async c => {
        await s.open(c, ch.gem);
        await ch.apply(s, c);
        const total = await s.count();
        if (!total) { c.blocked('No stock matches (0 results), so there was nothing to check'); c.actual = '0 results.'; return; }
        if (ch.gem === 'Sapphire' && sapphireAll != null && !/^Type/.test(ch.title)) c.check(total <= sapphireAll, `The filter shows more sapphires (${nf(total)}) than without it (${nf(sapphireAll)})`);
        const cards = await s.cards();
        const bad = cards.filter(k => !ch.ok(s.byId.get(k.id), k));
        c.check(!bad.length, `${bad.length} of ${cards.length} gemstones shown ${ch.what}: ${list(bad.map(b => b.name))}`);
        c.actual = `${nf(total)} results; ${cards.length - bad.length} of ${cards.length} gemstones shown match.`;
      });
    }
  } finally { await ctx.close().catch(() => {}); }
}
