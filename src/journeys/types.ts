import type { Status } from '../types.js';

/** One row of the test case sheet. */
export interface CaseDef {
  id: string;
  area: string;
  title: string;
  steps: string;
  expected: string;
  priority: string;
  type: string;
  pre: string;
  known: string;
}

/** Outcome of one test case. */
export interface CaseResult {
  id: string;
  area: string;
  title: string;
  steps: string;
  expected: string;
  priority: string;
  known: string;
  status: Status;
  /** Plain-language "what happened". */
  actual: string;
  /** Why it failed / could not be verified / has a warning. */
  reasons: string[];
  /** What the test did, step by step. */
  log: string[];
  url?: string;
  screenshot?: string;
  ms: number;
  testedAt: string;
}

/** One page the tests opened, with how long it took (for the speed list). */
export interface PageLoad { url: string; name: string; ms: number; status?: number; tries: number; waitedMs: number; at: string; ok: boolean; note?: string; caseId?: string; kind?: 'Page load' | 'Results shown' | '3D model' }

export interface JourneyReport {
  phase: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  cases: CaseResult[];
  /** Pages opened, with load times (daily tracker). */
  pages?: PageLoad[];
}
