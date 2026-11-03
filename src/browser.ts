import { chromium, type Browser, type BrowserContext, type Page, type Response } from 'playwright';
import { VIEWPORTS, type Config } from './config.js';
import { AppGate, gate } from './throttle.js';

/**
 * Injected into every page.
 * - __qaVis(el): true only if the element is really visible to a user (ancestors' display/visibility/
 *   opacity and clipping containers are taken into account; closed mega-menu panels count as hidden).
 * - __qaCount(): the page's own result total ("832 Results", "14 products").
 * - __qaLcp: Largest Contentful Paint, for the performance report.
 */
const INIT_SCRIPT = `
globalThis.__name = globalThis.__name || function (f) { return f; };
window.__qaLcp = 0;
try {
  new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { window.__qaLcp = e.startTime; }); })
    .observe({ type: 'largest-contentful-paint', buffered: true });
} catch (e) {}
window.__qaVis = function (e) {
  if (!e || !e.isConnected) return false;
  const r = e.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
    if (n === e || n === document.body || n === document.documentElement) continue;
    const clipX = s.overflowX !== 'visible', clipY = s.overflowY !== 'visible';
    if (clipX || clipY) {
      const pr = n.getBoundingClientRect();
      if (clipX && (pr.width < 2 || r.right <= pr.left + 1 || r.left >= pr.right - 1)) return false;
      if (clipY && (pr.height < 2 || r.bottom <= pr.top + 1 || r.top >= pr.bottom - 1)) return false;
    }
  }
  return true;
};
window.__qaCount = function () {
  const re = /^\\s*([\\d,]+)\\s+(results?|products?)(\\s+found)?\\b/i;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent || '';
    if (!/\\d/.test(t)) continue;
    const el = n.parentElement;
    if (!el || el.closest('select, option, script, style, noscript, template')) continue;
    const own = (el.innerText || t).replace(/\\s+/g, ' ').trim();
    const m = own.match(re) || t.match(re);
    if (m && window.__qaVis(el)) return Number(m[1].replace(/,/g, ''));
  }
  return undefined;
};`;

export async function launch(cfg: Config): Promise<Browser> {
  return chromium.launch({ headless: cfg.headless, args: ['--disable-dev-shm-usage'] });
}

/**
 * @param quiet turn off CSS animations/transitions (used for deeplink tests: less CPU, nothing validated depends on them;
 *              not used for menu/slider/click tests, where animations are part of what a shopper sees)
 */
export async function newContext(browser: Browser, cfg: Config, quiet = false): Promise<BrowserContext> {
  const ctx = await browser.newContext({ ...VIEWPORTS[cfg.viewport], locale: 'en-US', reducedMotion: quiet ? 'reduce' : 'no-preference' });
  await ctx.addInitScript(INIT_SCRIPT);
  // quiet mode also caps animation frames at ~10 per second: the ring builder's 3D viewer otherwise renders
  // continuously in software and keeps the CPU busy, slowing every other check on the machine
  if (quiet) await ctx.addInitScript(`(function(){ var raf = window.requestAnimationFrame.bind(window); var last = 0;
    window.requestAnimationFrame = function (cb) { return raf(function (t) { if (t - last < 95) { return window.requestAnimationFrame(cb); } last = t; cb(t); }); }; })();`);
  // and skips WebGL (the 3D ring viewer): software-rendered 3D keeps a CPU core 100% busy per page.
  // The 3D viewer itself is not something this tool validates; the ring builder pages fall back to photos.
  if (quiet) await ctx.addInitScript(`(function(){ var gc = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type) { if (/webgl/i.test(String(type))) { window.__qaWebglBlocked = (window.__qaWebglBlocked || 0) + 1; return null; } return gc.apply(this, arguments); }; })();`);
  if (quiet) await ctx.addInitScript(`document.addEventListener('DOMContentLoaded', function () { var s = document.createElement('style'); s.textContent = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important}'; document.head.appendChild(s); });`);
  const block = cfg.blockThirdParty;
  const media = cfg.blockFontsAndMedia;
  if (block || media) {
    await ctx.route(
      u => !!block?.some(re => re.test(u.toString())) || (media && /\.(woff2?|ttf|otf|eot|mp4|webm|m3u8)(\?|$)/i.test(u.pathname)),
      r => r.abort('blockedbyclient'),
    );
  }
  if (quiet) {
    // analytics sandboxes, survey embeds and decorative Lottie animations: never validated, CPU-heavy
    await ctx.route(/\/cdn\/wpm\/|\/web-pixels@|embed\.typeform\.com|lottie-player|\.lottie(\?|$)|lottiefiles/, r => r.abort('blockedbyclient'));
  }
  ctx.setDefaultTimeout(12_000);
  ctx.setDefaultNavigationTimeout(cfg.navTimeoutMs);
  return ctx;
}

