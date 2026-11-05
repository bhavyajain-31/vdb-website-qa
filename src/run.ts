/**
 * Entry point: npm run qa -- [options]   (see --help)
 *
 * 1. Load progress (resume) or start a new testing cycle.
 * 2. Homepage discovery: menus, sliders, popup, links (skipped when resuming).
 * 3. One task pool, `concurrency` browser sessions:
 *      - homepage click tests (batches of links, one homepage load per batch, clicks intercepted)
 *      - deeplink tests (each link opened directly in a fresh session); listing pages add their product
 *        cards as new tasks, already click-tested on the listing page
 *    New tasks stop starting when the time budget is reached; the rest is PENDING for the next run.
 * 4. Session and header-search scenarios, then the report.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext } from 'playwright';
import { configForReport, loadConfig, type Config } from './config.js';
import { dismissPopups, gotoSettled, launch, newContext, scrollThrough, withTimeout } from './browser.js';
import { configureGate, gate } from './throttle.js';
import { discover } from './discover.js';
import { Inventory } from './inventory.js';
import { clickTest, CLICK_EXEMPT, type ClickTarget } from './clicks.js';
import { seedRefreshSlots, validateLink } from './validate.js';
import { waitForContent } from './content.js';
import { rate } from './perf.js';
import { measurePerf } from './perf.js';
import { searchScenarios, sessionCarryOver } from './scenarios.js';
import { loadState, needsRun, saveState, type State } from './state.js';
import { pageStatus } from './content.js';
import { assemble, assemblePlacement } from './results.js';
import { writeReports, summarize } from './report.js';
import type { ClickOutcome, DiscoveredLink, LinkResult, RunReport, Validation } from './types.js';

type Task = { kind: 'home-clicks'; targets: ClickTarget[] } | { kind: 'validate'; link: DiscoveredLink };

const tag = (s: string) => ({ PASS: 'ok  ', WARN: 'warn', FAIL: 'FAIL', BLOCKED: 'BLKD', PENDING: 'pend', SKIPPED: 'skip' } as Record<string, string>)[s] ?? s;

/** Click-test homepage placements; target.id is the placement id (H001…). */
async function homeClicks(browser: Browser, targets: ClickTarget[], cfg: Config, st: State, ctxRef: { ctx?: BrowserContext }) {
  const ctx = await newContext(browser, cfg);
  ctxRef.ctx = ctx;
  const page = await ctx.newPage();
  try {
    await gotoSettled(page, cfg.baseUrl, cfg);
    const perf = await measurePerf(page, 'Homepage', 'home', cfg);
    if (perf) st.homePerf.push(perf);
    await dismissPopups(page);
    await scrollThrough(page);
    await dismissPopups(page);
    for (const t of targets) {
      let o: ClickOutcome;
      try { o = await clickTest(ctx, page, t, cfg); }
      catch (e) { o = { checks: [{ name: 'Click from source', status: 'BLOCKED', mandatory: true, detail: (e as Error).message.split('\n')[0] }], at: new Date().toISOString() }; }
      st.placementClicks[t.id] = o;
      const s = pageStatus(o.checks);
      if (s !== 'PASS') console.log(`  [click] ${tag(s)} ${t.id} ${t.label.slice(0, 40)} ${o.checks.find(c => c.status !== 'PASS')?.detail?.slice(0, 90) ?? ''}`);
    }
  } finally { await ctx.close().catch(() => {}); }
}

/** A deeplink's click result: from its homepage placements (worst one wins), or from the page it was found on. */
function clickFor(st: State, l: DiscoveredLink): ClickOutcome | undefined {
  if (l.depth === 0) {
    const outs = st.placements.filter(p => p.key === l.key).map(p => st.placementClicks[p.pid]).filter(Boolean);
    if (outs.length) {
      const rank: Record<string, number> = { FAIL: 0, WARN: 1, BLOCKED: 2, PENDING: 3, PASS: 4, SKIPPED: 5 };
      return outs.sort((a, b) => rank[pageStatus(a.checks)] - rank[pageStatus(b.checks)])[0];
    }
  }
  return st.clicks[l.key];
}

