import type { Browser, Page } from 'playwright';
import type { Config } from './config.js';
import { dismissPopups, gotoSettled, newContext, reloadSettled, settle } from './browser.js';
import { readListing, waitForContent } from './content.js';
import { diffParams, shortUrl } from './urls.js';
import type { LinkResult, ScenarioResult, Status } from './types.js';

async function countOn(page: Page, cfg: Config, type: 'diamond-search' | 'gemstone-search' | 'search') {
  const st = await waitForContent(page, type, cfg);
  if (st === 'timeout') return undefined;
  const l = await readListing(page, type);
  return l.resultCount ?? l.displayed;
}

/**
 * Filters leaking between searches: open a colour diamond deeplink, then a shape deeplink in the
 * SAME session. The second must show what it shows in a fresh session, also after a reload.
 */
export async function sessionCarryOver(browser: Browser, cfg: Config, links: LinkResult[]): Promise<ScenarioResult[]> {
  const ds = links.filter(l => l.destType === 'diamond-search' && l.listing?.resultCount);
  const a = ds.find(l => new URL(l.href).searchParams.get('fancy'));
  const b = ds.find(l => l !== a && !new URL(l.href).searchParams.get('fancy') && new URL(l.href).searchParams.get('shapes'));
  const name = a && b ? `Diamond search: "${a.label}" then "${b.label}" in one visit` : 'Diamond search: two searches in one visit';
  if (!a || !b) return [{ id: 'SESSION-1', name, kind: 'session', status: 'PENDING', steps: [], failureReasons: ['Needs one colour and one shape diamond link that were tested with results'], testedAt: new Date().toISOString() }];
  const started = new Date().toISOString();
  const ctx = await newContext(browser, cfg);
  const page = await ctx.newPage();
  const steps: ScenarioResult['steps'] = [];
  const fails: string[] = [];
  const fresh = b.listing!.resultCount!;
  try {
    await gotoSettled(page, a.href, cfg); await dismissPopups(page);
    const c1 = await countOn(page, cfg, 'diamond-search');
    steps.push({ step: `Open "${a.label}"`, url: shortUrl(page.url(), cfg), resultCount: c1 });
    if (!c1) return [{ id: 'SESSION-1', name, kind: 'session', status: 'BLOCKED', steps, failureReasons: [`The first search ("${a.label}") showed no results, so the check could not run`], testedAt: started }];
    await gotoSettled(page, b.href, cfg);
    const c2 = await countOn(page, cfg, 'diamond-search');
    const d = diffParams(b.href, page.url(), cfg);
    steps.push({ step: `Then open "${b.label}" in the same visit`, url: shortUrl(page.url(), cfg), resultCount: c2, note: `${fresh} results when opened on its own` });
    if (d.injected.length) fails.push(`The previous search's filter was carried into the new one: ${d.injected.join(', ')}`);
    if (c2 !== fresh) fails.push(`"${b.label}" shows ${c2 ?? 'no'} results after a previous search, but ${fresh} when opened on its own`);
    await reloadSettled(page, cfg);
    const c3 = await countOn(page, cfg, 'diamond-search');
    steps.push({ step: 'Refresh the page', url: shortUrl(page.url(), cfg), resultCount: c3 });
    if (c3 !== fresh) fails.push(`After refresh: ${c3 ?? 'no'} results (expected ${fresh})`);
    let shot: string | undefined;
    if (fails.length) { shot = 'screenshots/session-1.jpg'; await page.screenshot({ path: `${cfg.outDir}/${shot}`, type: 'jpeg', quality: 55 }).catch(() => (shot = undefined)); }
    return [{ id: 'SESSION-1', name, kind: 'session', status: fails.length ? 'FAIL' : 'PASS', steps, failureReasons: fails, screenshot: shot, testedAt: started }];
  } catch (e) {
    return [{ id: 'SESSION-1', name, kind: 'session', status: 'BLOCKED', steps, failureReasons: [(e as Error).message.split('\n')[0]], testedAt: started }];
  } finally { await ctx.close(); }
}

/** Header search: submits to /search; a term that matches nothing shows an empty state. */
export async function searchScenarios(browser: Browser, cfg: Config): Promise<ScenarioResult[]> {
  const terms: { term: string; expectResults: boolean }[] = [{ term: 'ring', expectResults: true }, { term: 'qzxv-no-such-item', expectResults: false }];
  return Promise.all(terms.map(async (t, i) => {
    const started = new Date().toISOString();
    const ctx = await newContext(browser, cfg);
    const page = await ctx.newPage();
    const steps: ScenarioResult['steps'] = [];
    const fails: string[] = [];
    let status: Status = 'PASS';
    const name = `Header search: "${t.term}"`;
    try {
      await gotoSettled(page, cfg.baseUrl, cfg); await dismissPopups(page);
      const opened = await page.evaluate(() => { const s = document.querySelector('details-modal.header__search summary, .header__icon--search') as HTMLElement | null; s?.click(); return !!s; });
      await page.waitForTimeout(600);
      const input = page.locator('input[type="search"][name="q"]:visible').first();
      if (!opened || !(await input.isVisible().catch(() => false))) {
        status = 'FAIL'; fails.push('The search box did not open');
      } else {
        await input.fill(t.term);
        await input.press('Enter');
        await page.waitForURL(/\/search\?/, { timeout: 15_000 }).catch(() => {});
        await settle(page);
        const n = await countOn(page, cfg, 'search');
        const list = await readListing(page, 'search');
        steps.push({ step: `Search "${t.term}"`, url: shortUrl(page.url(), cfg), resultCount: n });
        if (!/\/search\?/.test(page.url()) || new URL(page.url()).searchParams.get('q') !== t.term) { status = 'FAIL'; fails.push(`Did not land on the search results page for "${t.term}"`); }
        if (t.expectResults && !n) { status = 'FAIL'; fails.push(`No results for "${t.term}"`); }
        if (!t.expectResults && list.displayed > 0) { status = 'FAIL'; fails.push(`A word that matches nothing shows ${list.displayed} unrelated products instead of "no results"`); }
        if (!t.expectResults && list.displayed === 0 && !list.emptyState) { status = 'FAIL'; fails.push('No products and no "no results" message'); }
      }
      let shot: string | undefined;
      if (status === 'FAIL') { shot = `screenshots/search-${i + 1}.jpg`; await page.screenshot({ path: `${cfg.outDir}/${shot}`, type: 'jpeg', quality: 55 }).catch(() => (shot = undefined)); }
      return { id: `SEARCH-${i + 1}`, name, kind: 'search' as const, status, steps, failureReasons: fails, screenshot: shot, testedAt: started };
    } catch (e) {
      return { id: `SEARCH-${i + 1}`, name, kind: 'search' as const, status: 'BLOCKED' as const, steps, failureReasons: [(e as Error).message.split('\n')[0]], testedAt: started };
    } finally { await ctx.close(); }
  }));
}