export interface NavRecord {
  documents: { url: string; status: number }[];
  imageErrors: Map<string, { status?: number; error?: string }>;
  imageOk: Map<string, number>;
  stop: () => void;
}

/** Track main-frame documents and image network outcomes for a page. */
export function record(page: Page): NavRecord {
  const documents: NavRecord['documents'] = [];
  const imageErrors: NavRecord['imageErrors'] = new Map();
  const imageOk: NavRecord['imageOk'] = new Map();
  const onResp = (r: Response) => {
    const req = r.request();
    // app API calls answered "429 Too Many Requests": slow every app page load down for a moment
    if (r.status() === 429 && AppGate.isApp(r.url()) && req.resourceType() !== 'document') gate.apiLimited();
    if (req.resourceType() === 'document' && req.frame() === page.mainFrame()) documents.push({ url: r.url(), status: r.status() });
    if (req.resourceType() === 'image') {
      if (r.status() >= 400) imageErrors.set(r.url(), { status: r.status() });
      else imageOk.set(r.url(), r.status());
    }
  };
  const onFail = (req: import('playwright').Request) => {
    if (req.resourceType() === 'image') imageErrors.set(req.url(), { error: req.failure()?.errorText });
    if (req.resourceType() === 'document' && req.frame() === page.mainFrame()) documents.push({ url: req.url(), status: -1 });
  };
  page.on('response', onResp);
  page.on('requestfailed', onFail);
  return { documents, imageErrors, imageOk, stop: () => { page.off('response', onResp); page.off('requestfailed', onFail); } };
}

export interface GotoResult { status?: number; error?: string; rateLimitedRetries: number }

/**
 * Navigate through the app gate. HTTP 429/503 from the app proxy triggers a shared pause and a retry
 * (up to 3 tries), so rate limiting caused by the test itself no longer shows up as a site failure.
 */
export async function gotoSettled(page: Page, url: string, cfg: Config): Promise<GotoResult> {
  let last = '';
  let rateLimitedRetries = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const release = await gate.acquire(url);
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
      const status = resp?.status();
      if ((status === 429 || status === 503) && isAppUrl(url) && attempt < 3) {
        rateLimitedRetries++;
        release();
        await page.waitForTimeout(gate.rateLimited());
        continue;
      }
      if (isAppUrl(url)) gate.ok();
      await settle(page, 300, 3_000);
      return { status, rateLimitedRetries };
    } catch (e) {
      last = (e as Error).message.split('\n')[0];
      if (/interrupted by another navigation/i.test(last)) {
        await page.waitForLoadState('domcontentloaded', { timeout: cfg.navTimeoutMs }).catch(() => {});
        await settle(page);
        if (new URL(page.url()).pathname === new URL(url).pathname) return { status: 200, rateLimitedRetries };
        continue;
      }
      if (!/Timeout|ERR_CONNECTION|ERR_EMPTY_RESPONSE|ERR_NETWORK_CHANGED/i.test(last) || attempt >= 1) break;
    } finally {
      release();
    }
  }
  return { error: last, rateLimitedRetries };
}

function isAppUrl(url: string) { return AppGate.isApp(url); }

