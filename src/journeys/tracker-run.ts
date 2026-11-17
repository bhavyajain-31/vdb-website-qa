// Daily monitoring tracker (TC-01 … TC-33; TC-26, TC-29, TC-30 stay manual).
// Usage: npm run qa:tracker   (options: --headed, --out <dir>, --state <file>, --concurrency <n>, --only <regex on TC IDs>)
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { launch } from '../browser.js';
import { configureGate } from '../throttle.js';
import { writeReports } from '../report.js';
import type { RunReport } from '../types.js';
import { PERF, Suite } from './harness.js';
import type { CaseResult, JourneyReport } from './types.js';
import { loadTracker, trackerFile } from './store.js';
import { TRACKER } from './tracker-catalog.js';
import { defineTracker, trackerDiamonds, trackerHome, trackerMobile, trackerSettingFirst, trackerShop, trackerStoneFirst, TRACKER_GROUPS } from './tracker.js';

const STATUS: Record<string, string> = { PASS: 'Passed', WARN: 'Passed with warnings', FAIL: 'Failed', BLOCKED: "Couldn't verify", SKIPPED: 'Manual testing', PENDING: 'Not run' };
const csvCell = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

/** A new, standalone results file for this run (it does not follow or touch the tracker sheet). */
export function trackerCsv(jr: JourneyReport): { name: string; text: string } {
  const ist = (iso: string) => { const d = new Date(new Date(iso).getTime() + 330 * 60_000); return d.toISOString().slice(0, 16).replace('T', ' ') + ' IST'; };
  const head = ['Test ID', 'Flow', 'Test case', 'Steps', 'Expected result', 'Result', 'What happened', 'Reason', 'Tested at', 'Screenshot'];
  const rows = TRACKER.map(t => {
    const r = jr.cases.find(x => x.id === t.id);
    return [t.id, t.area, t.title, t.steps, t.expected, STATUS[t.manual ? 'SKIPPED' : r?.status ?? 'PENDING'], t.manual ? `Manual testing: ${t.manualReason ?? 'not automated'}` : r?.actual ?? '', (r?.reasons ?? []).join(' | '), r?.testedAt ? ist(r.testedAt) : '', r?.screenshot ?? ''];
  });
  const text = [head, ...rows].map(r => r.map(c => csvCell(String(c ?? ''))).join(',')).join('\n') + '\n';
  return { name: 'daily-tracker-results.csv', text };
}

async function main() {
  const cfg = loadConfig();
  configureGate(cfg);
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const suite = new Suite(cfg);
  defineTracker(suite);
  const browser = await launch(cfg);
  const groups = [
    { name: 'Ring Builder: setting first, 3D, quiz, configurators', ids: TRACKER_GROUPS.settingFirst, run: () => trackerSettingFirst(browser, cfg, suite) },
    { name: 'Ring Builder: stone first, gemstones', ids: TRACKER_GROUPS.stoneFirst, run: () => trackerStoneFirst(browser, cfg, suite) },
    { name: 'Diamond Search', ids: TRACKER_GROUPS.diamonds, run: () => trackerDiamonds(browser, cfg, suite) },
    { name: 'Search, collections, product page, cart', ids: TRACKER_GROUPS.shop, run: () => trackerShop(browser, cfg, suite) },
    { name: 'Homepage, menus, content', ids: TRACKER_GROUPS.home, run: () => trackerHome(browser, cfg, suite) },
    { name: 'Phone screen', ids: TRACKER_GROUPS.mobile, run: () => trackerMobile(browser, cfg, suite) },
  ].filter(g => !cfg.only || g.ids.some(id => cfg.only!.test(id)));
  const parallel = Math.max(1, Math.min(3, cfg.concurrency)); // 3 at a time: the store answers 'too many requests' above that
  console.log(`Daily tracker: ${TRACKER.filter(t => !t.manual).length} automated cases in ${groups.length} groups, ${parallel} at a time`);
  try {
    const queue = [...groups];
    await Promise.all(Array.from({ length: parallel }, async () => {
      for (let g = queue.shift(); g; g = queue.shift()) {
        console.log(`[${g.name}]`);
        try { await g.run(); } catch (e) { console.error(`  group stopped: ${(e as Error).message.split('\n')[0]}`); }
        suite.markNotRun(g.ids, 'The test group stopped before reaching this case');
      }
    }));
  } finally { await browser.close().catch(() => {}); }

  const prev = loadTracker(cfg);
  const cases: CaseResult[] = TRACKER.map(t => {
    if (t.manual) return { id: t.id, area: t.area, title: t.title, steps: t.steps, expected: t.expected, priority: t.priority, known: '', status: 'SKIPPED', actual: `Manual testing: ${t.manualReason ?? 'not automated'}.`, reasons: [], log: [], ms: 0, testedAt: startedAt };
    return suite.results.get(t.id) ?? prev?.cases.find(r => r.id === t.id);
  }).filter(Boolean) as CaseResult[];
  const jr: JourneyReport = { phase: 'Daily tracker', startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0, cases, pages: PERF };
  fs.mkdirSync(path.dirname(trackerFile(cfg)), { recursive: true });
  fs.writeFileSync(trackerFile(cfg), JSON.stringify(jr, null, 1));

  // a daily tracker report stands on its own: no Phase 1 (link check) tabs
  const report: RunReport = { baseUrl: cfg.baseUrl, cycleId: '–', runId: startedAt, startedAt, finishedAt: jr.finishedAt, durationMs: jr.durationMs, config: {}, runs: [], links: [], placements: [], deadClickables: [], scenarios: [], homePerf: [], homeImages: [], view: 'tracker', tracker: jr };
  const out = writeReports(report, cfg);
  const csv = trackerCsv(jr);
  fs.writeFileSync(path.join(cfg.outDir, csv.name), csv.text);
  fs.writeFileSync(path.join(cfg.outDir, 'tracker-results.json'), JSON.stringify(jr, null, 1));

  const ran = cases.filter(c => c.status !== 'SKIPPED');
  const by = (s: string) => ran.filter(r => r.status === s).length;
  console.log(`\nFinished in ${((Date.now() - t0) / 60000).toFixed(1)} min. Pass ${by('PASS') + by('WARN')} · Fail ${by('FAIL')} · Blocked ${by('BLOCKED')} · Manual ${cases.length - ran.length}`);
  console.log(`Dashboard: ${out.html} (tab "Daily tracker"); results CSV: ${path.join(cfg.outDir, csv.name)}`);
  process.exitCode = by('FAIL') ? 1 : 0;
}

if (process.argv[1] && /tracker-run\.ts$/.test(process.argv[1])) main().catch(e => { console.error(e); process.exit(2); });
