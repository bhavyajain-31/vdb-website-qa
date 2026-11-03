import { pageStatus } from './content.js';
import { displayLabel } from './products.js';
import { blockedReason, issuesFor } from './severity.js';
import type { Check, ClickOutcome, DiscoveredLink, LinkResult, Placement, PlacementResult, Status, Validation } from './types.js';

/** Combine a link, its click test and its deeplink test into the result shown in the report. */
export function assemble(link: DiscoveredLink, v: Validation | undefined, click: ClickOutcome | undefined, currentRunId: string, overCap = false): LinkResult {
  const checks = [...(click?.checks ?? []), ...(v?.checks ?? [])];
  if (!v) checks.push(overCap
    ? { name: 'Validation', status: 'SKIPPED', mandatory: true, detail: 'Over the link limit (--max-links); not tested' }
    : { name: 'Validation', status: 'PENDING', mandatory: true, detail: 'Not run yet: the time budget was reached. It runs first next time.' });
  const status = pageStatus(checks);
  const issues = issuesFor(checks);
  const reasons = issues.map(i => `${i.title}: ${i.explain}`);
  if (status === 'BLOCKED') { const b = blockedReason(checks); if (b) reasons.unshift(b); }
  if (status === 'SKIPPED') reasons.push(checks.find(c => c.status === 'SKIPPED')?.detail ?? 'Out of scope');
  if (status === 'PENDING') reasons.push('Not run yet: the time budget was reached. It runs first next time.');
  const { status: _s, runId, checks: _c, ...rest } = v ?? ({ images: [], testedAt: '', durationMs: 0, attempts: 0 } as unknown as Validation);
  void _s; void _c;
  return {
    ...link,
    ...rest,
    label: displayLabel(link.label, v?.product),
    status, checks, issues, failureReasons: reasons,
    clickUrl: click?.clickUrl,
    screenshot: v?.screenshot ?? click?.screenshot,
    images: v?.images ?? [],
    runId, carriedOver: !!runId && runId !== currentRunId,
  };
}

const RANK: Record<Status, number> = { FAIL: 0, BLOCKED: 1, PENDING: 2, WARN: 3, PASS: 4, SKIPPED: 5 };

/** One homepage placement: its own click + the shared destination test of its URL. */
export function assemblePlacement(p: Placement, link: LinkResult | undefined, click: ClickOutcome | undefined, clickExempt: boolean): PlacementResult {
  const clickChecks: Check[] = click?.checks ?? (clickExempt ? [] : [{ name: 'Click from source', status: 'PENDING', mandatory: true, detail: 'Not clicked yet' }]);
  const destChecks = (link?.checks ?? []).filter(c => c.name !== 'Click from source' && c.name !== 'Required option feedback');
  const destStatus = link ? pageStatus(destChecks) : 'PENDING';
  const clickStatus = clickChecks.length ? pageStatus(clickChecks) : destStatus;
  const status = RANK[clickStatus] < RANK[destStatus] ? clickStatus : destStatus;
  const issues = [...issuesFor(clickChecks), ...(link?.issues ?? []).filter(i => i.check !== 'Click from source' && i.check !== 'Required option feedback')];
  const reasons = issues.map(i => `${i.title}: ${i.explain}`);
  if (!issues.length && status !== 'PASS') reasons.push(...(link?.failureReasons ?? []));
  return {
    ...p, status, linkId: link?.id, href: link?.href ?? p.rawHref, destType: link?.destType ?? 'other',
    clickUrl: click?.clickUrl, clickChecks, destStatus, issues, reasons,
  };
}
