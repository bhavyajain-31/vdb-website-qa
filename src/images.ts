import type { Page } from 'playwright';
import type { Config } from './config.js';
import type { NavRecord } from './browser.js';
import type { Check, ImageResult, ImageStatus } from './types.js';

interface RawImg {
  src: string;
  kind: 'img' | 'background';
  hasSrcAttr: boolean;
  complete: boolean;
  nw: number;
  nh: number;
  decodeError?: string;
  timedOut: boolean;
  productId?: string;
  product: boolean;
  context: string;
  placeholder: boolean;
  skip?: string;
  known?: boolean;
  near?: string;
}

const SLIDE_SEL = '.swiper-slide, .slick-slide, .slideshow__slide, .slider__slide, [data-qa-slides] > *';

/**
 * Find every image on the page (img tags and CSS background images) and test the ones a shopper sees.
 * Tested: visible images ≥16px, plus images in slider slides that are currently off-screen.
 * Skipped (listed with a reason): hidden elsewhere (closed menus, alternate views), tiny icons, tracking pixels.
 * Each tested image must have a source, finish loading, and decode to a real picture.
 */
/** Image URLs already verified OK on another page this run: not waited for again. */
export const verifiedImages = new Set<string>();

/** @param minSize smallest image tested (px); menus pass 1 so every icon is checked */
export async function checkImages(page: Page, rec: NavRecord, cfg: Config, scope = 'body', minSize = 16): Promise<{ images: ImageResult[]; check: Check }> {
  const known = [...verifiedImages];
  let raw: RawImg[];
  try {
    raw = await page.evaluate(async ({ scope, timeoutMs, tracking, SLIDE_SEL, known, minSize }) => {
      const knownSet = new Set(known);
      const vis = (window as any).__qaVis as (e: Element) => boolean;
      const root = document.querySelector(scope) || document.body;
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
      const trackRe = tracking.map((t: string) => new RegExp(t));
      const PRODUCT = '[data-prids], [data-product-name], .card-wrapper, .card, .vdb-rb-list-product-item, .vdb-search-result-block, .vdb-gem-product-image-block, .product__media-item, .product__media, .product-media, [class*="product-gallery"], [class*="vdb-rb-product"], [class*="vdb-product"]';
      const ctxOf = (el: Element) => {
        let productId: string | undefined;
        const p = el.closest('[data-prids]') as HTMLElement | null;
        if (p?.dataset.prids) productId = p.dataset.prids;
        const named = el.closest('[data-product-name]') as HTMLElement | null;
        if (named?.dataset.productName) productId = `${named.dataset.productName}${productId ? ' #' + productId : ''}`;
        const href = (el.closest('a[href]') as HTMLAnchorElement | null)?.getAttribute('href') || '';
        const stock = href.match(/(?:natural|labgrown|gemstone|ring)_stock_num=([^&]+)/);
        if (!productId && stock) productId = decodeURIComponent(stock[1]);
        const handle = href.match(/\/products\/([^/?#]+)/);
        if (!productId && handle) productId = handle[1];
        const sec = el.closest('.shopify-section')?.id?.split('__').pop() || (el.closest('header') ? 'header' : el.closest('footer') ? 'footer' : '');
        const product = !!el.closest(PRODUCT) || /\/products\//.test(location.pathname) && !!el.closest('main');
        const a = el.closest('a[href]') as HTMLElement | null;
        const near = ((a?.innerText || a?.getAttribute('aria-label') || (el as HTMLImageElement).alt || '') as string).replace(/\s+/g, ' ').trim().slice(0, 50);
        return { productId, context: sec, product, near };
      };
      const out: any[] = [];
      const deadline = Date.now() + timeoutMs;
      const seen = new Set<string>();

      const all = [...root.querySelectorAll('img')] as HTMLImageElement[];
      // load lazy images without scrolling to each one: much faster on CPU-heavy pages
      for (const img of all) if (img.loading === 'lazy' && (vis(img) || img.closest(SLIDE_SEL))) img.loading = 'eager';
      const pending: Promise<void>[] = [];
      for (const img of all) {
        const s0 = img.currentSrc || img.src || img.getAttribute('data-src') || '';
        const r = img.getBoundingClientRect();
        const inSlide = !!img.closest(SLIDE_SEL);
        const visible = vis(img);
        let skip: string | undefined;
        if (trackRe.some((re: RegExp) => re.test(s0))) skip = 'Tracking pixel (not a content image)';
        else if (visible && (r.width < minSize || r.height < minSize)) skip = `Icon smaller than ${minSize} px`;
        else if (!visible && !inSlide) skip = 'Hidden on the page (closed menu, inactive tab or alternate view)';
        else if (!visible && inSlide && !(img.getAttribute('src') || img.getAttribute('srcset'))) skip = 'Lazy image in a hidden slide; the page has not requested it yet';
        const { productId, context, product, near } = ctxOf(img);
        if (skip) {
          const key = 'skip|' + s0;
          if (s0 && seen.has(key)) continue;
          seen.add(key);
          out.push({ src: s0 || '(no source)', kind: 'img', hasSrcAttr: !!s0, complete: img.complete, nw: img.naturalWidth, nh: img.naturalHeight, timedOut: false, productId, context, product, near, placeholder: false, skip });
          continue;
        }
        if ((!img.complete || img.naturalWidth === 0) && knownSet.has(s0)) {
          out.push({ src: s0, kind: 'img', hasSrcAttr: true, complete: true, nw: 0, nh: 0, timedOut: false, productId, context, product, near, placeholder: false, known: true });
          continue;
        }
        const rec: any = { kind: 'img', hasSrcAttr: !!(img.getAttribute('src') || img.getAttribute('srcset')), productId, context, product, near };
        out.push(rec);
        // all images are awaited in parallel, each until the shared deadline
        pending.push((async () => {
          while (!img.complete && Date.now() < deadline) await sleep(120);
          if (img.complete && (img.currentSrc || img.src) && img.naturalWidth > 0) {
            try { await Promise.race([img.decode(), sleep(4000).then(() => { throw new Error('decode timeout'); })]); }
            catch (e) { if (!/decode timeout/.test(String(e))) rec.decodeError = String((e as Error).message || e); }
          }
          const src = img.currentSrc || img.src || '';
          Object.assign(rec, {
            src, complete: img.complete, nw: img.naturalWidth, nh: img.naturalHeight, timedOut: !img.complete,
            placeholder: /placeholder|no[-_]?image|noimage|default[-_]?img/i.test(src) || /^data:image\/(gif|png);base64,.{0,120}$/.test(src),
          });
        })());
      }
      await Promise.all(pending);

      // CSS background images on visible, reasonably large elements (banners, hero slides)
      let bgCount = 0;
      const bgPending: Promise<void>[] = [];
      for (const el of [...root.querySelectorAll('section, div, a, figure, li')] as HTMLElement[]) {
        if (bgCount >= 40) break;
        const bg = getComputedStyle(el).backgroundImage;
        if (!bg || bg === 'none' || !/url\(/.test(bg)) continue;
        const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
        if (!m || m[1].startsWith('data:')) continue;
        const url = new URL(m[1], location.href).toString();
        if (seen.has('bg|' + url)) continue;
        seen.add('bg|' + url);
        const r = el.getBoundingClientRect();
        const { productId, context, product, near } = ctxOf(el);
        if (!vis(el) && !el.closest(SLIDE_SEL)) { out.push({ src: url, kind: 'background', hasSrcAttr: true, complete: false, nw: 0, nh: 0, timedOut: false, productId, context, product, near, placeholder: false, skip: 'Hidden on the page (closed menu, inactive tab or alternate view)' }); continue; }
        if (r.width < 50 || r.height < 50) { out.push({ src: url, kind: 'background', hasSrcAttr: true, complete: false, nw: 0, nh: 0, timedOut: false, productId, context, product, near, placeholder: false, skip: 'Decorative background smaller than 50 px' }); continue; }
        bgCount++;
        const rec: any = { src: url, kind: 'background', hasSrcAttr: true, productId, context, product, near, placeholder: false };
        out.push(rec);
        bgPending.push((async () => {
          const probe = new Image();
          probe.src = url;
          const until = Date.now() + Math.max(3000, timeoutMs);
          while (!probe.complete && Date.now() < until) await sleep(120);
          if (probe.complete && probe.naturalWidth > 0) { try { await Promise.race([probe.decode(), sleep(4000)]); } catch (e) { rec.decodeError = String((e as Error).message || e); } }
          Object.assign(rec, { complete: probe.complete, nw: probe.naturalWidth, nh: probe.naturalHeight, timedOut: !probe.complete });
        })());
      }
      await Promise.all(bgPending);
      window.scrollTo(0, 0);
      return out;
    }, { scope, timeoutMs: cfg.imageTimeoutMs, tracking: cfg.trackingHosts.map(r => r.source), SLIDE_SEL, known, minSize });
  } catch (e) {
    return { images: [], check: { name: 'Images', status: 'BLOCKED', mandatory: true, detail: `Image check did not complete: ${(e as Error).message.split('\n')[0]}` } };
  }

  const url = page.url();
  // Network-level failures may be the test environment, not the site: re-request those once.
  const retry = new Map<string, { status?: number; ok: boolean; error?: string }>();
  const toRetry = [...new Set(raw.filter(r => {
    if (r.skip || r.known) return false;
    const net = rec.imageErrors.get(r.src);
    return r.src && !r.src.startsWith('data:') && ((net && !net.status) || r.timedOut || (r.nw === 0 && !net) || net?.status === 429 || net?.status === 503);
  }).map(r => r.src))].slice(0, 12);
  // re-request in parallel (slow image hosts would otherwise add many seconds per image)
  await Promise.all(toRetry.map(async src => {
    try {
      const resp = await page.context().request.get(src, { timeout: 10_000 });
      const type = resp.headers()['content-type'] || '';
      retry.set(src, { status: resp.status(), ok: resp.ok() && /image|octet-stream/.test(type) });
    } catch (e) {
      retry.set(src, { ok: false, error: (e as Error).message.split('\n')[0].slice(0, 120) });
    }
  }));

  const images: ImageResult[] = raw.map(r => {
    const net = rec.imageErrors.get(r.src);
    const ok = rec.imageOk.get(r.src);
    const base: Omit<ImageResult, 'status'> = { pageUrl: url, src: r.src || '(no source)', kind: r.kind, productId: r.productId, product: r.product, context: r.context, position: r.near || undefined, naturalWidth: r.nw || undefined, naturalHeight: r.nh || undefined, httpStatus: net?.status ?? ok };
    if (r.skip) return { ...base, status: 'SKIPPED' as const, reason: r.skip };
    if (r.known) return { ...base, status: 'PASS' as const, reason: 'Already verified on another page' };
    let status: ImageStatus = 'PASS';
    let reason: string | undefined;
    const rt = retry.get(r.src);
    if (!r.hasSrcAttr || !r.src) { status = 'FAIL'; reason = 'Image has no file address (missing src)'; }
    else if (net?.error && /ERR_(TUNNEL|PROXY|BLOCKED_BY_CLIENT|INTERNET_DISCONNECTED)/.test(net.error)) { status = 'BLOCKED'; reason = `Request blocked by the test environment (${net.error})`; }
    else if (net?.status === 429 || (net?.status === 503 && /\/apps\//.test(r.src))) {
      if (rt?.ok) { status = 'PASS'; reason = `First request was refused (HTTP ${net.status}); re-request served a valid image`; }
      else { status = 'BLOCKED'; reason = `Image server was busy (HTTP ${net.status}, usually caused by the test's own traffic); could not be verified`; }
    }
    else if (net?.status) { status = 'FAIL'; reason = net.status === 404 ? 'Image file not found (HTTP 404)' : `Image server returned an error (HTTP ${net.status})`; }
    else if (net?.error || r.timedOut || ((r.nw === 0 || r.nh === 0) && !ok)) {
      const first = net?.error ? `request failed (${net.error})` : r.timedOut ? `did not finish loading within ${Math.round(cfg.imageTimeoutMs / 1000)} s` : 'did not display';
      if (rt?.status && rt.status >= 400) { status = 'FAIL'; reason = `Image ${first}; the file returns HTTP ${rt.status}`; base.httpStatus = rt.status; }
      else if (rt?.ok) { status = 'BLOCKED'; reason = `Image ${first} in the browser, but the file is fine when re-requested (probably a temporary network drop)`; }
      else if (rt?.status) { status = 'FAIL'; reason = `Image ${first}; the address returns HTTP ${rt.status} but no image`; }
      else { status = 'BLOCKED'; reason = `Image ${first}; re-request also failed (${rt?.error ?? 'network'}), so it could not be verified`; }
    }
    else if (r.nw === 0 || r.nh === 0) { status = 'FAIL'; reason = 'File downloaded but the picture did not display (0×0)'; }
    else if (r.decodeError) { status = 'FAIL'; reason = `File is not a valid image (decode failed: ${r.decodeError.slice(0, 80)})`; }
    else if (r.placeholder) { status = 'FAIL'; reason = 'A "no image" placeholder is shown instead of the real picture'; }
    else if (r.nw <= 2 && r.nh <= 2) { status = 'FAIL'; reason = 'Blank 1×1 image'; }
    return { ...base, status, reason };
  });

  for (const i of images) if (i.status === 'PASS' && i.src.startsWith('http')) verifiedImages.add(i.src);
  const tested = images.filter(i => i.status !== 'SKIPPED');
  const failed = tested.filter(i => i.status === 'FAIL');
  const blocked = tested.filter(i => i.status === 'BLOCKED');
  const status = failed.length ? 'FAIL' as const : blocked.length ? 'BLOCKED' as const : 'PASS' as const;
  const skipped = images.length - tested.length;
  const detail = failed.length
    ? `${failed.length} of ${tested.length} images broken${failed.some(f => f.product) ? ' (product images)' : ''}`
    : blocked.length ? `${blocked.length} of ${tested.length} images could not be verified`
      : `${tested.length} images loaded and displayed${skipped ? `; ${skipped} skipped (hidden/icons)` : ''}`;
  // images that could not be verified are listed in the Images tab but do not block the page result
  return { images, check: { name: 'Images', status, mandatory: status !== 'BLOCKED', detail, severity: failed.some(f => f.product) ? 'critical' : 'minor' } };
}
