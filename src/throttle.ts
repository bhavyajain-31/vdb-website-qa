/**
 * Shopify's app proxy (ring builder, diamond & gemstone search under /apps/...) answers bursts
 * of requests with HTTP 429 "Too Many Requests". In the previous tool that produced dozens of
 * false failures and a long serial re-test. This gate keeps app page loads below the limit and,
 * when a 429 does happen, pauses all app loads briefly and lets the caller retry.
 */
import type { Config } from './config.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class AppGate {
  private active = 0;
  private lastStart = 0;
  private cooldownUntil = 0;
  private backoffMs = 6000;
  hits429 = 0;
  constructor(private max: number, private gapMs: number) {}

  static isApp(url: string): boolean {
    try { return /^\/apps\//.test(new URL(url).pathname); } catch { return false; }
  }

  /** Wait for a slot when `url` is an app-proxy page. Returns a release function. */
  async acquire(url: string): Promise<() => void> {
    if (!AppGate.isApp(url)) return () => {};
    for (;;) {
      const now = Date.now();
      const wait = Math.max(this.cooldownUntil - now, this.lastStart + this.gapMs - now);
      if (this.active < this.max && wait <= 0) break;
      await sleep(Math.max(100, Math.min(wait, 1000)));
    }
    this.active++;
    this.lastStart = Date.now();
    let released = false;
    return () => { if (!released) { released = true; this.active--; } };
  }

  /** Called on HTTP 429/503 from the app proxy: pause every app load, growing the pause each time. */
  rateLimited(): number {
    this.hits429++;
    const wait = this.backoffMs;
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + wait);
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    return wait;
  }

  /** A background API call was rate limited: short shared pause, no escalation. */
  apiLimited() { this.hits429++; this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + 3000); }

  ok() { this.backoffMs = 6000; }
}

export let gate = new AppGate(3, 350);
export function configureGate(cfg: Config) { gate = new AppGate(cfg.appConcurrency, cfg.appGapMs); }
