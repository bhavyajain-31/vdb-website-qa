/**
 * Progress store that makes runs resumable.
 *
 * A "testing cycle" starts with `--fresh` (or automatically the first time / when the site or viewport
 * changes). Within a cycle, every finished test case is saved as soon as it completes. The next run:
 *   - does NOT re-run cases that already PASSED, WARNED or FAILED (their result stays in the report),
 *   - runs cases that are still PENDING (time budget reached) or were never reached,
 *   - re-tries cases that could not be verified (BLOCKED), up to 3 attempts,
 *   - re-runs failures only when asked: `--retest-failed`.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Config } from './config.js';
import type { ClickOutcome, DeadClickable, DiscoveredLink, ImageResult, PerfSample, Placement, RunInfo, ScenarioResult, Status, Validation } from './types.js';

export interface State {
  version: 3;
  cycleId: string;
  baseUrl: string;
  viewport: string;
  createdAt: string;
  updatedAt: string;
  runs: RunInfo[];
  ids: Record<string, string>;
  next: { n: number; p?: number };
  /** Every visible place on the homepage a link appears (menu, slider slide, footer column …). */
  placements: Placement[];
  placementClicks: Record<string, ClickOutcome>;
  /** Homepage discovery done in this cycle (menus, sliders, popup, dead clickables). */
  discovered: boolean;
  links: DiscoveredLink[];
  clicks: Record<string, ClickOutcome>;
  validations: Record<string, Validation>;
  components: ScenarioResult[];
  scenarios: Record<string, ScenarioResult>;
  deadClickables: DeadClickable[];
  homePerf: PerfSample[];
  homeImages: ImageResult[];
}

const MAX_BLOCKED_ATTEMPTS = 3;

export function newState(cfg: Config): State {
  const now = new Date().toISOString();
  return {
    version: 3, cycleId: now.slice(0, 16).replace(/[-:T]/g, '') + '-' + crypto.randomBytes(2).toString('hex'),
    baseUrl: cfg.baseUrl, viewport: cfg.viewport, createdAt: now, updatedAt: now, runs: [], ids: {}, next: { n: 0 },
    discovered: false, links: [], placements: [], placementClicks: {}, clicks: {}, validations: {}, components: [], scenarios: {}, deadClickables: [], homePerf: [], homeImages: [],
  };
}

export function loadState(cfg: Config): { state: State; resumed: boolean; reason?: string } {
  if (cfg.fresh || !fs.existsSync(cfg.stateFile)) return { state: newState(cfg), resumed: false, reason: cfg.fresh ? 'started a new cycle (--fresh)' : 'no previous progress' };
  try {
    const s = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')) as State;
    if (s.version !== 3) return { state: newState(cfg), resumed: false, reason: 'progress file from an older tool version' };
    if (s.baseUrl !== cfg.baseUrl || s.viewport !== cfg.viewport) return { state: newState(cfg), resumed: false, reason: `previous progress was for ${s.baseUrl} (${s.viewport})` };
    return { state: s, resumed: true };
  } catch (e) {
    return { state: newState(cfg), resumed: false, reason: `progress file unreadable (${(e as Error).message})` };
  }
}

let timer: NodeJS.Timeout | undefined;
export function saveState(cfg: Config, s: State, now = false) {
  const write = () => {
    s.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true });
    const tmp = cfg.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, cfg.stateFile);
  };
  if (now) { clearTimeout(timer); timer = undefined; write(); return; }
  if (!timer) timer = setTimeout(() => { timer = undefined; try { write(); } catch (e) { console.error('[state] save failed', e); } }, 3000);
}

/** Does this recorded status need running (again)? */
export function needsRun(status: Status | undefined, attempts: number, cfg: Config): boolean {
  if (!status || status === 'PENDING') return true;
  if (status === 'BLOCKED') return attempts < MAX_BLOCKED_ATTEMPTS;
  if (status === 'FAIL') return cfg.retestFailed;
  return false; // PASS, WARN, SKIPPED stay as recorded for this cycle
}
