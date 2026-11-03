import type { Config } from './config.js';
import type { DestType } from './types.js';

export function toAbsolute(raw: string, base: string): string | null {
  try { return new URL(raw, base).toString(); } catch { return null; }
}

export function isSameSite(url: string, cfg: Config): boolean {
  try { return new URL(url).host === new URL(cfg.baseUrl).host; } catch { return false; }
}

/** A raw href that cannot be a real destination, or that hides a URL in its fragment. */
export function malformedReason(raw: string, abs: string | null): string | null {
  const r = raw.trim();
  if (!r) return 'Empty href';
  if (!abs) return 'href is not a valid URL';
  if (/^#.+/.test(r) || r === '#') return null; // in-page anchor, handled separately
  const u = new URL(abs);
  if (/https?:\/\//i.test(u.hash) || /https?%3A%2F%2F/i.test(u.hash))
    return `URL is embedded in the fragment ("${u.hash.slice(0, 80)}…"); the browser stays on ${u.origin}${u.pathname}`;
  if (/https?:\/\/.*https?:\/\//i.test(r)) return 'href contains two URLs';
  if (/\s/.test(r) && !/%20/.test(r)) return 'href contains unescaped whitespace';
  return null;
}

export function classify(raw: string, abs: string | null, cfg: Config): DestType {
  const r = raw.trim();
  if (/^mailto:/i.test(r)) return 'mailto';
  if (/^tel:/i.test(r)) return 'tel';
  if (r.startsWith('#') || /^javascript:/i.test(r)) return 'anchor';
  if (!abs || malformedReason(raw, abs)) return 'malformed';
  if (!isSameSite(abs, cfg)) return 'external';
  const p = new URL(abs).pathname.replace(/\/+$/, '') || '/';
  if (p === '/') return 'home';
  if (/^\/collections\/[^/]+\/products\//.test(p) || /^\/products\//.test(p)) return 'product';
  if (/^\/collections\//.test(p)) return 'collection';
  if (/^\/search/.test(p)) return 'search';
  if (/\/apps\/vdb-app\/search-filters/.test(p)) return 'diamond-search';
  if (/\/apps\/vdb-app\/gemstone/.test(p)) return 'gemstone-search';
  if (/\/apps\/ring-creator\/rb-(stone|setting)-list/.test(p)) return 'rb-list';
  if (/\/apps\/ring-creator\/rb-(stone|setting)-details/.test(p)) return 'rb-details';
  if (/\/apps\/ring-creator\/rb-get-started/.test(p)) return 'rb-start';
  if (/\/apps\/vdb-wishlist/.test(p)) return 'wishlist';
  if (/^\/cart/.test(p)) return 'cart';
  if (/^\/policies\//.test(p)) return 'policy';
  if (/^\/pages\//.test(p)) return 'page';
  if (/customer_authentication|\/account(\/login)?/.test(p)) return 'login';
  return 'other';
}

export const LISTING_TYPES: DestType[] = ['collection', 'search', 'diamond-search', 'gemstone-search', 'rb-list'];

/** Key used to dedupe links: same path + same meaningful filters = same test. */
export function dedupeKey(abs: string, cfg: Config): string {
  try {
    const u = new URL(abs);
    const params = meaningful(abs, cfg);
    const keys = Object.keys(params).sort();
    const q = keys.map(k => `${k}=${params[k]}`).join('&');
    // keep non-meaningful params for app pages too, since the apps read them as filters
    const extra = [...u.searchParams.entries()]
      .filter(([k]) => !cfg.meaningfulParams.includes(k))
      .map(([k, v]) => `${k}=${v}`).sort().join('&');
    return `${u.host}${u.pathname.replace(/\/+$/, '')}?${q}|${extra}`;
  } catch { return abs; }
}

/** Meaningful query params, decoded and normalised for comparison. */
export function meaningful(abs: string, cfg: Config): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const u = new URL(abs);
    for (const [k, v] of u.searchParams.entries()) {
      if (!cfg.meaningfulParams.includes(k)) continue;
      if (v === '') continue;
      out[k] = normParam(v);
    }
  } catch { /* ignore */ }
  return out;
}

function normParam(v: string): string {
  return v.split(',').map(s => s.trim().toLowerCase()).sort().join(',');
}

export interface ParamDiff { missing: string[]; changed: string[]; injected: string[] }

/**
 * Compare meaningful params. `sort_by` may be added by the theme when absent, so an
 * added sort_by is not "injected"; anything else that appears is.
 */
export function diffParams(expected: string, actual: string, cfg: Config): ParamDiff {
  const e = meaningful(expected, cfg), a = meaningful(actual, cfg);
  const missing: string[] = [], changed: string[] = [], injected: string[] = [];
  for (const k of Object.keys(e)) {
    if (!(k in a)) missing.push(`${k}=${e[k]}`);
    else if (a[k] !== e[k]) changed.push(`${k}: ${e[k]} → ${a[k]}`);
  }
  for (const k of Object.keys(a)) {
    if (k in e) continue;
    if (k === 'sort_by' || k === 'page') continue;
    injected.push(`${k}=${a[k]}`);
  }
  // the VDB search app silently injects `fancy` from a previous search: also watch these
  for (const k of ['fancy', 'shapes', 'diamondSearchType', 'gem_type']) {
    try {
      const ev = new URL(expected).searchParams.get(k), av = new URL(actual).searchParams.get(k);
      if (!ev && av && !injected.some(x => x.startsWith(k + '='))) injected.push(`${k}=${av}`);
    } catch { /* ignore */ }
  }
  return { missing, changed, injected };
}

export function samePath(a: string, b: string): boolean {
  try {
    const x = new URL(a), y = new URL(b);
    return x.host === y.host && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '');
  } catch { return false; }
}

export function shortUrl(u: string | undefined, cfg: Config): string {
  if (!u) return '';
  return u.startsWith(cfg.baseUrl) ? '/' + u.slice(cfg.baseUrl.length) : u;
}

/** Tidy a link label for people: card dumps like "1.20 Carat Cushion $100.00 Stone Price Color…" → "1.20 Carat Cushion". */
export function cleanLabel(label: string): string {
  let l = label.replace(/\s+/g, ' ').trim();
  const cut = l.search(/\s(Rs\.?|₹|\$|€|£)\s?\d/);
  if (cut > 3) l = l.slice(0, cut);
  l = l.replace(/\s(Stone|Setting) Price.*$/i, '').replace(/\s\|\|\s.*$/, '').trim();
  return l.slice(0, 80) || '(no text)';
}

/** Stable identity of a link across runs. */
export function linkKey(destType: DestType, abs: string | null, sourceUrl: string, rawHref: string, label: string, cfg: Config): string {
  return destType === 'anchor' || destType === 'malformed' ? `${destType}|${sourceUrl}|${rawHref}|${label}` : dedupeKey(abs!, cfg);
}
