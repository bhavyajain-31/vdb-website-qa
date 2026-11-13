import fs from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, Locator, Page, Response } from 'playwright';
import type { Config } from '../config.js';
import { newContext } from '../browser.js';
import type { Status } from '../types.js';
import { CASES } from './catalog.js';
import type { CaseDef, CaseResult } from './types.js';

/** Raised for a step the test could not carry out (element missing, page never answered). Reported as "Couldn't verify". */
export class StepError extends Error {}

/** Case-level timeout (ms). */
const CASE_MS = 120_000;

export class Case {
  status: Status = 'PASS';
  reasons: string[] = [];
  notes: string[] = [];
  log: string[] = [];
  actual = '';
  url?: string;
  constructor(public def: CaseDef) {}
  step(s: string) { this.log.push(s); }
  /** A real problem a shopper would see. */
  fail(msg: string) { this.status = 'FAIL'; if (!this.reasons.includes(msg)) this.reasons.push(msg); }
  check(ok: boolean, msg: string): boolean { if (!ok) this.fail(msg); return ok; }
  /** Works, but something is worth a look. */
  warn(msg: string) { if (this.status === 'PASS') this.status = 'WARN'; this.reasons.push(msg); }
  /** The test could not decide (no data to check, page never answered). */
  blocked(msg: string) { if (this.status !== 'FAIL') this.status = 'BLOCKED'; this.reasons.push(msg); }
  note(msg: string) { this.notes.push(msg); }
}

export class Suite {
  results = new Map<string, CaseResult>();
  constructor(public cfg: Config) {
    fs.mkdirSync(path.join(cfg.outDir, 'screenshots'), { recursive: true });
  }

  def(id: string): CaseDef {
    const d = CASES.find(c => c.id === id);
    if (!d) throw new Error(`Unknown test case ${id}`);
    return d;
  }

  ok(id: string) { const s = this.results.get(id)?.status; return s === 'PASS' || s === 'WARN'; }

  /**
   * Runs one test case. `needs`: earlier cases on the same page that must have worked
   * (otherwise this one is reported as "Couldn't verify" instead of a misleading failure).
   */
  async run(id: string, page: Page | null, fn: (c: Case) => Promise<void>, needs: string[] = []): Promise<Case> {
    const c = new Case(this.def(id));
    const t0 = Date.now();
    const at = new Date().toISOString();
    const missing = needs.filter(n => !this.ok(n));
    if (missing.length) {
      c.blocked(`Needs ${missing.join(', ')} to work first, so this could not be checked`);
    } else {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          fn(c),
          new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new StepError('The page did not respond within 2 minutes')), CASE_MS); }),
        ]);
      } catch (e) {
        const msg = e instanceof StepError ? e.message : `Unexpected problem while testing: ${String((e as Error).message ?? e).split('\n')[0].slice(0, 160)}`;
        if (c.status === 'FAIL') c.reasons.push(msg); else c.blocked(msg);
      } finally { clearTimeout(timer); }
    }
    let shot: string | undefined;
    if (page && (c.status === 'FAIL' || c.status === 'BLOCKED') && !missing.length) {
      shot = `screenshots/case-${id}.jpg`;
      await page.screenshot({ path: path.join(this.cfg.outDir, shot), type: 'jpeg', quality: 55, timeout: 10_000 }).catch(() => { shot = undefined; });
    }
    const actual = c.actual || (c.status === 'PASS' ? 'As expected' : '');
    this.results.set(id, {
      id, area: c.def.area, title: c.def.title, steps: c.def.steps, expected: c.def.expected, priority: c.def.priority, known: c.def.known,
      status: c.status, actual: [actual, ...c.notes].filter(Boolean).join(' '), reasons: c.reasons, log: c.log,
      url: c.url ?? (page ? short(page.url(), this.cfg) : undefined), screenshot: shot, ms: Date.now() - t0, testedAt: at,
    });
    const icon = { PASS: '✓', WARN: '!', FAIL: '✗', BLOCKED: '?', PENDING: '·', SKIPPED: '-' }[c.status];
    console.log(`  ${icon} ${id} ${c.def.title}${c.reasons.length ? ' — ' + c.reasons[0] : ''}`);
    return c;
  }

  /** Cases of a group that never got to run (group crashed or time ran out). */
  markNotRun(ids: string[], why: string) {
    for (const id of ids) if (!this.results.has(id)) {
      const d = this.def(id);
      this.results.set(id, {
        id, area: d.area, title: d.title, steps: d.steps, expected: d.expected, priority: d.priority, known: d.known,
        status: 'BLOCKED', actual: '', reasons: [why], log: [], ms: 0, testedAt: new Date().toISOString(),
      });
    }
  }
}

export function short(u: string, cfg: Config) { return u.startsWith(cfg.baseUrl) ? '/' + u.slice(cfg.baseUrl.length) : u; }

