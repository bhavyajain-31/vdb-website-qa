import type { Browser, Page } from 'playwright';
import type { Config } from './config.js';
import { dismissPopups, gotoSettled, newContext, record, scrollThrough } from './browser.js';
import { checkImages } from './images.js';
import { measurePerf } from './perf.js';
import type { Inventory } from './inventory.js';
import type { DeadClickable, ImageResult, PerfSample, ScenarioResult, Section, Status } from './types.js';

export interface RawAnchor {
  rawHref: string; label: string; section: Section; visible: boolean; productId?: string;
  /** Where the link sits, e.g. ["Mega menu", "Engagement Rings", "Shop By Metal", "Yellow Gold"]. */
  position?: string[];
  /** Shopify section id and the index of this anchor among same-href anchors in it (to click exactly this one). */
  secId?: string; nth?: number;
  /** Groups anchors of one card/slide (image + title + swatches = one placement). */
  slot?: string;
  inSlide?: boolean;
}

export interface Discovery {
  deadClickables: DeadClickable[];
  components: ScenarioResult[];
  homePerf?: PerfSample;
  homeImages: ImageResult[];
}

/** Read anchors under `rootSel`, with section and visibility, inside the page. */
export async function readAnchors(page: Page, rootSel: string, forced?: Section): Promise<RawAnchor[]> {
  return page.evaluate(({ rootSel, forced }) => {
    const vis = (window as any).__qaVis as (e: Element) => boolean;
    const roots = [...document.querySelectorAll(rootSel)];
    const sectionOf = (a: Element): string => {
      if (forced) return forced;
      if (a.closest('footer, .shopify-section-group-footer-group')) return 'footer';
      const header = a.closest('header, .shopify-section-group-header-group, header-drawer, .menu-drawer');
      if (header) {
        if (a.closest('.mega-menu, .mega-menu__content, .header__submenu, details ul, .menu-drawer__submenu, [class*="megamenu"], [class*="mega_menu"]')) return 'megamenu';
        return 'header';
      }
      const sec = a.closest('.shopify-section');
      if (sec && /slideshow|slider|banner|carousel/i.test(sec.id)) return 'sliders';
      return 'homepage';
    };
    const CARD = '.card-wrapper, .card, .vdb-rb-list-product-item, [data-prids]';
    const HEAD = '.card__heading, .vdb-rb-product-name, .product-card__title, h3, h2';
    const label = (a: HTMLAnchorElement) => {
      const own = (a.innerText || a.getAttribute('aria-label') || a.title || a.querySelector('img')?.alt || '').replace(/\s+/g, ' ').trim();
      // product cards: swatch / image links carry variant handles or nothing; the card heading is the real name
      const card = a.closest(CARD);
      const head = card?.querySelector(HEAD) as HTMLElement | null;
      const headText = (head?.innerText || '').replace(/\s+/g, ' ').trim();
      // inside a product card the heading is the product name; image and swatch links carry variant text
      if (headText && (card && !a.closest(HEAD) || !own || own.length > 60)) return headText.slice(0, 80);
      return own.slice(0, 80);
    };
    // ---- position: area › section › group › item
    const norm = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
    const tc = (s: string) => s.toLowerCase().replace(/(^|[\s/(-])([a-z])/g, (_m, p, c) => p + c.toUpperCase());
    const SLIDE = '.swiper-slide, .slick-slide, .slideshow__slide, .slider__slide, [data-qa-slides] > *';
    const DUP = '.slick-cloned, .swiper-slide-duplicate';
    // section names exactly as shoppers see them (the section heading as displayed)
    const secName = (sec: Element) => {
      const id = sec.id || '';
      if (/slideshow/i.test(id)) return 'Hero section';
      const h = [...sec.querySelectorAll('h1, h2, h3, .banner__heading, .title')].find(x => norm((x as HTMLElement).innerText)) as HTMLElement | undefined;
      const ht = norm(h?.innerText).slice(0, 50);
      if (ht) return ht;
      const type = id.split('__').pop()!.replace(/_[A-Za-z0-9]{6}$/, '').replace(/^index_/, '').replace(/_\d*$/, '').replace(/_/g, ' ').trim();
      return tc(type);
    };
    const groupLabel = (a: Element, stop: Element | null, own: string) => {
      // a link that heads its own sub-list (e.g. "Bracelets" above Tennis/Fashion Bracelets) is itself a group heading
      if (a.nextElementSibling && /^(UL|OL)$/.test(a.nextElementSibling.tagName)) return '';
      // otherwise: the nearest heading-like element *before* the list this link sits in
      for (let n: Element | null = a; n && n !== stop; n = n.parentElement) {
        for (let sib = n.previousElementSibling; sib; sib = sib.previousElementSibling) {
          if (/^(UL|OL|LI)$/.test(sib.tagName)) continue;
          if (!/^(SUMMARY|A|SPAN|H2|H3|H4|H5|P|STRONG|DIV|BUTTON)$/.test(sib.tagName)) continue;
          const t = norm((sib as HTMLElement).innerText || sib.textContent);
          if (t && t.length < 40 && t !== own) return t;
          if (t) break;
        }
      }
      return '';
    };
    const positionOf = (a: HTMLAnchorElement, sec: string, lab: string): { position: string[]; slot: string; inSlide: boolean } => {
      const shop = a.closest('.shopify-section') as HTMLElement | null;
      const sid = shop?.id || '';
      if (sec === 'megamenu') {
        const li = a.closest('header nav > ul > li, header .list-menu--inline > li');
        const top = norm((li?.querySelector('summary, a, button, span') as HTMLElement | null)?.innerText);
        const g = groupLabel(a, li, lab);
        // icon link + text link of the same menu item = one placement (slot without the label)
        return { position: ['Mega menu', top || 'Menu', ...(g && g.toLowerCase() !== top.toLowerCase() ? [g] : [])], slot: 'm|' + top + '|' + g + '|' + a.getAttribute('href'), inSlide: false };
      }
      if (sec === 'header') {
        if (/scrollable|announcement/i.test(sid)) return { position: ['Header', 'Announcement bar'], slot: 'h|' + a.getAttribute('href'), inSlide: false };
        const icon = a.closest('.header__icons, .header__icon') ? 'Icons' : a.closest('.header__heading, .header__heading-link') ? 'Logo' : 'Main menu';
        return { position: ['Header', icon], slot: 'h|' + a.getAttribute('href') + '|' + lab, inSlide: false };
      }
      if (sec === 'footer') {
        // the nearest wrapper that has a column heading
        let h = '';
        for (let n: Element | null = a.parentElement; n && !n.matches('footer, .shopify-section'); n = n.parentElement) {
          const hds = n.querySelectorAll('h2, h3, h4, .footer-block__heading');
          if (hds.length > 1) break; // reached the wrapper of all columns: this link has no column heading
          if (hds.length === 1) { h = norm((hds[0] as HTMLElement).innerText || hds[0].textContent); break; }
        }
        const social = a.closest('.list-social, .footer__list-social, [class*="social"]');
        const g = social ? 'Social icons' : h ? h : a.closest('.footer__content-bottom, .policies, [class*="policies"], .footer__copyright, .policies-link') ? 'Bottom bar' : 'Footer';
        void social;
        return { position: ['Footer', g], slot: 'f|' + g + '|' + a.getAttribute('href') + '|' + lab, inSlide: false };
      }
      const parts = ['Homepage', shop ? secName(shop) : 'Main content'];
      const slide = a.closest(SLIDE) as HTMLElement | null;
      let slot = sid;
      if (slide && !slide.matches(DUP)) {
        const box = slide.parentElement!;
        const boxes = shop ? [...new Set([...shop.querySelectorAll(SLIDE)].map(x => x.parentElement))] : [box];
        if (boxes.length > 1) parts.push(/bottom|thumb|mini|nav/i.test(slide.className + ' ' + box.className) ? 'Mini slider' : 'Main slider');
        const sibs = [...box.children].filter(x => x.matches(SLIDE) && !x.matches(DUP));
        const idx = Number(slide.getAttribute('data-swiper-slide-index') ?? slide.getAttribute('data-slick-index') ?? sibs.indexOf(slide));
        const isCard = !!slide.querySelector('.card-wrapper, .card, [data-prids]');
        parts.push(`${isCard ? 'product' : 'slide'} ${idx + 1} of ${sibs.length}`);
        slot += `|s${boxes.indexOf(box)}-${idx}`;
        return { position: parts, slot, inSlide: true };
      }
      const card = a.closest('.card-wrapper, .card, .collection-list__item, .grid__item, [data-prids]');
      if (card && shop) {
        const cards = [...shop.querySelectorAll('.card-wrapper, .collection-list__item, .grid__item')].filter(c => !c.parentElement?.closest('.card-wrapper, .collection-list__item, .grid__item'));
        const i = cards.indexOf(card.closest('.card-wrapper, .collection-list__item, .grid__item') || card);
        if (i >= 0) { parts.push(`item ${i + 1} of ${cards.length}`); slot += `|c${i}`; }
      }
      return { position: parts, slot, inSlide: false };
    };
    const out: any[] = [];
    for (const root of roots) {
      for (const a of root.querySelectorAll('a[href]') as NodeListOf<HTMLAnchorElement>) {
        const raw = a.getAttribute('href') || '';
        const shop = a.closest('.shopify-section') as HTMLElement | null;
        // index among same-href anchors of the whole section (or document), counted like clicks.ts counts them
        const scope: ParentNode = shop || document;
        const nth = [...scope.querySelectorAll('a[href]')].filter(x => x.getAttribute('href') === raw).indexOf(a);
        if (a.closest(DUP + ', [aria-hidden="true"].slick-slide')) continue;
        const card = a.closest('[data-prids]') as HTMLElement | null;
        const prod = raw.match(/\/products\/([^/?#]+)/)?.[1];
        const sec = sectionOf(a), lab = label(a);
        const pos = positionOf(a, sec, lab);
        out.push({ rawHref: raw, label: lab, section: sec, visible: vis(a), productId: card?.dataset.prids || prod,
          position: pos.position, slot: pos.slot + '|' + raw, inSlide: pos.inSlide, secId: shop?.id, nth });
      }
    }
    return out;
  }, { rootSel, forced });
}

/** Hover each top-level menu item; collect what becomes visible and check its images. */
async function crawlMegaMenu(page: Page, cfg: Config, inv: Inventory, components: Discovery['components']) {
  const tops = await page.evaluate(() => {
    const vis = (window as any).__qaVis as (e: Element) => boolean;
    const out: { label: string; x: number; y: number }[] = [];
    document.querySelectorAll('header nav > ul > li, header .header__inline-menu > ul > li, header .list-menu--inline > li').forEach(li => {
      const t = li.querySelector('summary, a, button, span') as HTMLElement | null;
      if (!t || !vis(t)) return;
      const r = t.getBoundingClientRect();
      out.push({ label: t.innerText.trim().replace(/\s+/g, ' '), x: r.x + r.width / 2, y: r.y + r.height / 2 });
    });
    return out.filter((v, i, a) => v.label && a.findIndex(w => w.label === v.label) === i);
  });
  const baseline = new Set((await readAnchors(page, 'header')).filter(a => a.visible).map(a => a.rawHref + '|' + a.label));
  // images already visible before any menu opens (logo, header icons) do not belong to a menu panel
  const baseImgs = new Set(await page.evaluate(() => [...document.querySelectorAll('header img')].filter(i => (window as any).__qaVis(i)).map(i => (i as HTMLImageElement).currentSrc || (i as HTMLImageElement).src)));
  for (const t of tops) {
    const started = new Date().toISOString();
    await dismissPopups(page);
    await page.mouse.move(t.x, t.y);
    await page.waitForTimeout(700);
    let anchors = (await readAnchors(page, 'header')).filter(a => a.visible && !baseline.has(a.rawHref + '|' + a.label));
    let mode = 'hover';
    const isPlainLink = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('a[href]:not([href="#"])'), { x: t.x, y: t.y });
    if (!anchors.length && !isPlainLink) {
      // touch-style menus open on click (only for summary/button triggers, never real links)
      await page.mouse.click(t.x, t.y).catch(() => {});
      await page.waitForTimeout(700);
      anchors = (await readAnchors(page, 'header')).filter(a => a.visible && !baseline.has(a.rawHref + '|' + a.label));
      mode = 'click';
    }
    const topName = t.label;
    for (const a of anchors) inv.add({ ...a, section: 'megamenu', position: a.position?.[0] === 'Mega menu' ? a.position : ['Mega menu', topName] }, page.url(), 0, { kind: 'menu', topLabel: t.label });
    const rec = record(page);
    // every icon and image in the open panel is tested, however small
    const img = await checkImages(page, rec, cfg, 'header', 1);
    const tn = t.label;
    // keep what this panel shows: hidden copies (other panels, mobile drawer) and the header logo are not part of it
    const inPanel = new Set(await page.evaluate((label) => {
      const li = [...document.querySelectorAll('header nav > ul > li, header .list-menu--inline > li')].find(l => (l.querySelector('summary, a, button, span') as HTMLElement | null)?.innerText.trim().replace(/\s+/g, ' ') === label);
      return li ? [...li.querySelectorAll('img')].map(i => (i as HTMLImageElement).currentSrc || (i as HTMLImageElement).src) : [];
    }, t.label).catch(() => [] as string[]));
    const seenSrc = new Set<string>();
    img.images = img.images.filter(i => i.status !== 'SKIPPED' && !baseImgs.has(i.src) && (!inPanel.size || inPanel.has(i.src)) && !seenSrc.has(i.src) && !!seenSrc.add(i.src));
    for (const i of img.images) i.position = `Mega menu › ${tn}${i.position ? ` › ${i.position}` : ''}`;
    rec.stop();
    // a top item with its own link and no panel is a plain link, not a broken menu
    const ownLink = await page.evaluate((label) => {
      const li = [...document.querySelectorAll('header nav > ul > li, header .list-menu--inline > li')].find(l => (l.querySelector('summary, a, button, span') as HTMLElement | null)?.innerText.trim().replace(/\s+/g, ' ') === label);
      const a = li?.querySelector(':scope > a[href]') as HTMLAnchorElement | null;
      return a ? a.getAttribute('href') : null;
    }, t.label);
    const status: Status = !anchors.length && !ownLink ? 'FAIL' : img.check.status;
    components.push({
      id: `MENU-${components.length + 1}`,
      name: `Mega menu: ${t.label}`, kind: 'menu',
      status,
      steps: [{ step: `${mode} "${t.label}"`, url: page.url(), note: anchors.length ? `${anchors.length} links revealed; ${img.check.detail}` : ownLink ? `No panel; item links to ${ownLink}` : 'Nothing opened' }],
      failureReasons: status === 'FAIL' ? [!anchors.length && !ownLink ? 'Menu item opened nothing' : img.check.detail || 'Broken menu images'] : [],
      testedAt: started,
      images: img.images,
    });
    if (ownLink) inv.add({ rawHref: ownLink, label: t.label, section: 'header', visible: true }, page.url(), 0, { kind: 'none' });
    await page.mouse.move(5, 600);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }
}

/** Mobile/tablet: open the drawer and expand every nested level. */
async function crawlDrawer(page: Page, inv: Inventory, components: Discovery['components']) {
  const opened = await page.evaluate(() => {
    const s = document.querySelector('header-drawer summary, .header__icon--menu') as HTMLElement | null;
    s?.click();
    return !!s;
  });
  await page.waitForTimeout(1000);
  for (let round = 0; round < 3; round++) {
    await page.evaluate(() => {
      const vis = (window as any).__qaVis as (e: Element) => boolean;
      document.querySelectorAll('.menu-drawer details:not([open]) > summary').forEach(s => { if (vis(s)) (s as HTMLElement).click(); });
    });
    await page.waitForTimeout(700);
  }
  const anchors = (await readAnchors(page, '.menu-drawer, header-drawer, header')).filter(a => a.visible);
  for (const a of anchors) inv.add({ ...a, section: 'megamenu' }, page.url(), 0, { kind: 'drawer' });
  components.push({
    id: 'DRAWER-1', name: 'Mobile menu drawer', kind: 'drawer', status: opened && anchors.length ? 'PASS' : 'FAIL',
    steps: [{ step: 'Open drawer and expand all levels', url: page.url(), note: `${anchors.length} links visible` }],
    failureReasons: opened && anchors.length ? [] : ['Drawer did not open or showed no links'], testedAt: new Date().toISOString(),
  });
  await page.keyboard.press('Escape').catch(() => {});
}

/** Step through every carousel with its own visible controls; every slide must become visible. */
async function crawlCarousels(page: Page, inv: Inventory, components: Discovery['components']) {
  const SLIDE = '.swiper-slide:not(.swiper-slide-duplicate), .slick-slide:not(.slick-cloned), .slideshow__slide, .slider__slide';
  const NEXT = '.slider-button--next, .swiper-button-next, .slick-next, [aria-label="Next slide"], [aria-label="Slide right"], button[name="next"]';
  const DOTS = '.slider-counter__link, .slick-dots button, .swiper-pagination-bullet, [aria-label^="Go to slide"], [aria-label^="Load slide"]';
  // one entry per slider container (a section can hold several, e.g. a hero plus a thumbnail strip)
  const scopes = await page.evaluate((SLIDE) => {
    const out: { tag: string; sec: string }[] = [];
    let n = 0;
    document.querySelectorAll('main .shopify-section').forEach(sec => {
      const containers = new Set<Element>();
      sec.querySelectorAll(SLIDE).forEach(sl => { if (sl.parentElement) containers.add(sl.parentElement); });
      containers.forEach(c => {
        if (c.querySelectorAll(':scope > *').length < 2) return;
        const scope = c.closest('.swiper, slideshow-component, slider-component, .slick-slider') || c.parentElement || sec;
        const tag = `qa-slider-${++n}`;
        scope.setAttribute('data-qa-slider', tag);
        c.setAttribute('data-qa-slides', tag);
        out.push({ tag, sec: sec.id });
      });
    });
    return out;
  }, SLIDE);

  for (const { tag, sec: secId } of scopes) {
    const started = new Date().toISOString();
    const kind = await page.evaluate((t) => document.querySelector(`[data-qa-slider="${t}"]`)?.className.toString().split(/\s+/)[0] || 'slider', tag);
    const name = `${secId.split('__').pop() || secId} › ${kind}`;
    const sec = page.locator(`[data-qa-slider="${tag}"]`);
    // sections fade in when scrolled into view (opacity 0 while off-screen): bring it in and wait
    await page.evaluate((id) => document.getElementById(id)?.scrollIntoView({ block: 'center' }), secId).catch(() => {});
    await page.waitForTimeout(800);
    await dismissPopups(page);

    // slides are keyed by identity, not DOM position: loop mode re-orders them
    const snap = () => page.evaluate(({ tag, SLIDE }) => {
      const s = document.querySelector(`[data-qa-slides="${tag}"]`)!;
      const all = [...s.querySelectorAll(':scope > *')].filter(e => e.matches(SLIDE));
      const key = (e: Element, i: number) => e.getAttribute('data-swiper-slide-index') ?? e.getAttribute('data-slick-index') ?? (e.id || null) ??
        ((e.querySelector('img') as HTMLImageElement | null)?.getAttribute('src') || (e.querySelector('a') as HTMLAnchorElement | null)?.getAttribute('href') || String(i));
      const keys = all.map(key);
      return { total: new Set(keys).size, visible: all.map((e, i) => ((window as any).__qaVis(e) ? keys[i] : null)).filter(Boolean) as string[] };
    }, { tag, SLIDE });

    const first = await snap();
    const seen = new Set(first.visible);
    const total = first.total;
    const next = sec.locator(NEXT).filter({ visible: true }).first();
    const dots = sec.locator(DOTS).filter({ visible: true });
    const hasNext = (await next.count()) > 0;
    const dotCount = await dots.count();
    let used = '';
    let controlWorked = false;
    if (hasNext) {
      used = 'Next';
      for (let i = 0; i < total * 2 && seen.size < total; i++) {
        const before = seen.size;
        if (!(await next.click({ timeout: 3000 }).then(() => true).catch(() => false))) break;
        await page.waitForTimeout(550);
        (await snap()).visible.forEach(k => seen.add(k));
        if (seen.size > before) controlWorked = true;
      }
    }
    if (seen.size < total && dotCount) {
      used = used ? used + ' + dots' : 'dots';
      for (let d = 0; d < dotCount && seen.size < total; d++) {
        const before = seen.size;
        await dots.nth(d).click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(600);
        (await snap()).visible.forEach(k => seen.add(k));
        if (seen.size > before) controlWorked = true;
      }
    }
    if (seen.size < total) {
      // autoplaying sliders: watch for up to 3s per slide (max 15s)
      const until = Date.now() + Math.min(15_000, total * 3000);
      const before = seen.size;
      while (seen.size < total && Date.now() < until) {
        await page.waitForTimeout(700);
        (await snap()).visible.forEach(k => seen.add(k));
      }
      if (seen.size > before) used = used ? used + ' + autoplay' : 'autoplay';
    }

    let dragged = false;
    if (seen.size < total) {
      // last resort a user has: drag/swipe the strip right-to-left, several times
      const box = await page.locator(`[data-qa-slides="${tag}"]`).boundingBox().catch(() => null);
      if (box) {
        for (let i = 0; i < total && seen.size < total; i++) {
          const y = box.y + Math.min(box.height / 2, 40);
          const x0 = Math.min(box.x + box.width - 40, 1200), x1 = Math.max(box.x + 40, x0 - 500);
          await page.mouse.move(x0, y); await page.mouse.down();
          await page.mouse.move(x1, y, { steps: 12 }); await page.mouse.up();
          await page.waitForTimeout(600);
          const before = seen.size;
          (await snap()).visible.forEach(k => seen.add(k));
          if (seen.size > before) dragged = true;
        }
        if (dragged) used = used ? used + ' + drag' : 'drag';
      }
      // a drag that ended on a link may have navigated
      if (!page.url().startsWith(new URL(page.url()).origin) || new URL(page.url()).pathname !== '/') {
        await page.goBack().catch(() => {}); await page.waitForTimeout(1500);
      }
    }
    for (const a of await readAnchors(page, `[data-qa-slides="${tag}"]`, 'sliders')) inv.add(a, page.url(), 0, { kind: 'carousel' });

    const status: Status = seen.size >= total ? 'PASS' : 'FAIL';
    const note = `${seen.size}/${total} slides seen${used ? ` via ${used}` : ''}${hasNext ? '' : '; no visible arrows'}${dotCount ? `; ${dotCount} dots` : ''}`;
    components.push({
      id: `SLIDER-${components.filter(c => c.id.startsWith('SLIDER')).length + 1}`,
      name: `Slider: ${name}`, kind: 'slider',
      status,
      steps: [{ step: 'Step through slides with the visible controls', url: page.url(), note }],
      failureReasons: status === 'FAIL' ? [`Only ${seen.size} of ${total} slides could be reached${hasNext || dotCount ? (controlWorked ? '' : '; the controls had no effect') : ': no arrows or dots, no autoplay, and dragging did not move it'}`] : [],
      testedAt: started,
    });
  }
}

/** Clickable things that have no real destination: verify that clicking them does something. */
async function findDeadClickables(page: Page, cfg: Config, outDir: string): Promise<DeadClickable[]> {
  const cands = await page.evaluate(() => {
    const vis = (window as any).__qaVis as (e: Element) => boolean;
    const out: { idx: number; rawHref: string; label: string; section: string; targetExists: boolean }[] = [];
    const all = [...document.querySelectorAll('a')];
    all.forEach((a, idx) => {
      const h = a.getAttribute('href');
      const bad = h === null || h === '' || h === '#' || /^javascript:/i.test(h) || (h.startsWith('#') && h.length > 1);
      if (!bad || !vis(a)) return;
      if (a.closest('form, [role="dialog"], .slider-buttons, .slider-counter, .slick-dots')) return;
      if (h?.startsWith('#') && h.length > 1 && h !== '#MainContent' && document.getElementById(h.slice(1))) return; // valid in-page anchor
      if (h === '#MainContent') return;
      const sec = a.closest('footer') ? 'footer' : a.closest('header, .shopify-section-group-header-group') ? 'header' : 'homepage';
      out.push({ idx, rawHref: h ?? '(no href)', label: (a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\s+/g, ' ').trim().slice(0, 60), section: sec, targetExists: false });
    });
    return out;
  });
  const results: DeadClickable[] = [];
  for (const c of cands.slice(0, 25)) {
    const sig = () => page.evaluate(() => ({
      url: location.href,
      dialogs: [...document.querySelectorAll('[role="dialog"], details[open], .active, .is-open, .open')].filter(e => (window as any).__qaVis(e)).length,
      len: document.body.innerHTML.length,
    }));
    const before = await sig();
    await page.evaluate((idx) => (document.querySelectorAll('a')[idx] as HTMLElement).click(), c.idx).catch(() => {});
    await page.waitForTimeout(800);
    const after = await sig().catch(() => before);
    const effect = after.url.split('#')[0] !== before.url.split('#')[0] ? 'navigated' : after.dialogs !== before.dialogs ? 'opened UI' : Math.abs(after.len - before.len) > 200 ? 'changed page' : '';
    let shot: string | undefined;
    if (!effect) {
      shot = `${outDir}/screenshots/dead-${results.length + 1}.jpg`;
      await page.screenshot({ path: shot, type: 'jpeg', quality: 60 }).catch(() => (shot = undefined));
    }
    results.push({
      sourceUrl: before.url, section: c.section as Section, label: c.label || '(no text)', rawHref: c.rawHref,
      status: effect ? 'PASS' : 'FAIL',
      detail: effect ? `No href destination, but click ${effect}` : `Clickable element with href "${c.rawHref}" has no destination and clicking it had no visible effect`,
      screenshot: shot ? shot.replace(outDir + '/', '') : undefined,
    });
    if (after.url !== before.url) { await gotoSettled(page, before.url, cfg); await dismissPopups(page); }
  }
  return results;
}

/**
 * Homepage discovery: header, mega menu panels (hover), sliders (stepped with their own controls),
 * main content and footer links; popup; href-less clickables. Deeper pages are discovered while their
 * listing pages are being tested (see validate.ts), so no separate crawl is needed.
 */
export async function discover(browser: Browser, cfg: Config, inv: Inventory): Promise<Discovery> {
  const components: Discovery['components'] = [];
  const ctx = await newContext(browser, cfg);
  const page = await ctx.newPage();
  const home = cfg.baseUrl;
  const rec = record(page);

  console.log(`[discover] homepage ${home}`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const nav = await gotoSettled(page, home, cfg);
    const n = await page.locator('a[href]').count().catch(() => 0);
    if (!nav.error && n > 20) break;
    console.log(`[discover] homepage attempt ${attempt} incomplete (${nav.error ?? n + ' links'}); retrying`);
    if (attempt === 3) throw new Error(`Homepage did not load: ${nav.error ?? 'no links found'}`);
  }
  const homePerf = await measurePerf(page, 'Homepage', 'home', cfg);
  await dismissPopups(page);
  await scrollThrough(page);
  await page.waitForTimeout(800);
  const popups = await dismissPopups(page);
  if (popups.length) {
    const still = await page.evaluate(() => [...document.querySelectorAll('.contact-popup--wrapper, [aria-modal="true"]')].some(e => (window as any).__qaVis(e))).catch(() => false);
    components.push({
      id: 'POPUP-1', name: 'Scroll-triggered popup can be closed', kind: 'popup', status: still ? 'FAIL' : 'PASS',
      steps: [{ step: 'Scroll homepage, then click the popup close control', url: home, note: `Closed: ${popups.join(', ')}` }],
      failureReasons: still ? ['Popup stayed open after clicking its close control'] : [], testedAt: new Date().toISOString(),
    });
  }

  for (const a of (await readAnchors(page, 'header, .shopify-section-group-header-group')).filter(a => a.visible))
    inv.add(a, home, 0, { kind: 'none' });

  if (cfg.viewport === 'desktop') await crawlMegaMenu(page, cfg, inv, components);
  else await crawlDrawer(page, inv, components);
  if (page.url().split('#')[0] !== home) { await gotoSettled(page, home, cfg); await dismissPopups(page); }
  await dismissPopups(page);

  await crawlCarousels(page, inv, components);
  for (const a of await readAnchors(page, 'main, footer, .shopify-section-group-footer-group'))
    inv.add(a, home, 0, { kind: a.section === 'sliders' ? 'carousel' : 'none' });

  // homepage images (menus are checked per panel above)
  await scrollThrough(page);
  const img = await checkImages(page, rec, cfg, 'body');
  const homeImages = img.images.filter(i => i.context !== 'header' || i.status !== 'SKIPPED');

  const dead = await findDeadClickables(page, cfg, cfg.outDir);
  rec.stop();
  await ctx.close();
  console.log(`[discover] ${inv.all().length} links on the homepage; ${components.length} components; ${dead.length} href-less clickables`);
  return { deadClickables: dead, components, homePerf, homeImages };
}
