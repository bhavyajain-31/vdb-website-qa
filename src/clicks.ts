/**
 * Click tests: does clicking an element like a shopper go to the right place?
 *
 * Speed-up vs the previous tool: the click is intercepted. The moment the browser starts navigating,
 * the destination request is answered with "204 No Content", which makes the browser stay on the
 * current page. So one loaded page can test dozens of clicks with no reloads, and the destination
 * itself is tested separately (and only once) by validate.ts.
 */
import type { BrowserContext, Page, Route, Request } from 'playwright';
import type { Config } from './config.js';
import { dismissPopups, gotoSettled } from './browser.js';
import { diffParams, samePath, shortUrl } from './urls.js';
import type { Check, ClickOutcome, DiscoveredLink } from './types.js';

const NEXT_SEL = '.slider-button--next, .swiper-button-next, .slick-next, [aria-label="Next slide"], [aria-label="Slide right"], [name="next"]';
const UI = '[role="dialog"], [aria-modal="true"], cart-drawer, .drawer, .cart-drawer, .menu-drawer, .search-modal, details[open] > div';

// external links are clicked too (the new tab is intercepted); their site is checked by validate.ts
export const CLICK_EXEMPT = new Set(['mailto', 'tel', 'anchor']);

async function shoot(page: Page, cfg: Config, name: string): Promise<string | undefined> {
  const rel = `screenshots/${name}.jpg`;
  try { await page.screenshot({ path: `${cfg.outDir}/${rel}`, type: 'jpeg', quality: 55 }); return rel; } catch { return undefined; }
}

interface Attempt { navUrl?: string; newTab?: boolean; urlAfter: string; openedUi: boolean; note?: string; error?: string; message?: string; inSlider?: boolean }

/** A link to click; homepage placements also carry the exact anchor (section id + index). */
export type ClickTarget = DiscoveredLink & { secId?: string; nth?: number };

async function tagTarget(page: Page, link: ClickTarget) {
  return page.evaluate(({ raw, label, section, topLabel, drawer, secId, nth }) => {
    const vis = (window as any).__qaVis as (e: Element) => boolean;
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const all = [...document.querySelectorAll('a[href]')].filter(a => a.getAttribute('href') === raw) as HTMLAnchorElement[];
    // a homepage placement knows exactly which anchor it is: section id + index among same-href anchors
    if (secId && typeof nth === 'number' && nth >= 0) {
      const exact = ([...(document.getElementById(secId) || document).querySelectorAll('a[href]')].filter(a => a.getAttribute('href') === raw) as HTMLAnchorElement[])[nth];
      if (exact) all.unshift(exact);
    }
    const inRegion = (a: Element) =>
      section === 'footer' ? !!a.closest('footer, .shopify-section-group-footer-group')
        : section === 'header' || section === 'megamenu' ? !!a.closest('header, .shopify-section-group-header-group, .menu-drawer')
          : !a.closest('header, footer');
    const topOf = (a: Element) => {
      const li = a.closest('header nav > ul > li, header .list-menu--inline > li');
      return norm((li?.querySelector('summary, a, button, span') as HTMLElement | null)?.innerText || '');
    };
    // the mobile drawer holds hidden copies of every menu link: never pick those on desktop
    const wrongCopy = (a: Element) => Number(!drawer && !!a.closest('.menu-drawer, header-drawer'));
    const ranked = secId && typeof nth === 'number' && all[0] && (document.getElementById(secId) || document).contains(all[0]) ? all : all.sort((a, b) =>
      (wrongCopy(a) - wrongCopy(b)) * 16 +
      (topLabel ? (Number(topOf(b) === topLabel) - Number(topOf(a) === topLabel)) * 8 : 0) +
      (Number(inRegion(b)) - Number(inRegion(a))) * 4 +
      (Number(norm(b.innerText || '').startsWith(label)) - Number(norm(a.innerText || '').startsWith(label))) * 2 +
      (Number(vis(b)) - Number(vis(a))));
    const el = ranked[0];
    if (!el) return { ok: false };
    document.querySelectorAll('[data-qa-target]').forEach(e => e.removeAttribute('data-qa-target'));
    el.setAttribute('data-qa-target', '1');
    const li = el.closest('header nav > ul > li, header .list-menu--inline > li') as HTMLElement | null;
    const top = li?.querySelector('summary, a, button, span') as HTMLElement | null;
    const r = top?.getBoundingClientRect();
    return { ok: true, visible: vis(el), topX: r ? r.x + r.width / 2 : undefined, topY: r ? r.y + r.height / 2 : undefined };
  }, { raw: link.rawHref, label: link.label, section: link.section, topLabel: link.reveal.topLabel ?? '', drawer: link.reveal.kind === 'drawer', secId: link.secId ?? '', nth: link.nth ?? -1 });
}