/** Reload through the gate (app pages are rate limited on reload too). */
export async function reloadSettled(page: Page, cfg: Config): Promise<number | undefined> {
  let status: number | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const release = await gate.acquire(page.url());
    try {
      const r = await page.reload({ waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs }).catch(() => null);
      status = r?.status();
      if ((status === 429 || status === 503) && isAppUrl(page.url()) && attempt < 2) { release(); await page.waitForTimeout(gate.rateLimited()); continue; }
      await settle(page, 200, 3_000);
      return status;
    } finally { release(); }
  }
  return status;
}

/**
 * Wait for the browser "load" event (capped) plus a short pause for client-side redirects.
 * networkidle never arrives on this store (apps poll constantly); page-type waits live in content.ts.
 */
export async function settle(page: Page, extraMs = 300, loadCapMs = 8_000): Promise<void> {
  await page.waitForLoadState('load', { timeout: loadCapMs }).catch(() => {});
  await page.waitForTimeout(extraMs);
}

/** Scroll the whole page in steps so lazy content and images load, then return to top. */
export async function scrollThrough(page: Page, maxSteps = 25): Promise<void> {
  // one in-page loop (a round trip per step is slow on CPU-heavy pages)
  await page.evaluate(async (maxSteps) => {
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < maxSteps; i++) {
      window.scrollBy(0, Math.round(window.innerHeight * 0.9));
      await sleep(90);
      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4) break;
    }
    await sleep(300);
    window.scrollTo(0, 0);
  }, maxSteps).catch(() => {});
}

/**
 * Close overlays that block interaction, the way a user would: click their close control.
 * The demo store opens a full-screen "Want to speak to our team?" contact popup on scroll.
 */
export async function dismissPopups(page: Page): Promise<string[]> {
  const closed = await page.evaluate(() => {
    const vis = (window as any).__qaVis as (e: Element) => boolean;
    const out: string[] = [];
    const dialogs = [...document.querySelectorAll('.contact-popup--wrapper, .contact-popup, [role="dialog"], [aria-modal="true"], .klaviyo-form, .needsclick[role="dialog"]')]
      .filter(d => { const r = d.getBoundingClientRect(); return vis(d) && r.width > 200 && r.height > 150; });
    for (const d of dialogs) {
      const btn = [...d.querySelectorAll('button, a, span, div, svg')].find(b => {
        if (!vis(b)) return false;
        const t = ((b as HTMLElement).innerText || '').trim();
        const al = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('class') || '');
        return /^(×|✕|x|close)$/i.test(t) || /close|dismiss/i.test(al);
      }) as HTMLElement | undefined;
      if (btn) { btn.click(); out.push((d.className.toString() || d.id || d.tagName).slice(0, 40)); }
    }
    return out;
  }).catch(() => [] as string[]);
  await page.keyboard.press('Escape').catch(() => {});
  if (closed.length) await page.waitForTimeout(300);
  await page.evaluate(() => {
    document.querySelectorAll('.contact-popup--wrapper, .contact-popup--overlay').forEach(e => { const vis = (window as any).__qaVis; if (vis(e)) (e as HTMLElement).style.display = 'none'; });
  }).catch(() => {});
  return closed;
}

/** Hard time limit for one test case. Closes the context so stuck page calls fail fast. */
export async function withTimeout<T>(ms: number, ctxRef: { ctx?: BrowserContext }, fn: () => Promise<T>, onTimeout: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const t = new Promise<'timeout'>(r => { timer = setTimeout(() => { timedOut = true; r('timeout'); }, ms); });
  try {
    const r = await Promise.race([fn(), t]);
    if (r === 'timeout') { await ctxRef.ctx?.close().catch(() => {}); return onTimeout(); }
    return r as T;
  } catch (e) {
    if (timedOut) return onTimeout();
    throw e;
  } finally { clearTimeout(timer); }
}

/** Bot-protection interstitial (e.g. Cloudflare "Performing security verification") instead of the real page. */
export async function botChallenge(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const t = (document.body?.innerText || '').slice(0, 3000);
    const m = t.match(/Performing security verification|Verify you are human|Checking your browser|Just a moment\.\.\.|Attention Required!/i);
    if (m) return m[0];
    if (document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-form, #cf-challenge-running')) return 'Cloudflare challenge';
    return null;
  }).catch(() => null);
}