/** A browser session for journey tests: animations off, auto-opening contact popup hidden, native alerts recorded. */
export async function journeyContext(browser: Browser, cfg: Config): Promise<BrowserContext> {
  const ctx = await newContext(browser, cfg, true);
  // the "Want to speak to our team?" popup opens by itself after ~10 s and would cover what we click (tested separately in FM-02)
  await ctx.addInitScript(`document.addEventListener('DOMContentLoaded', function () { var s = document.createElement('style'); s.textContent = '#boxes,.contact-popup--wrapper,.contact-popup--overlay{display:none!important}'; document.head.appendChild(s); });`);
  return ctx;
}

/** Native alert() texts seen on a page (they are dismissed automatically). */
export function watchDialogs(page: Page): string[] {
  const seen: string[] = [];
  page.on('dialog', d => { seen.push(d.message()); d.dismiss().catch(() => {}); });
  return seen;
}

/** Runs a step the test needs; if it cannot be done, the case becomes "Couldn't verify" with this wording. */
export async function must<T>(p: Promise<T>, what: string): Promise<T> {
  try { return await p; } catch { throw new StepError(`Could not ${what}`); }
}

export async function visible(l: Locator, ms = 15_000): Promise<Locator> {
  const f = l.locator('visible=true').first();
  await f.waitFor({ state: 'visible', timeout: ms });
  return f;
}

export async function isVisible(l: Locator): Promise<boolean> {
  return (await l.locator('visible=true').count().catch(() => 0)) > 0;
}

export function money(s: string | null | undefined): number | undefined {
  const m = String(s ?? '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : undefined;
}

export function fmt$(n: number | undefined) { return n == null ? '–' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

export function list(xs: string[], n = 3) { return xs.length <= n ? xs.join('; ') : xs.slice(0, n).join('; ') + ` (+${xs.length - n} more)`; }

/** Waits for a response matching `pred` while `action` runs. */
export async function during(page: Page, pred: (r: Response) => boolean, action: () => Promise<unknown>, what: string, ms = 30_000): Promise<Response> {
  const wait = page.waitForResponse(pred, { timeout: ms });
  wait.catch(() => {});
  await action();
  try { return await wait; } catch { throw new StepError(`Could not get results after ${what} (the store did not answer in ${ms / 1000} s)`); }
}

/**
 * Sets an Ion range slider (the store's Color / Clarity / Cut sliders) by dragging its handles like a shopper.
 * Values are the labels shown under the slider (e.g. "G" to "H").
 */
export async function setSlider(page: Page, cls: string, from: string, to: string, label: string): Promise<void> {
  const geo = async () => page.evaluate((cls) => {
    const inp = [...document.querySelectorAll('input.' + cls)].find(i => (i.previousElementSibling as HTMLElement | null)?.offsetWidth) as HTMLInputElement | undefined;
    if (!inp) return null;
    inp.scrollIntoView({ block: 'center' });
    const irs = inp.previousElementSibling as HTMLElement;
    const line = irs.querySelector('.irs-line')!.getBoundingClientRect();
    const f = irs.querySelector('.irs-handle.from')!.getBoundingClientRect();
    const t = irs.querySelector('.irs-handle.to')!.getBoundingClientRect();
    const o = (window as any).jQuery?.(inp).data('ionRangeSlider')?.options ?? {};
    return { l: line.left, w: line.width, fx: f.left + f.width / 2, fy: f.top + f.height / 2, tx: t.left + t.width / 2, ty: t.top + t.height / 2, values: (o.values ?? []) as string[], min: Number(o.min ?? 0), max: Number(o.max ?? 0), value: inp.value };
  }, cls);
  let g = await geo();
  if (!g || !g.values.length) throw new StepError(`Could not find the ${label} slider`);
  const fi = g.values.indexOf(from), ti = g.values.indexOf(to);
  if (fi < 0 || ti < 0) throw new StepError(`The ${label} slider has no "${fi < 0 ? from : to}" option (it offers ${g.values.join(', ')})`);
  const X = (i: number) => g!.l + (i - g!.min) / (g!.max - g!.min || 1) * g!.w;
  await page.mouse.move(g.tx, g.ty); await page.mouse.down(); await page.mouse.move(X(ti), g.ty, { steps: 10 }); await page.mouse.up();
  await page.waitForTimeout(250);
  g = (await geo())!;
  if (fi > 0) { await page.mouse.move(g.fx, g.fy); await page.mouse.down(); await page.mouse.move(X(fi), g.fy, { steps: 10 }); await page.mouse.up(); await page.waitForTimeout(250); }
  const v = (await geo())!.value;
  if (v !== `${from},${to}`) throw new StepError(`Could not set the ${label} slider to ${from} – ${to} (it shows ${v || 'nothing'})`);
}