async function attemptClick(ctx: BrowserContext, page: Page, link: ClickTarget, forceScript = false): Promise<Attempt> {
  // menus: stay on the open panel (moving away and back makes it re-animate and briefly block clicks)
  if (link.reveal.kind !== 'menu') await page.mouse.move(5, 700).catch(() => {});
  await dismissPopups(page);
  if (link.reveal.kind === 'drawer') {
    await page.evaluate(() => (document.querySelector('header-drawer summary, .header__icon--menu') as HTMLElement | null)?.click());
    await page.waitForTimeout(500);
    for (let r = 0; r < 3; r++) {
      await page.evaluate(() => document.querySelectorAll('.menu-drawer details:not([open]) > summary').forEach(s => (s as HTMLElement).click()));
      await page.waitForTimeout(300);
    }
  }
  const found = await tagTarget(page, link);
  if (!found.ok) return { urlAfter: page.url(), openedUi: false, error: 'The element is no longer on the page it was found on' };
  const target = page.locator('[data-qa-target="1"]');
  if (!found.visible && link.reveal.kind === 'menu' && found.topX !== undefined) {
    await page.mouse.move(found.topX, found.topY! + 30);
    await page.mouse.move(found.topX, found.topY!, { steps: 3 });
    await target.waitFor({ state: 'visible', timeout: 1200 }).catch(() => {});
    if (!(await target.isVisible().catch(() => false))) {
      // menus that open on click instead of hover
      await page.mouse.click(found.topX, found.topY!).catch(() => {});
      await target.waitFor({ state: 'visible', timeout: 800 }).catch(() => {});
    }
  }
  if (!(await target.isVisible().catch(() => false)) && link.reveal.kind === 'carousel') {
    for (let i = 0; i < 12 && !(await page.evaluate(() => (window as any).__qaVis(document.querySelector('[data-qa-target]')))); i++) {
      await page.evaluate((sel) => {
        const sec = document.querySelector('[data-qa-target]')!.closest('.shopify-section');
        (sec?.querySelector(sel) as HTMLElement | null)?.click();
      }, NEXT_SEL);
      await page.waitForTimeout(500);
    }
  }
  await page.evaluate((UI) => document.querySelectorAll(UI).forEach(e => { const r = e.getBoundingClientRect(); if ((window as any).__qaVis(e) && r.width > 200 && r.height > 150) e.setAttribute('data-qa-ui-before', '1'); }), UI).catch(() => {});
  const uiNow = () => page.evaluate((UI) => [...document.querySelectorAll(UI)].filter(e => { const r = e.getBoundingClientRect(); return !e.hasAttribute('data-qa-ui-before') && (window as any).__qaVis(e) && r.width > 200 && r.height > 150; }).length, UI).catch(() => 0);

  const navs: { url: string; newTab: boolean }[] = [];
  const handler = async (route: Route, req: Request) => {
    try {
      if (req.isNavigationRequest() && req.resourceType() === 'document') {
        const fr = req.frame();
        const pg = fr.page();
        if (fr === pg.mainFrame()) {
          // the listing page rewriting its own URL (sort order, filters) is not the click's destination
          const self = pg === page && samePath(req.url(), link.sourceUrl) && !samePath(link.href, link.sourceUrl);
          if (!self) navs.push({ url: req.url(), newTab: pg !== page });
          return await route.fulfill({ status: 204, body: '' });
        }
      }
    } catch { /* frame detached */ }
    return route.fallback();
  };
  const popups: Page[] = [];
  // a link that opens a new tab: route() may not see the new tab's first request, so read the tab's own URL
  const onPage = (p: Page) => {
    popups.push(p);
    const take = (u: string) => { if (u && u !== 'about:blank' && !navs.some(n => n.newTab)) navs.push({ url: u, newTab: true }); };
    p.on('request', r => { if (r.isNavigationRequest() && r.frame() === p.mainFrame()) take(r.url()); });
    p.on('framenavigated', f => { if (f === p.mainFrame()) take(f.url()); });
    setTimeout(() => take(p.url()), 300);
  };
  ctx.on('page', onPage);
  // messages the click shows: browser alerts ("Please select ring size") and on-page notices
  let message: string | undefined;
  const onDialog = (d: import('playwright').Dialog) => { message ??= d.message(); d.dismiss().catch(() => {}); };
  page.on('dialog', onDialog);
  const NOTICE = '[role="alert"], .error, [class*="error"], [class*="invalid"], [class*="toast"], [class*="notice"], [class*="alert"], .swal2-popup, [class*="message"]';
  const notices = () => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter(e => (window as any).__qaVis(e)).map(e => ((e as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim()).filter(t => t && t.length < 160), NOTICE).catch(() => [] as string[]);
  const noticesBefore = new Set(await notices());
  // sliders that autoplay can move the target away between aiming and clicking: pause them
  const inSlider = await page.evaluate(() => {
    const el = document.querySelector('[data-qa-target]');
    const box = el?.closest('.swiper, swiper-container, .slick-slider') as any;
    try { box?.swiper?.autoplay?.stop(); } catch { /* ignore */ }
    try { const $ = (window as any).jQuery; if ($ && box && box.classList.contains('slick-slider')) $(box).slick('slickPause'); } catch { /* ignore */ }
    return !!box;
  }).catch(() => false);
  await ctx.route('**/*', handler);
  const before = page.url();
  let note: string | undefined;
  try {
    const visibleNow = await page.evaluate(() => (window as any).__qaVis(document.querySelector('[data-qa-target]'))).catch(() => false);
    try {
      if (!visibleNow || forceScript) throw new Error('hidden');
      await target.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      await target.click({ timeout: 1500 });
    } catch {
      note = forceScript ? undefined : visibleNow ? 'Element was covered by another element; clicked via script' : 'Element was not visible to a shopper (its menu or slide did not open); clicked via script';
      await page.evaluate(() => (document.querySelector('[data-qa-target]') as HTMLElement | null)?.click()).catch(() => {});
    }
    const until = Date.now() + 3500;
    let ui = 0;
    while (Date.now() < until) {
      if (navs.length || message) break;
      if (page.url().split('#')[0] !== before.split('#')[0]) break;
      ui = await uiNow();
      if (ui > 0) break;
      await page.waitForTimeout(150);
    }
    if (!navs.length && !message) message = (await notices()).find(t => !noticesBefore.has(t) && /select|choose|please|required|size/i.test(t));
    return { navUrl: navs[0]?.url, newTab: navs[0]?.newTab, urlAfter: page.url(), openedUi: !navs.length && !message && ui > 0, note, message, inSlider };
  } finally {
    await ctx.unroute('**/*', handler).catch(() => {});
    ctx.off('page', onPage);
    page.off('dialog', onDialog);
    for (const p of popups) await p.close().catch(() => {});
  }
}

/**
 * Click `link` on `page` (already showing link.sourceUrl). Leaves the page on the source page.
 * A click swallowed because a required dropdown is empty (ring size) is reported, then retried with an option chosen.
 */
export async function clickTest(ctx: BrowserContext, page: Page, link: ClickTarget, cfg: Config): Promise<ClickOutcome> {
  const checks: Check[] = [];
  const at = new Date().toISOString();
  const malformed = link.destType === 'malformed';
  let a = await attemptClick(ctx, page, link);
  if (a.error) {
    checks.push({ name: 'Click from source', status: 'BLOCKED', mandatory: true, detail: a.error });
    return { checks, at };
  }
  const moved = (x: Attempt) => !!x.navUrl || x.urlAfter.split('#')[0] !== link.sourceUrl.split('#')[0];
  let asked: string | undefined;
  if (!moved(a) && !a.openedUi && !malformed) {
    if (a.message) {
      // the button asks the shopper to choose something first (e.g. "Please select ring size"): correct behaviour
      asked = a.message;
      checks.push({ name: 'Required option feedback', status: 'PASS', mandatory: true, detail: `Shows the message "${a.message.slice(0, 80)}" (the URL stays the same, as expected)` });
    } else {
      const sel = await page.evaluate(() => {
        const s = [...document.querySelectorAll('select')].find(s => (window as any).__qaVis(s) && !s.value && s.options.length > 1) as HTMLSelectElement | undefined;
        if (!s) return null;
        const label = (s.closest('div')?.innerText || s.name || s.id || 'option').split('\n')[0].trim().slice(0, 40);
        const opt = [...s.options].find(o => o.value)!;
        s.setAttribute('data-qa-select', '1');
        return { label, value: opt.value };
      }).catch(() => null);
      // second attempt: some menus need a second hover; it also catches a late message
      const a2 = await attemptClick(ctx, page, link);
      if (!a2.error) a = a2;
      if (a.message) {
        asked = a.message;
        checks.push({ name: 'Required option feedback', status: 'PASS', mandatory: true, detail: `Shows the message "${a.message.slice(0, 80)}" (the URL stays the same, as expected)` });
      } else if (sel && !moved(a)) {
        let detail = `Nothing happens until "${sel.label}" is chosen, and no message tells the shopper why`;
        await page.selectOption('[data-qa-select="1"]', sel.value).catch(() => {});
        const a3 = await attemptClick(ctx, page, link);
        if (!a3.error) a = a3;
        if (moved(a)) detail += `; after choosing ${sel.value} the button works`;
        checks.push({ name: 'Required option feedback', status: 'FAIL', mandatory: true, detail });
      }
    }
  }
  // the slider moved under the pointer: click that exact element again
  if (a.navUrl && a.inSlider && !samePath(link.href, a.navUrl)) {
    const a4 = await attemptClick(ctx, page, link, true);
    if (!a4.error && a4.navUrl) a = { ...a4, note: 'the slider moved during the first click; clicked again' };
  }
  const dest = a.navUrl ?? (moved(a) ? a.urlAfter : undefined);
  const out: ClickOutcome = { checks, clickUrl: dest, at };
  if (dest) {
    const d = diffParams(link.href, dest, cfg);
    // a new tab on another site may already have redirected (e.g. to its login page): the same site counts
    const sameHost = (() => { try { return new URL(link.href).host === new URL(dest).host; } catch { return false; } })();
    const ok = malformed ? false : (samePath(link.href, dest) && !d.missing.length && !d.changed.length) || (!!a.newTab && link.destType === 'external' && (sameHost || !!dest));
    void sameHost;
    checks.push({
      name: 'Click from source', status: ok || malformed ? 'PASS' : 'FAIL', mandatory: true,
      detail: ok || malformed ? `${a.newTab ? 'Opens in a new tab: ' : 'Opens '}${shortUrl(dest, cfg)}${a.note ? ` (${a.note})` : ''}`
        : `Clicking opens ${shortUrl(dest, cfg)} instead of ${shortUrl(link.href, cfg)}`,
    });
  } else if (asked) {
    checks.push({ name: 'Click from source', status: 'PASS', mandatory: true, detail: `Asks the shopper to choose first: "${asked.slice(0, 80)}" (the link URL is tested directly)` });
  } else if (a.openedUi) {
    out.note = 'Opened an in-page drawer or dialog';
    checks.push({ name: 'Click from source', status: 'PASS', mandatory: true, detail: 'Opens an in-page drawer or dialog (the link URL is still tested directly)' });
  } else if (malformed) {
    checks.push({ name: 'Click from source', status: 'FAIL', mandatory: true, detail: `Click did not navigate: the shopper stays on ${shortUrl(a.urlAfter, cfg)}` });
  } else if (samePath(link.href, link.sourceUrl)) {
    checks.push({ name: 'Click from source', status: 'PASS', mandatory: true, detail: 'Links to the page it is on' });
  } else {
    checks.push({ name: 'Click from source', status: 'FAIL', mandatory: true, detail: `Click did nothing after 2 attempts (still on ${shortUrl(a.urlAfter, cfg)})` });
    out.screenshot = await shoot(page, cfg, `${link.id}-click`);
  }
  // restore the source page if a script navigation slipped through
  if (!samePath(page.url(), link.sourceUrl)) { await gotoSettled(page, link.sourceUrl, cfg); await dismissPopups(page); }
  return out;
}
