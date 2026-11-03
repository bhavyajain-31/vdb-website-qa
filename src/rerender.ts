// Rebuild dashboard.html / deeplinks.csv from an existing results.json without re-testing.
// Usage: npm run report [-- reports/latest]
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { writeReports } from './report.js';
import type { RunReport } from './types.js';
import { issuesFor } from './severity.js';
import { pageStatus } from './content.js';

const dir = path.resolve(process.argv[2] ?? 'reports/latest');
const { summary: _s, ...report } = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8')) as RunReport & { summary: unknown };
void _s;
// recompute plain-language issues so wording changes apply to old results too
for (const l of report.links) {
  l.status = pageStatus(l.checks);
  l.issues = issuesFor(l.checks);
  if (l.issues.length) l.failureReasons = l.issues.map(i => `${i.title}: ${i.explain}`);
}
report.placements ??= [];
const cfg = { ...loadConfig([]), outDir: dir };
const out = writeReports(report, cfg);
console.log(`Re-rendered ${out.html}`);
