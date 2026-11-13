import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { RunReport } from '../types.js';
import type { JourneyReport } from './types.js';

/** Latest Phase 2 test-case results (kept next to the progress file, so GitHub's cache carries them between runs). */
export const journeysFile = (cfg: Config) => path.join(path.dirname(cfg.stateFile), 'journeys.json');
/** Latest link-check report, so a Phase 2 run can show it in the same dashboard. */
export const lastReportFile = (cfg: Config) => path.join(path.dirname(cfg.stateFile), 'last-report.json');

export function loadJourneys(cfg: Config): JourneyReport | undefined {
  try { return JSON.parse(fs.readFileSync(journeysFile(cfg), 'utf8')); } catch { return undefined; }
}

export function saveLastReport(cfg: Config, r: RunReport) {
  const { journeys: _j, ...rest } = r;
  void _j;
  fs.mkdirSync(path.dirname(lastReportFile(cfg)), { recursive: true });
  fs.writeFileSync(lastReportFile(cfg), JSON.stringify(rest));
}
