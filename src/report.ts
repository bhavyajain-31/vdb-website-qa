import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { median, rate } from './perf.js';
import { renderDashboard } from './dashboard.js';
import type { ImageResult, ImageStatus, LinkResult, PerfSample, RunReport, ScenarioResult, Severity } from './types.js';

export const AREAS: { key: string; label: string }[] = [
  { key: 'header', label: 'Header' },
  { key: 'megamenu', label: 'Menu' },
  { key: 'sliders', label: 'Sliders & banners' },
  { key: 'homepage', label: 'Homepage content' },
  { key: 'footer', label: 'Footer' },
  { key: 'category', label: 'Category links' },
  { key: 'plp', label: 'Product listings' },
  { key: 'pdp', label: 'Product detail pages' },
  { key: 'search', label: 'Search' },
];

export const PAGE_TYPES: Record<string, string> = {
  home: 'Homepage', collection: 'Collection', product: 'Product page', search: 'Search results',
  'diamond-search': 'Diamond search', 'gemstone-search': 'Gemstone search', 'rb-list': 'Ring Builder list',
  'rb-details': 'Ring Builder item', 'rb-start': 'Ring Builder start', wishlist: 'Wishlist', cart: 'Cart',
  page: 'Content page', policy: 'Policy page', login: 'Login', external: 'External site', mailto: 'Email link',
  tel: 'Phone link', anchor: 'In-page link', malformed: 'Broken link address', other: 'Other page',
};

export interface ImageEntry {
  src: string;
  status: ImageStatus;
  reason?: string;
  kind: 'img' | 'background';
  product: boolean;
  pages: string[];
  width?: number;
  height?: number;
  http?: number;
  productId?: string;
  position?: string;
  checks: number;
}

/** One row per unique image URL. An image counts as broken if it failed anywhere. */
export function imageReport(r: RunReport): { entries: ImageEntry[]; totals: Record<string, number> } {
  const all: ImageResult[] = [
    ...r.homeImages, ...r.scenarios.flatMap(s => s.images ?? []), ...r.links.flatMap(l => l.images),
  ];
  const by = new Map<string, ImageEntry & { st: Set<ImageStatus>; reasons: Partial<Record<ImageStatus, string>> }>();
  for (const i of all) {
    if (!i.src || i.src === '(no source)') {
      // images with no address are each their own entry
      const k = `nosrc|${i.pageUrl}|${by.size}`;
      by.set(k, { src: '(no image address)', status: i.status, reason: i.reason, kind: i.kind, product: !!i.product, pages: [i.pageUrl], checks: 1, st: new Set([i.status]), reasons: { [i.status]: i.reason } });
      continue;
    }
    let e = by.get(i.src);
    if (!e) { e = { src: i.src, status: i.status, kind: i.kind, product: !!i.product, pages: [], checks: 0, st: new Set(), reasons: {} }; by.set(i.src, e); }
    e.st.add(i.status);
    e.reasons[i.status] ??= i.reason;
    if (!e.pages.includes(i.pageUrl) && e.pages.length < 12) e.pages.push(i.pageUrl);
    if (i.status !== 'SKIPPED') e.checks++;
    e.product ||= !!i.product;
    e.position ??= i.position; e.width ??= i.naturalWidth; e.height ??= i.naturalHeight; e.http ??= i.httpStatus; e.productId ??= i.productId;
  }
  const entries: ImageEntry[] = [];
  for (const e of by.values()) {
    const status: ImageStatus = e.st.has('FAIL') ? 'FAIL' : e.st.has('PASS') ? 'PASS' : e.st.has('BLOCKED') ? 'BLOCKED' : 'SKIPPED';
    const { st: _st, reasons, ...rest } = e;
    void _st;
    entries.push({ ...rest, status, reason: reasons[status] });
  }
  const order: Record<ImageStatus, number> = { FAIL: 0, BLOCKED: 1, SKIPPED: 2, PASS: 3 };
  entries.sort((a, b) => order[a.status] - order[b.status] || a.src.localeCompare(b.src));
  const totals = {
    identified: entries.length,
    tested: entries.filter(e => e.status !== 'SKIPPED').length,
    ok: entries.filter(e => e.status === 'PASS').length,
    failed: entries.filter(e => e.status === 'FAIL').length,
    blocked: entries.filter(e => e.status === 'BLOCKED').length,
    skipped: entries.filter(e => e.status === 'SKIPPED').length,
    checks: all.filter(i => i.status !== 'SKIPPED').length,
  };
  return { entries, totals };
}

/** Components and scenarios that fail are critical (menus, sliders, search). Placeholder copy is minor. */
export function componentSeverity(s: ScenarioResult): Severity { return s.kind === 'copy' ? 'minor' : 'critical'; }

/** Site-wide placeholder copy, reported once instead of once per page. */
export function placeholderComponent(links: LinkResult[]): ScenarioResult[] {
  const ph = links.filter(l => l.placeholder?.length);
  if (!ph.length) return [];
  return [{
    id: 'COPY-1', name: 'Template placeholder text visible to shoppers', kind: 'copy', status: 'FAIL',
    steps: ph.slice(0, 15).map(l => ({ step: `"${l.placeholder![0].slice(0, 80)}"`, url: l.directUrl ?? l.href })),
    failureReasons: [`Demo text is visible on ${ph.length} page(s), e.g. "${ph[0].placeholder![0].slice(0, 90)}"`],
    testedAt: new Date().toISOString(),
  }];
}

