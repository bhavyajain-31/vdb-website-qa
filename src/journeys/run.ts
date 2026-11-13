// Phase 2 test cases (Week 1: global search, Diamond Search, Gemstone Search).
// Usage: npm run qa:phase2   (options: --headed, --out <dir>, --state <file>, --concurrency <n>, --only <regex on case IDs>)
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { launch } from '../browser.js';
import { configureGate } from '../throttle.js';
import { writeReports } from '../report.js';
import type { RunReport } from '../types.js';
import { CASES } from './catalog.js';
import { Suite } from './harness.js';
import type { JourneyReport } from './types.js';
import { journeysFile, lastReportFile, loadJourneys } from './store.js';
import { searchGroup, SEARCH_IDS } from './search.js';
import { diamondFormGroup, diamondFilterGroup, diamondResultsGroup, DIAMOND_FORM, DIAMOND_FILTERS, DIAMOND_RESULTS } from './diamond.js';
import { gemstoneListGroup, gemstoneFilterGroup, GEM_LIST, GEM_FILTERS } from './gemstone.js';

async function main() {
  const cfg = loadConfig();
  configureGate(cfg);
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const suite = new Suite(cfg);
  const shared: { baseline?: number } = {};
  type Group = { name: string; ids: string[]; run: () => Promise<void> };
  const browser = await launch(cfg);
  const groups: Group[] = [
    { name: 'Diamond Search: results, detail panel, cart', ids: DIAMOND_RESULTS, run: () => diamondResultsGroup(browser, cfg, suite) },
    { name: 'Diamond Search: form and filters', ids: DIAMOND_FORM, run: () => diamondFormGroup(browser, cfg, suite, shared) },
    { name: 'Diamond Search: more filters, stock number, lab-grown', ids: DIAMOND_FILTERS, run: () => diamondFilterGroup(browser, cfg, suite) },
    { name: 'Gemstone Search: list, detail, cart', ids: GEM_LIST, run: () => gemstoneListGroup(browser, cfg, suite) },
    { name: 'Gemstone Search: filters and sort', ids: GEM_FILTERS, run: () => gemstoneFilterGroup(browser, cfg, suite) },
    { name: 'Global search', ids: SEARCH_IDS, run: () => searchGroup(browser, cfg, suite) },
  ].filter(g => !cfg.only || g.ids.some(id => cfg.only!.test(id)));

  const parallel = Math.max(1, Math.min(3, cfg.concurrency));
  console.log(`Phase 2 · Week 1: ${groups.reduce((n, g) => n + g.ids.length, 0)} test cases in ${groups.length} groups, ${parallel} at a time`);
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

  const order = CASES.map(c => c.id);
  const ran = [...suite.results.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  // keep earlier results for cases not run this time (--only)
  const prev = loadJourneys(cfg);
  const merged = order.map(id => ran.find(r => r.id === id) ?? prev?.cases.find(r => r.id === id)).filter(Boolean) as JourneyReport['cases'];
  const jr: JourneyReport = { phase: 'Phase 2 · Week 1', startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0, cases: merged };
  fs.mkdirSync(path.dirname(journeysFile(cfg)), { recursive: true });
  fs.writeFileSync(journeysFile(cfg), JSON.stringify(jr, null, 1));

  // dashboard: latest link-check results (if any) + these test cases
  let report: RunReport;
  try { report = JSON.parse(fs.readFileSync(lastReportFile(cfg), 'utf8')); } catch {
    report = { baseUrl: cfg.baseUrl, cycleId: '–', runId: startedAt, startedAt, finishedAt: jr.finishedAt, durationMs: 0, config: {}, runs: [], links: [], placements: [], deadClickables: [], scenarios: [], homePerf: [], homeImages: [] };
  }
  report.journeys = jr;
  const out = writeReports(report, cfg);
  fs.writeFileSync(path.join(cfg.outDir, 'phase2-results.json'), JSON.stringify(jr, null, 1));

  const by = (s: string) => ran.filter(r => r.status === s).length;
  console.log(`\nFinished in ${((Date.now() - t0) / 60000).toFixed(1)} min. Passed ${by('PASS')} · with warnings ${by('WARN')} · failed ${by('FAIL')} · couldn't verify ${by('BLOCKED')}`);
  console.log(`Dashboard: ${out.html} (tab "Test cases")`);
  process.exitCode = by('FAIL') ? 1 : 0;
}

if (process.argv[1] && /journeys[\\/]run\.ts$/.test(process.argv[1])) main().catch(e => { console.error(e); process.exit(2); });
