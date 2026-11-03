import type { Page } from 'playwright';
import type { Config } from './config.js';
import type { DestType, PerfSample } from './types.js';

/**
 * Read load timings for the current page from the browser's own Navigation Timing API.
 * `contentAtMs` is when the page's own content (results, product, stock number) was first seen,
 * measured from navigation start by content.ts.
 */
export async function measurePerf(page: Page, label: string, pageType: DestType, cfg: Config): Promise<PerfSample | undefined> {
  const m = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (!n) return null;
    const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    let transfer = 0; let slow: { url: string; ms: number } | undefined;
    for (const r of res) {
      transfer += r.transferSize || 0;
      if (r.startTime < (n.loadEventEnd || 1e9) && (!slow || r.duration > slow.ms)) slow = { url: r.name, ms: Math.round(r.duration) };
    }
    return {
      ttfb: Math.round(n.responseStart),
      dom: Math.round(n.domContentLoadedEventEnd),
      load: Math.round(n.loadEventEnd) || undefined,
      lcp: Math.round((window as any).__qaLcp || 0) || undefined,
      content: Math.round((window as any).__qaReadyAt || 0) || undefined,
      requests: res.length + 1,
      transferKB: Math.round((transfer + (n.transferSize || 0)) / 1024),
      slow,
    };
  }).catch(() => null);
  if (!m) return undefined;
  // "Ready" = the later of: main content painted (LCP) and the page's own content rendered.
  const candidates = [m.lcp, m.content].filter((v): v is number => typeof v === 'number' && v > 0);
  const readyMs = candidates.length ? Math.max(...candidates) : m.dom;
  return {
    url: page.url(), label, pageType,
    ttfbMs: m.ttfb, domReadyMs: m.dom, loadMs: m.load, lcpMs: m.lcp, contentMs: m.content, readyMs,
    rating: rate(readyMs, cfg),
    requests: m.requests, transferKB: m.transferKB || undefined,
    slowestResource: m.slow && m.slow.ms > 1500 ? m.slow : undefined,
    measuredAt: new Date().toISOString(),
  };
}

export function rate(ms: number | undefined, cfg: Config): PerfSample['rating'] {
  if (!ms) return 'unknown';
  return ms <= cfg.perf.fastMs ? 'fast' : ms <= cfg.perf.slowMs ? 'ok' : 'slow';
}

export function median(xs: number[]): number | undefined {
  const s = xs.filter(x => typeof x === 'number' && x > 0).sort((a, b) => a - b);
  if (!s.length) return undefined;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
