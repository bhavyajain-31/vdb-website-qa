/**
 * In-page links (href="#…"), e.g. CUSTOM DESIGN in the header, which opens the Typeform popup
 * "DESIGN YOUR DREAM RING". Clicking must either open a working popup or jump to a section.
 *
 * Popup checks: it opens · it has content (heading/text and a button) · its images load and display ·
 * its main button responds (e.g. START DESIGNING shows the first question) · it can be closed.
 */
import type { Browser, BrowserContext, Frame, Page } from 'playwright';
import type { Config } from './config.js';
import { dismissPopups, gotoSettled, newContext, scrollThrough } from './browser.js';
import type { Check, DiscoveredLink, Validation } from './types.js';

interface Inside { title: string; textLen: number; buttons: string[]; imgs: { src: string; ok: boolean; why?: string }[] }

async function readInside(target: Page | Frame, rootSel: string | null): Promise<Inside> {
  return target.evaluate(async (rootSel) => {
    const root = (rootSel ? document.querySelector(rootSel) : document.body) as HTMLElement | null;
    if (!root) return { title: '', textLen: 0, buttons: [], imgs: [] };
    const vis = (e: Element) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const h = [...root.querySelectorAll('h1, h2, h3, [data-qa="question-header"], [class*="title"]')].find(x => vis(x) && (x as HTMLElement).innerText.trim()) as HTMLElement | undefined;
    const text = (root.innerText || '').replace(/\s+/g, ' ').trim();
    const buttons = [...root.querySelectorAll('button, a[href], [role="button"]')].filter(vis).map(b => ((b as HTMLElement).innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()).filter(t => t && t.length < 60);
    const imgs: { src: string; ok: boolean; why?: string }[] = [];
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    for (const img of [...root.querySelectorAll('img')] as HTMLImageElement[]) {
      if (!vis(img)) continue;
      const until = Date.now() + 8000;
      while (!img.complete && Date.now() < until) await sleep(150);
      let why: string | undefined;
      if (!img.complete) why = 'did not finish loading';
      else if (!img.naturalWidth) why = 'did not display (broken file)';
      else { try { await img.decode(); } catch { why = 'not a valid image'; } }
      imgs.push({ src: img.currentSrc || img.src, ok: !why, why });
    }
    return { title: (h?.innerText || text.slice(0, 60)).replace(/\s+/g, ' ').trim().slice(0, 80), textLen: text.length, buttons: [...new Set(buttons)].slice(0, 8), imgs };
  }, rootSel).catch(() => ({ title: '', textLen: 0, buttons: [], imgs: [] }));
}

export async function popupTest(browser: Browser, link: DiscoveredLink, cfg: Config, v: Validation, ctxRef: { ctx?: BrowserContext }): Promise<Check[]> {
  const checks: Check[] = [];
  const ctx = await newContext(browser, cfg);
  ctxRef.ctx = ctx;
  const page = await ctx.newPage();
  try {
    await gotoSettled(page, link.sourceUrl, cfg);
    await dismissPopups(page);
    if (link.depth > 0) await scrollThrough(page);
    const el = page.locator(`a[href="${link.rawHref.replace(/"/g, '\\"')}"]`).filter({ visible: true }).first();
    if (!(await el.count())) {
      checks.push({ name: 'Popup opens', status: 'BLOCKED', mandatory: true, detail: 'The link is not visible on its page any more' });
      return checks;
    }
    const before = await page.evaluate(() => ({
      frames: [...document.querySelectorAll('iframe')].filter(f => (window as any).__qaVis(f)).length,
      y: window.scrollY,
      text: ((document.querySelector('main') || document.body) as HTMLElement).innerText.replace(/\s+/g, ' '),
    }));
    await el.click({ timeout: 5000 }).catch(() => el.evaluate((a: HTMLElement) => a.click()));
    // wait for a popup iframe, a dialog, or a jump
    let kind: 'iframe' | 'dialog' | 'jump' | 'tab' | null = null;
    const until = Date.now() + 8000;
    while (!kind && Date.now() < until) {
      await page.waitForTimeout(300);
      kind = await page.evaluate((b) => {
        const vis = (window as any).__qaVis as (e: Element) => boolean;
        const big = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 250 && r.height > 200; };
        if ([...document.querySelectorAll('iframe')].filter(f => vis(f) && big(f)).length > b.frames) return 'iframe';
        if ([...document.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal, [class*="popup"]')].some(d => vis(d) && big(d) && !d.closest('.contact-popup--wrapper'))) return 'dialog';
        if (Math.abs(window.scrollY - b.y) > 50) return 'jump';
        // tabs / accordions: the visible content of the page changes
        const now = ((document.querySelector('main') || document.body) as HTMLElement).innerText.replace(/\s+/g, ' ');
        if (now !== b.text && Math.abs(now.length - b.text.length) + (now.slice(0, 2000) !== b.text.slice(0, 2000) ? 50 : 0) > 30) return 'tab';
        return null;
      }, before).catch(() => null);
    }
    if (!kind) {
      checks.push({ name: 'Popup opens', status: 'FAIL', mandatory: true, detail: 'Clicking it does nothing: no popup opens, the page does not move and nothing on it changes' });
      v.screenshot = await page.screenshot({ path: `${cfg.outDir}/screenshots/${link.id}.jpg`, type: 'jpeg', quality: 55 }).then(() => `screenshots/${link.id}.jpg`).catch(() => undefined);
      return checks;
    }
    // embedded forms (Typeform) show their wrapper first and the iframe a moment later
    if (kind === 'dialog') {
      for (let i = 0; i < 10 && kind === 'dialog'; i++) {
        await page.waitForTimeout(400);
        const hasFrame = await page.evaluate(() => [...document.querySelectorAll('iframe')].some(f => (window as any).__qaVis(f) && f.getBoundingClientRect().width > 250)).catch(() => false);
        if (hasFrame) kind = 'iframe';
      }
    }
    if (kind === 'jump' || kind === 'tab') {
      checks.push({ name: 'Popup opens', status: 'PASS', mandatory: true, detail: kind === 'jump' ? 'Jumps to a section of the page (no popup expected)' : 'Switches the content shown on the page (tab)' });
      return checks;
    }

    // read what the popup shows
    let inside: Inside;
    let frame: Frame | null = null;
    if (kind === 'iframe') {
      const handle = await page.evaluateHandle(() => [...document.querySelectorAll('iframe')].filter(f => (window as any).__qaVis(f)).sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0]);
      frame = await handle.asElement()?.contentFrame() ?? null;
      const src = await handle.evaluate(f => (f as HTMLIFrameElement).src).catch(() => '');
      if (frame) {
        await frame.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
        for (let i = 0; i < 30; i++) { if (((await frame.evaluate(() => document.body?.innerText.length ?? 0).catch(() => 0)) as number) > 20) break; await page.waitForTimeout(400); }
        await page.waitForTimeout(800);
      }
      inside = frame ? await readInside(frame, null) : { title: '', textLen: 0, buttons: [], imgs: [] };
      checks.push({ name: 'Popup opens', status: 'PASS', mandatory: true, detail: `Opens a popup${src ? ` (${new URL(src).host})` : ''}` });
    } else {
      await page.evaluate(() => { const d = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal, [class*="popup"]')].find(d => (window as any).__qaVis(d) && !d.closest('.contact-popup--wrapper')); d?.setAttribute('data-qa-popup', '1'); });
      inside = await readInside(page, '[data-qa-popup="1"]');
      checks.push({ name: 'Popup opens', status: 'PASS', mandatory: true, detail: 'Opens a popup' });
    }
    v.pageTitle = inside.title;
    v.screenshot = await page.screenshot({ path: `${cfg.outDir}/screenshots/${link.id}.jpg`, type: 'jpeg', quality: 55 }).then(() => `screenshots/${link.id}.jpg`).catch(() => undefined);

    const hasContent = inside.textLen > 20 && inside.buttons.length > 0;
    checks.push({
      name: 'Popup content', status: hasContent ? 'PASS' : 'FAIL', mandatory: true,
      detail: hasContent ? `Shows "${inside.title}" with button${inside.buttons.length > 1 ? 's' : ''} ${inside.buttons.slice(0, 3).map(b => `"${b}"`).join(', ')}` : 'The popup is empty or has no button (content did not load)',
    });
    if (inside.imgs.length) {
      const bad = inside.imgs.filter(i => !i.ok);
      checks.push({ name: 'Popup images', status: bad.length ? 'FAIL' : 'PASS', mandatory: true, detail: bad.length ? bad.map(b => `${b.src.slice(0, 80)} ${b.why}`).join('; ') : `${inside.imgs.length} image${inside.imgs.length > 1 ? 's' : ''} load and display` });
      v.images = inside.imgs.map(i => ({ pageUrl: link.sourceUrl, src: i.src, status: i.ok ? 'PASS' as const : 'FAIL' as const, reason: i.why, kind: 'img' as const, position: `Popup: ${inside.title}` }));
    }

    // main button: starting the form must show something new (nothing is submitted)
    const start = inside.buttons.find(b => /^(start|begin|let'?s go|next|continue|get started)/i.test(b));
    if (start && (frame ?? page)) {
      const target = frame ?? page;
      const t0 = await target.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 400)).catch(() => '');
      await target.getByText(start, { exact: false }).first().click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(2000);
      const t1 = await target.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 400)).catch(() => '');
      checks.push({ name: 'Popup button works', status: t1 && t1 !== t0 ? 'PASS' : 'FAIL', mandatory: true, detail: t1 && t1 !== t0 ? `"${start}" moves on to the next step` : `Clicking "${start}" did not change anything` });
    }

    // close control
    const closed = await (async () => {
      const close = page.locator('[aria-label*="close" i], .tf-v1-close, [class*="close"]').filter({ visible: true }).first();
      if (await close.count()) await close.click({ timeout: 3000 }).catch(() => close.evaluate((x: HTMLElement) => x.click()));
      else await page.keyboard.press('Escape');
      await page.waitForTimeout(1200);
      return page.evaluate((kind) => kind === 'iframe'
        ? ![...document.querySelectorAll('iframe')].some(f => (window as any).__qaVis(f) && f.getBoundingClientRect().width > 250)
        : !document.querySelector('[data-qa-popup="1"]') || !(window as any).__qaVis(document.querySelector('[data-qa-popup="1"]')), kind).catch(() => false);
    })();
    checks.push({ name: 'Popup closes', status: closed ? 'PASS' : 'FAIL', mandatory: true, severity: 'minor', detail: closed ? 'The close (×) button closes it' : 'The popup could not be closed with its close button or Esc' });
    return checks;
  } finally {
    await ctx.close().catch(() => {});
  }
}