export function summarize(r: RunReport) {
  const by = (s: string) => r.links.filter(l => l.status === s).length;
  const sev = (s: Severity) => r.links.reduce((n, l) => n + l.issues.filter(i => i.severity === s).length, 0);
  const compFails = r.scenarios.filter(s => s.status === 'FAIL');
  const deadFails = r.deadClickables.filter(d => d.status === 'FAIL').length;
  const img = imageReport(r).totals;
  return {
    total: r.links.length,
    pass: by('PASS'), warn: by('WARN'), fail: by('FAIL'), blocked: by('BLOCKED'), pending: by('PENDING'), skipped: by('SKIPPED'),
    critical: sev('critical') + compFails.filter(s => componentSeverity(s) === 'critical').length + deadFails,
    performance: sev('performance'),
    minor: sev('minor') + compFails.filter(s => componentSeverity(s) === 'minor').length,
    componentsFailed: compFails.length,
    deadFails,
    images: img,
  };
}

/** Every page load the run measured, best sample per URL. */
export function perfRows(r: RunReport, cfg: Config): (PerfSample & { samples?: number; id?: string; section?: string; linkLabel?: string })[] {
  const rows: (PerfSample & { samples?: number; id?: string; section?: string; linkLabel?: string })[] = [];
  if (r.homePerf.length) {
    // prefer loads measured with nothing else running (homepage discovery); fall back to all samples
    const alone = r.homePerf.filter(p => p.measuredAlone);
    const src = alone.length ? alone : r.homePerf;
    const ready = median(src.map(p => p.readyMs ?? 0));
    const m = (k: keyof PerfSample) => median(src.map(p => (p[k] as number) ?? 0));
    rows.push({
      ...r.homePerf[0], url: r.baseUrl, label: 'Homepage', pageType: 'home',
      ttfbMs: m('ttfbMs'), domReadyMs: m('domReadyMs'), loadMs: m('loadMs'), lcpMs: m('lcpMs'), readyMs: ready,
      rating: rate(ready, cfg), samples: src.length, measuredAlone: alone.length > 0,
    });
  }
  for (const l of r.links) if (l.perf) rows.push({ ...l.perf, id: l.id, section: l.section, linkLabel: l.label });
  return rows;
}

export function writeReports(r: RunReport, cfg: Config): { json: string; html: string } {
  fs.mkdirSync(cfg.outDir, { recursive: true });
  r.scenarios = [...r.scenarios.filter(s => s.kind !== 'copy'), ...placeholderComponent(r.links)];
  const json = path.join(cfg.outDir, 'results.json');
  fs.writeFileSync(json, JSON.stringify({ summary: summarize(r), ...r }, null, 1));
  const html = path.join(cfg.outDir, 'dashboard.html');
  fs.writeFileSync(html, renderDashboard(r, cfg));
  writeCsv(r, path.join(cfg.outDir, 'deeplinks.csv'));
  writePlacementsCsv(r, path.join(cfg.outDir, 'homepage-links.csv'));
  return { json, html };
}

function positionsOf(r: RunReport, l: LinkResult): string {
  const ps = (r.placements ?? []).filter(p => p.key === l.key).map(p => p.position.join(' › '));
  return ps.length ? ps.join(' | ') : (l.position ?? []).join(' › ');
}

function writeCsv(r: RunReport, file: string) {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['ID', 'Result', 'Severity', 'Link text', 'Position', 'Found in', 'Found on page', 'Link URL', 'Expected page', 'Actually opened', 'HTTP', 'Ready (s)', 'Product type', 'Problem', 'What to do', 'Tested at', 'From run'];
  const rows = r.links.map(l => [
    l.id, l.status, l.issues[0]?.severity ?? '', l.label, positionsOf(r, l), l.section, l.sourceUrl, l.href, PAGE_TYPES[l.destType] ?? l.destType,
    l.directUrl ?? l.clickUrl ?? '', l.directHttpStatus ?? '', l.perf?.readyMs ? (l.perf.readyMs / 1000).toFixed(1) : '',
    l.product?.kindLabel ?? '', l.failureReasons.join(' | '), l.issues.map(i => i.fix).join(' | '), l.testedAt, l.runId ?? '',
  ].map(q).join(','));
  fs.writeFileSync(file, '﻿' + [head.map(q).join(','), ...rows].join('\n'));
}

function writePlacementsCsv(r: RunReport, file: string) {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Place ID', 'Result', 'Position', 'Link text', 'Should open', 'Clicking opened', 'Destination result', 'Problem', 'Deeplink ID'];
  const rows = (r.placements ?? []).map(p => [p.pid, p.status, p.position.join(' › '), p.label, p.href, p.clickUrl ?? '', p.destStatus, p.reasons.join(' | '), p.linkId ?? ''].map(q).join(','));
  fs.writeFileSync(file, '\ufeff' + [head.map(q).join(','), ...rows].join('\n'));
}