async function main() {
  const cfg = loadConfig();
  configureGate(cfg);
  const t0 = Date.now();
  const runId = new Date(t0).toISOString();
  const budgetMs = cfg.timeBudgetMin > 0 ? cfg.timeBudgetMin * 60_000 : Infinity;
  const reserveMs = 90_000; // scenarios + report
  const { state: st, resumed, reason } = loadState(cfg);
  fs.mkdirSync(path.join(cfg.outDir, 'screenshots'), { recursive: true });
  if (!resumed) {
    // a new cycle: old screenshots belong to the old cycle
    fs.rmSync(path.join(cfg.outDir, 'screenshots'), { recursive: true, force: true });
    fs.mkdirSync(path.join(cfg.outDir, 'screenshots'), { recursive: true });
  }
  console.log(`VDB QA → ${cfg.baseUrl} · ${cfg.viewport} · depth ${cfg.maxDepth} · ${cfg.concurrency} sessions · budget ${cfg.timeBudgetMin || '∞'} min`);
  console.log(resumed ? `[resume] continuing cycle ${st.cycleId} (${Object.keys(st.validations).length} links already tested)` : `[cycle] new cycle ${st.cycleId}: ${reason}`);
  st.runs.push({ runId, startedAt: runId, executed: 0, carriedOver: 0 });
  const run = st.runs[st.runs.length - 1];

  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log('\n[stop] Ctrl+C: finishing tests in progress, then writing the report (press again to quit now)');
  });

  const browser = await launch(cfg);
  const inv = Inventory.from(cfg, st.links, st.ids, st.next, st.placements);
  try {
    // ---- homepage discovery
    if (!st.discovered || cfg.rediscover) {
      inv.resetPlacements();
      const d = await discover(browser, cfg, inv);
      st.components = d.components.map(c => ({ ...c, runId }));
      st.deadClickables = d.deadClickables;
      if (d.homePerf) st.homePerf.push({ ...d.homePerf, measuredAlone: true });
      st.homeImages = d.homeImages;
      st.discovered = true;
      st.links = inv.all();
      st.placements = inv.placements();
      const live = new Set(st.placements.map(p => p.pid));
      for (const pid of Object.keys(st.placementClicks)) if (!live.has(pid)) delete st.placementClicks[pid];
      saveState(cfg, st, true);
      console.log(`[discover] ${st.placements.length} visible link placements on the homepage`);
      console.log(`[discover] done in ${Math.round((Date.now() - t0) / 1000)}s`);
    }

    // ---- build the task queue from what still needs running
    const inScope = (l: DiscoveredLink) => !cfg.only || cfg.only.test(l.label) || cfg.only.test(l.href);
    const valNeeded = (l: DiscoveredLink) => {
      const v = st.validations[l.key];
      if (v?.status === 'SKIPPED' && l.destType === 'external' && cfg.checkExternal) return true;
      return needsRun(v?.status, v?.attempts ?? 0, cfg);
    };
    let scheduled = Object.keys(st.validations).length;
    const overCap = new Set<string>();
    const queue: Task[] = [];
    const ordered = inv.all().filter(inScope).sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
    // every visible homepage placement is clicked on its own (same URL in menu + slider + footer = 3 clicks)
    const homeTargets: ClickTarget[] = st.placements.flatMap(p => {
      const l = inv.get(p.key);
      if (!l || CLICK_EXEMPT.has(l.destType) || !inScope(l)) return [];
      const c = st.placementClicks[p.pid];
      if (c && !needsRun(pageStatus(c.checks), 0, cfg)) return [];
      return [{ ...l, id: p.pid, label: p.label, section: p.section, reveal: p.reveal, rawHref: p.rawHref, sourceUrl: cfg.baseUrl, secId: p.secId, nth: p.nth }];
    });
    const homeLinks = homeTargets;
    const batch = Math.max(8, Math.ceil(homeTargets.length / 2));
    for (let i = 0; i < homeTargets.length; i += batch) queue.push({ kind: 'home-clicks', targets: homeTargets.slice(i, i + batch) });
    const enqueue = (l: DiscoveredLink) => {
      if (!inScope(l) || !valNeeded(l)) return;
      if (!st.validations[l.key]) { if (scheduled >= cfg.maxLinks) { overCap.add(l.key); return; } scheduled++; }
      queue.push({ kind: 'validate', link: l });
    };
    for (const l of ordered) enqueue(l);
    const carried = Object.keys(st.validations).length;
    console.log(`[plan] ${queue.filter(t => t.kind === 'validate').length} links to test, ${homeLinks.length} homepage clicks, ${carried} results carried over from earlier runs`);

    seedRefreshSlots(Object.values(st.validations).filter(v => v.checks.some(c => c.name === 'Refresh')).map(v => v.directUrl ?? ''));

    // ---- task pool
    let active = 0, done = 0, stoppedReason: string | undefined;
    const harvest = {
      inv,
      found: (l: DiscoveredLink, click?: ClickOutcome) => {
        if (click) st.clicks[l.key] = click;
        st.links = inv.all();
        enqueue(l);
      },
      // the first homepage place of a link (exact CTA text), or the route recorded when it was found deeper
      routeOf: (l: DiscoveredLink) => {
        const p = st.placements.find(p => p.key === l.key && p.label !== '(no text)') ?? st.placements.find(p => p.key === l.key);
        if (p) return [...p.position, `"${p.label}"`];
        return l.position?.length ? [...l.position.slice(0, -1), `${l.position[l.position.length - 1]} "${l.label}"`] : [`"${l.label}"`];
      },
    };
    // keep time for re-testing failures alone at the end (about 25 s each, at most 5 min)
    const recheckMs = () => Math.min(300_000, Object.values(st.validations).filter(v => v.status === 'FAIL' && !v.recheck).length * 25_000);
    const overBudget = () => Date.now() - t0 > budgetMs - reserveMs - recheckMs();
    await Promise.all(Array.from({ length: cfg.concurrency }, async (_, w) => {
      for (;;) {
        if (interrupted) { stoppedReason ??= 'Stopped by user (Ctrl+C)'; return; }
        if (overBudget()) { stoppedReason ??= `Time budget of ${cfg.timeBudgetMin} min reached`; return; }
        const task = queue.shift();
        if (!task) {
          if (active === 0) return;
          await new Promise(r => setTimeout(r, 300));
          continue;
        }
        active++;
        const ctxRef: { ctx?: BrowserContext } = {};
        try {
          if (task.kind === 'home-clicks') {
            await withTimeout(Math.max(cfg.caseTimeoutMs, task.targets.length * 15_000), ctxRef, () => homeClicks(browser, task.targets, cfg, st, ctxRef), () => undefined);
          } else {
            const l = task.link;
            const prev = st.validations[l.key];
            const v = await withTimeout<Validation>(cfg.caseTimeoutMs, ctxRef, () => validateLink(browser, l, cfg, runId, harvest, ctxRef), () => ({
              status: 'BLOCKED', checks: [{ name: 'Validation', status: 'BLOCKED', mandatory: true, detail: `Test took longer than the ${cfg.caseTimeoutMs / 1000}s time limit` }],
              images: [], testedAt: new Date().toISOString(), durationMs: cfg.caseTimeoutMs, attempts: 1, runId,
            }));
            if (interrupted && v.status === 'BLOCKED') continue; // aborted by Ctrl+C: leave it pending
            v.attempts = (prev?.attempts ?? 0) + 1;
            st.validations[l.key] = v;
            run.executed++;
            done++;
            const r = assemble(l, v, clickFor(st, l), runId);
            const el = Math.round((Date.now() - t0) / 1000);
            console.log(`[${String(done).padStart(3)} | ${String(Math.floor(el / 60)).padStart(2)}:${String(el % 60).padStart(2, '0')} | w${w}] ${tag(r.status)} ${l.id} ${l.section.padEnd(8)} ${r.label.slice(0, 38).padEnd(38)} ${(v.durationMs / 1000).toFixed(0).padStart(3)}s ${r.issues[0] ? r.issues[0].title : ''}`);
          }
        } catch (e) {
          console.log(`[error] ${(e as Error).message.split('\n')[0]}`);
        } finally {
          active--;
          saveState(cfg, st);
        }
      }
    }));
    st.links = inv.all();

    // ---- re-test every failure on its own, one at a time, before reporting it.
    // Many failures under parallel load are the store being busy (results not loading, popups not opening).
    const toRecheck = inv.all().filter(l => st.validations[l.key]?.status === 'FAIL' && !st.validations[l.key].recheck);
    if (toRecheck.length && !interrupted) {
      console.log(`[recheck] re-testing ${toRecheck.length} failed links one at a time`);
      for (const l of toRecheck) {
        if (Date.now() - t0 > budgetMs - reserveMs) break;
        const first = st.validations[l.key];
        const ctxRef: { ctx?: BrowserContext } = {};
        const again = await withTimeout<Validation | null>(cfg.caseTimeoutMs, ctxRef, () => validateLink(browser, l, cfg, runId, null, ctxRef), () => null);
        if (!again) continue;
        const firstFails = first.checks.filter(c => c.mandatory && c.status === 'FAIL').map(c => `${c.name}: ${c.detail ?? ''}`);
        if (again.status === 'FAIL') {
          again.recheck = 'confirmed';
          for (const c of again.checks) if (c.mandatory && c.status === 'FAIL') c.detail = `${c.detail ?? ''} (confirmed: failed again when re-tested on its own)`;
        } else {
          again.recheck = 'cleared';
          again.firstFailure = firstFails;
          again.checks.push({ name: 'Recheck', status: 'PASS', mandatory: false, detail: `Failed during the busy parallel run (${firstFails.map(f => f.split(':')[0]).join(', ')}); passed when re-tested on its own` });
        }
        again.attempts = first.attempts + 1;
        st.validations[l.key] = again;
        console.log(`  [recheck] ${l.id} ${again.recheck === 'confirmed' ? 'still FAILS' : 'now ' + again.status} ${l.label.slice(0, 40)}`);
        saveState(cfg, st);
      }
      // homepage clicks that failed: click them again on a fresh homepage
      const failedClicks = st.placements.filter(p => st.placementClicks[p.pid] && pageStatus(st.placementClicks[p.pid].checks) === 'FAIL');
      if (failedClicks.length && Date.now() - t0 < budgetMs - reserveMs) {
        const targets = failedClicks.flatMap(p => { const l = inv.get(p.key); return l ? [{ ...l, id: p.pid, label: p.label, section: p.section, reveal: p.reveal, rawHref: p.rawHref, sourceUrl: cfg.baseUrl, secId: p.secId, nth: p.nth }] : []; });
        await homeClicks(browser, targets, cfg, st, {});
      }
    }

    // ---- confirm slow pages: re-measure them one at a time, without the test's own load on the machine
    const slow = inv.all().map(l => ({ l, v: st.validations[l.key] })).filter(x => x.v?.perf?.rating === 'slow' && !x.v.perf.measuredAlone)
      .sort((a, b) => (b.v.perf!.readyMs ?? 0) - (a.v.perf!.readyMs ?? 0)).slice(0, cfg.confirmSlow);
    if (slow.length && !interrupted && Date.now() - t0 < budgetMs - reserveMs - 45_000) {
      console.log(`[speed] re-measuring ${slow.length} slow pages one at a time`);
      const ctx = await newContext(browser, cfg, true);
      try {
        for (const { l, v } of slow) {
          if (Date.now() - t0 > budgetMs - reserveMs) break;
          const page = await ctx.newPage();
          try {
            const nav = await gotoSettled(page, l.href, cfg);
            if (nav.error) continue;
            const ready = await waitForContent(page, l.destType, cfg);
            const p = await measurePerf(page, v.perf!.label, v.perf!.pageType, cfg);
            // a timeout or a slower result than under load means something transient happened: keep it unconfirmed
            if (ready !== 'timeout' && p?.readyMs && p.readyMs <= (v.perf!.readyMs ?? Infinity) * 1.1) {
              const firstMs = v.perf!.readyMs;
              v.perf = { ...p, measuredAlone: true, firstMs };
              const c = v.checks.find(c => c.name === 'Page speed');
              if (c) {
                c.mandatory = true;
                c.status = p.rating === 'slow' ? 'FAIL' : 'PASS';
                c.detail = `Ready in ${(p.readyMs / 1000).toFixed(1)} s when measured alone${firstMs ? ` (${(firstMs / 1000).toFixed(1)} s during the busy test run)` : ''}`;
              }
              v.status = pageStatus(v.checks);
            }
          } finally { await page.close().catch(() => {}); }
        }
      } finally { await ctx.close().catch(() => {}); }
      saveState(cfg, st);
    }
    void rate;

    // ---- scenarios (once per cycle unless they could not run)
    const linksNow = () => inv.all().map(l => assemble(l, st.validations[l.key], clickFor(st, l), runId, overCap.has(l.key)));
    if (!interrupted && Date.now() - t0 < budgetMs) {
      const need = (id: string) => needsRun(st.scenarios[id]?.status, 0, cfg);
      const jobs: Promise<void>[] = [];
      if (need('SEARCH-1') || need('SEARCH-2')) jobs.push(searchScenarios(browser, cfg).then(r => { for (const s of r) st.scenarios[s.id] = { ...s, runId }; }));
      if (need('SESSION-1')) jobs.push(sessionCarryOver(browser, cfg, linksNow()).then(r => { for (const s of r) st.scenarios[s.id] = { ...s, runId }; }));
      if (jobs.length) { console.log('[scenarios] header search, filters across searches'); await Promise.all(jobs); }
    }

    // ---- report
    const links: LinkResult[] = linksNow();
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.now() - t0;
    run.carriedOver = links.filter(l => l.carriedOver).length;
    run.stoppedReason = stoppedReason;
    saveState(cfg, st, true);
    const report: RunReport = {
      baseUrl: cfg.baseUrl, cycleId: st.cycleId, runId,
      startedAt: runId, finishedAt: run.finishedAt, durationMs: run.durationMs,
      config: configForReport(cfg), runs: st.runs,
      links,
      placements: st.placements.map(p => {
        const l = links.find(x => x.key === p.key);
        return assemblePlacement(p, l, st.placementClicks[p.pid], !!l && CLICK_EXEMPT.has(l.destType));
      }),
      deadClickables: st.deadClickables, scenarios: [...st.components, ...Object.values(st.scenarios)],
      homePerf: st.homePerf, homeImages: st.homeImages, stoppedReason,
    };
    const out = writeReports(report, cfg);
    const s = summarize(report);
    const mins = (run.durationMs / 60000).toFixed(1);
    console.log(`\nFinished in ${mins} min${stoppedReason ? ` (${stoppedReason})` : ''}. Rate-limit pauses: ${gate.hits429}.`);
    console.log(`Links: ${s.total} · passed ${s.pass} · passed with warnings ${s.warn} · failed ${s.fail} · could not verify ${s.blocked} · not run yet ${s.pending} · skipped ${s.skipped}`);
    console.log(`Issues: ${s.critical} critical · ${s.performance} performance · ${s.minor} minor · images: ${s.images.failed} broken of ${s.images.tested} tested`);
    console.log(`Dashboard: ${out.html}`);
    if (s.pending) console.log(`${s.pending} links are still pending: run "npm run qa" again to continue.`);
    process.exitCode = s.fail ? 1 : 0;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch(e => { console.error(e); process.exit(2); });
