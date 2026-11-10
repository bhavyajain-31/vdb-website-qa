import type { Config } from './config.js';
import type { RawAnchor } from './discover.js';
import { classify, cleanLabel, linkKey, toAbsolute } from './urls.js';
import type { DiscoveredLink, Placement, Reveal } from './types.js';

/**
 * The set of unique links to test. Links are deduplicated by path + meaningful filters; every other
 * place the same destination appears is kept in `alsoFoundIn`. IDs are stable within a testing cycle
 * (they are stored in the progress file), so L0042 means the same link across resumed runs.
 */
export class Inventory {
  private byKey = new Map<string, DiscoveredLink>();
  private bySlot = new Map<string, Placement>();
  constructor(private cfg: Config, private ids: Record<string, string>, private next: { n: number; p?: number; d?: number }) {}

  static from(cfg: Config, links: DiscoveredLink[], ids: Record<string, string>, next: { n: number; p?: number; d?: number }, placements: Placement[] = []): Inventory {
    const inv = new Inventory(cfg, ids, next);
    for (const l of links) inv.byKey.set(l.key, l);
    for (const p of placements) inv.bySlot.set('P|' + p.pid, p);
    return inv;
  }

  /**
   * Visible placements. Each distinct CTA text is its own placement (a banner with "Statement pieces…" and
   * "SHOP NECKLACES" gives two rows); a text-less image/icon link is dropped when its card already has a text link.
   */
  placements() {
    const all = [...this.bySlot.values()];
    const withText = new Set(all.filter(p => p.label !== '(no text)').map(p => `${p.group}|${p.rawHref}`));
    return all.filter(p => p.label !== '(no text)' || !withText.has(`${p.group}|${p.rawHref}`));
  }
  /** Forget placements before re-crawling the homepage (ids stay stable for unchanged slots). */
  resetPlacements() { this.bySlot.clear(); }

  /** Record one visible place on the homepage where a link appears. */
  /** Placement made by the last add() call (null when the place was already known or not visible). */
  lastPlacement: Placement | null = null;

  private place(a: RawAnchor, key: string, label: string, reveal: Reveal, sourceUrl: string, depth: number) {
    this.lastPlacement = null;
    if (!a.slot) return;
    const shown = a.visible || a.inSlide || reveal.kind === 'menu' || reveal.kind === 'drawer';
    if (!shown) return;
    // homepage places: H001…; places on pages opened from the homepage: P0001… (scoped to that page)
    const home = depth === 0;
    let page = '';
    if (!home) { try { page = new URL(sourceUrl).pathname + new URL(sourceUrl).search; } catch { page = sourceUrl; } }
    const slotKey = (home ? 'S|' : 'D|' + page + '|') + a.slot + '|' + label;
    if (!this.ids[slotKey]) {
      if (home) { this.next.p = (this.next.p ?? 0) + 1; this.ids[slotKey] = `H${String(this.next.p).padStart(3, '0')}`; }
      else { this.next.d = (this.next.d ?? 0) + 1; this.ids[slotKey] = `P${String(this.next.d).padStart(4, '0')}`; }
    }
    const pid = this.ids[slotKey];
    if (this.bySlot.get('P|' + pid)) return;
    const pl: Placement = {
      pid, key, position: a.position ?? [], section: a.section, label, rawHref: a.rawHref, reveal,
      secId: a.secId, nth: a.nth, visibleAtLoad: a.visible && reveal.kind === 'none', group: (home ? '' : page + '|') + a.slot,
      sourceUrl, depth,
    };
    this.bySlot.set('P|' + pid, pl);
    this.lastPlacement = pl;
  }

  private idFor(key: string): string {
    if (!this.ids[key]) this.ids[key] = `L${String(++this.next.n).padStart(4, '0')}`;
    return this.ids[key];
  }

  has(key: string) { return this.byKey.has(key); }
  get(key: string) { return this.byKey.get(key); }

  add(a: RawAnchor, sourceUrl: string, depth: number, reveal: Reveal): DiscoveredLink | null {
    const abs = toAbsolute(a.rawHref, sourceUrl);
    const destType = classify(a.rawHref, abs, this.cfg);
    const label = cleanLabel(a.label || '');
    const key = linkKey(destType, abs, sourceUrl, a.rawHref, label, this.cfg);
    this.place(a, key, label, reveal, sourceUrl, depth);
    const existing = this.byKey.get(key);
    if (existing) {
      existing.alsoFoundIn ??= [];
      if (existing.alsoFoundIn.length < 20 && !existing.alsoFoundIn.some(x => x.sourceUrl === sourceUrl && x.label === label))
        existing.alsoFoundIn.push({ sourceUrl, section: a.section, label });
      if ((existing.label === '(no text)' || /^[a-z0-9.,-]+$/.test(existing.label)) && label !== '(no text)' && !/^[a-z0-9.,-]+$/.test(label)) existing.label = label;
      return null;
    }
    const link: DiscoveredLink = {
      key, id: this.idFor(key), sourceUrl, section: a.section, label, rawHref: a.rawHref,
      href: abs || a.rawHref, destType, depth, reveal, productId: a.productId, position: a.position,
    };
    this.byKey.set(key, link);
    return link;
  }

  all() { return [...this.byKey.values()]; }
}
