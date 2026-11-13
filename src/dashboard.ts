/**
 * Self-contained HTML dashboard (one file, data embedded). Tabs:
 *   Summary · Homepage & speed · Deeplinks · Images
 * Written for non-technical readers first; technical detail sits behind "Technical details".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { AREAS, PAGE_TYPES, componentSeverity, imageReport, perfRows, summarize } from './report.js';
import type { RunReport } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
function logo(file: string): string {
  try { return 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(here, '..', 'assets', file)).toString('base64'); } catch { return ''; }
}

export function renderDashboard(r: RunReport, cfg: Config): string {
  const sum = summarize(r);
  const img = imageReport(r);
  const short = (u?: string) => (u && u.startsWith(r.baseUrl) ? '/' + u.slice(r.baseUrl.length) : u ?? '');
  const data = {
    base: r.baseUrl, cycleId: r.cycleId, runId: r.runId, startedAt: r.startedAt, durationMs: r.durationMs, stopped: r.stoppedReason,
    runs: r.runs, cfg: r.config, sum, areas: AREAS, types: PAGE_TYPES, perfCfg: cfg.perf,
    links: r.links.map(l => ({
      id: l.id, s: l.status, label: l.label, sec: l.section, dt: l.destType, depth: l.depth, pos: l.position ?? [],
      places: (r.placements ?? []).filter(p => p.key === l.key).map(p => ({ pid: p.pid, pos: p.position, s: p.status, label: p.label, issues: p.issues, reasons: p.reasons, click: short(p.clickUrl), dep: p.depth ?? 0, from: short(p.sourceUrl) })),
      src: short(l.sourceUrl), href: short(l.href), raw: l.rawHref, click: short(l.clickUrl), direct: short(l.directUrl), http: l.directHttpStatus,
      chain: l.redirectChain, issues: l.issues, reasons: l.failureReasons,
      checks: l.checks.map(c => ({ n: c.name, s: c.status, d: c.detail, m: c.mandatory })),
      prod: l.product ? { k: l.product.kind, kl: l.product.kindLabel, t: l.product.title, src: l.product.source, st: l.product.stockNumber, pr: l.product.price } : null,
      stock: l.stockNumber, count: l.listing?.resultCount, shown: l.listing?.displayed,
      ready: l.perf?.readyMs, load: l.perf?.loadMs, rating: l.perf?.rating, alone: !!l.perf?.measuredAlone,
      imgs: l.images.filter(i => i.status !== 'SKIPPED').length, badImgs: l.images.filter(i => i.status === 'FAIL').length,
      shot: l.screenshot, at: l.testedAt, carried: l.carriedOver, also: l.alsoFoundIn?.length ?? 0,
    })),
    perf: perfRows(r, cfg).map(p => ({
      id: p.id, label: p.linkLabel ?? p.label, url: short(p.url), type: p.pageType, ready: p.readyMs, ttfb: p.ttfbMs, dom: p.domReadyMs,
      load: p.loadMs, lcp: p.lcpMs, rating: p.rating, alone: !!p.measuredAlone, first: p.firstMs, kb: p.transferKB, req: p.requests, slow: p.slowestResource ? { url: short(p.slowestResource.url), ms: p.slowestResource.ms } : null, n: p.samples,
    })),
    comps: r.scenarios.map(s => ({ id: s.id, name: s.name, kind: s.kind, s: s.status, sev: componentSeverity(s), steps: s.steps.map(t => ({ ...t, url: short(t.url) })), why: s.failureReasons, shot: s.screenshot })),
    dead: r.deadClickables.map(d => ({ ...d, sourceUrl: short(d.sourceUrl) })),
    places: (r.placements ?? []).filter(p => (p.depth ?? 0) === 0).map(p => ({
      pid: p.pid, s: p.status, pos: p.position, label: p.label, href: short(p.href), dt: p.destType, click: short(p.clickUrl),
      cd: p.clickChecks.map(c => c.detail).filter(Boolean).join('; '), dest: p.destStatus, linkId: p.linkId, vis: p.visibleAtLoad,
      reasons: p.reasons, sev: p.issues[0]?.severity,
    })),
    menuImgs: r.scenarios.filter(c => c.kind === 'menu').flatMap(c => (c.images ?? []).map(i => ({ src: i.src, s: i.status, why: i.reason, pos: i.position ?? c.name, w: i.naturalWidth, h: i.naturalHeight }))),
    images: img.entries.map(e => ({ ...e, pages: e.pages.map(short) })),
    imgTotals: img.totals,
    noLinks: r.links.length === 0,
    jr: r.journeys ? {
      phase: r.journeys.phase, at: r.journeys.startedAt, ms: r.journeys.durationMs,
      cases: r.journeys.cases.map(c => ({ id: c.id, area: c.area, t: c.title, steps: c.steps, exp: c.expected, pr: c.priority, known: c.known, s: c.status, act: c.actual, why: c.reasons, log: c.log, url: c.url, shot: c.screenshot, at: c.testedAt, ms: c.ms })),
    } : null,
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const logoLight = logo('VDB-MAIN-TAG.svg'), logoDark = logo('VDB-WHITE-TAG.svg');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VDB Website QA Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;600;700&display=swap">
<style>
:root{
  --violet:#804195; --violet-d:#713782; --blue:#3B72CC; --blue-d:#3C62A0; --teal:#58B8A5; --teal-d:#4CA191; --rose:#D31C50; --rose-d:#B81646;
  --bg:#f6f4f8; --surface:#ffffff; --ink:#020001; --muted:#5d5866; --line:#e4dfe9; --soft:#f1ecf5;
  --pass:#2b7d6d; --pass-bg:#e3f4f0; --warn:#8a5a00; --warn-bg:#fcf1db; --fail:#B81646; --fail-bg:#fbe7ed;
  --blk:#3C62A0; --blk-bg:#e6eefb; --pend:#5d5866; --pend-bg:#eeebf1; --skip:#7a7483; --skip-bg:#f3f1f5;
  --crit:#D31C50; --perf:#3B72CC; --minor:#b07a00;
  --font:"Montserrat", system-ui, -apple-system, "Segoe UI", sans-serif; --mono:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --bg:#141118; --surface:#1d1922; --ink:#f3f0f6; --muted:#aaa3b3; --line:#332d3a; --soft:#26212c;
  --pass:#6fd3bf; --pass-bg:#16302b; --warn:#f0c062; --warn-bg:#33280f; --fail:#ff7b9c; --fail-bg:#3a1522;
  --blk:#8fb2ff; --blk-bg:#1b2740; --pend:#c3bccb; --pend-bg:#2a2530; --skip:#9a93a3; --skip-bg:#231f28; --minor:#f0c062; --violet:#b47fc7; color-scheme:dark}}
:root[data-theme="dark"]{
  --bg:#141118; --surface:#1d1922; --ink:#f3f0f6; --muted:#aaa3b3; --line:#332d3a; --soft:#26212c;
  --pass:#6fd3bf; --pass-bg:#16302b; --warn:#f0c062; --warn-bg:#33280f; --fail:#ff7b9c; --fail-bg:#3a1522;
  --blk:#8fb2ff; --blk-bg:#1b2740; --pend:#c3bccb; --pend-bg:#2a2530; --skip:#9a93a3; --skip-bg:#231f28; --minor:#f0c062; --violet:#b47fc7; color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 var(--font);font-weight:400}
a{color:var(--violet)}
.wrap{max-width:1240px;margin:0 auto;padding:0 16px 64px}
header.top{background:var(--surface);border-bottom:1px solid var(--line)}
header.top .wrap{display:flex;flex-wrap:wrap;align-items:center;gap:14px 28px;padding-top:18px;padding-bottom:16px}
.logo{height:42px;width:auto;display:block}
.logo.dark{display:none}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .logo.light{display:none}:root:not([data-theme="light"]) .logo.dark{display:block}}
:root[data-theme="dark"] .logo.light{display:none} :root[data-theme="dark"] .logo.dark{display:block}
h1{font-size:24px;font-weight:700;margin:0;line-height:1.1}
.meta{color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:4px}
.meta b{color:var(--ink);font-weight:600}
nav.tabs{position:sticky;top:0;z-index:20;background:var(--surface);border-bottom:1px solid var(--line)}
nav.tabs .wrap{display:flex;gap:4px;overflow-x:auto;padding-top:0;padding-bottom:0}
nav.tabs button{font:inherit;font-weight:600;font-size:14px;background:none;border:0;border-bottom:3px solid transparent;padding:13px 14px 11px;color:var(--muted);cursor:pointer;white-space:nowrap}
nav.tabs button[aria-selected="true"]{color:var(--violet);border-bottom-color:var(--violet)}
nav.tabs .n{font-weight:600;font-size:11px;background:var(--fail-bg);color:var(--fail);border-radius:999px;padding:1px 7px;margin-left:6px}
section.tab{display:none;padding-top:22px} section.tab.on{display:block}
h2{font-size:18px;font-weight:700;margin:28px 0 6px}
h2:first-child{margin-top:4px}
p.lead{margin:0 0 14px;color:var(--muted);max-width:820px}
.banner{border-radius:12px;padding:18px 20px;background:linear-gradient(135deg,var(--violet),var(--violet-d));color:#fff;display:flex;flex-wrap:wrap;gap:8px 24px;align-items:center}
.banner .big{font-size:20px;font-weight:700;line-height:1.25}
.banner .small{color:#fff;opacity:.92;font-size:14px}
.note{background:var(--warn-bg);color:var(--warn);border-radius:10px;padding:10px 14px;margin-top:12px;font-size:14px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(170px,1fr))}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px;border-top:4px solid var(--line)}
.tile .n{font-size:30px;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums}
.tile .l{font-weight:600;font-size:14px;margin-top:4px}
.tile .h{color:var(--muted);font-size:12.5px;margin-top:4px;line-height:1.4}
.tile.PASS{border-top-color:var(--teal)} .tile.PASS .n{color:var(--pass)}
.tile.WARN{border-top-color:#e0a526} .tile.WARN .n{color:var(--warn)}
.tile.FAIL{border-top-color:var(--rose)} .tile.FAIL .n{color:var(--fail)}
.tile.BLOCKED{border-top-color:var(--blue)} .tile.BLOCKED .n{color:var(--blk)}
.tile.PENDING{border-top-color:var(--muted)} .tile.SKIPPED{border-top-color:var(--line)}
.tile.crit{border-top-color:var(--crit)} .tile.crit .n{color:var(--crit)}
.tile.perf{border-top-color:var(--perf)} .tile.perf .n{color:var(--perf)}
.tile.minor{border-top-color:var(--minor)} .tile.minor .n{color:var(--minor)}
button.tile{font:inherit;color:inherit;text-align:left;cursor:pointer}
button.tile:hover{border-color:var(--violet)}
.pill{display:inline-flex;align-items:center;gap:5px;font-weight:600;font-size:12px;padding:2px 9px;border-radius:999px;white-space:nowrap}
.pill::before{font-size:11px}
.pill.PASS{color:var(--pass);background:var(--pass-bg)} .pill.PASS::before{content:"✓"}
.pill.WARN{color:var(--warn);background:var(--warn-bg)} .pill.WARN::before{content:"!"}
.pill.FAIL{color:var(--fail);background:var(--fail-bg)} .pill.FAIL::before{content:"✕"}
.pill.BLOCKED{color:var(--blk);background:var(--blk-bg)} .pill.BLOCKED::before{content:"?"}
.pill.PENDING{color:var(--pend);background:var(--pend-bg)} .pill.PENDING::before{content:"…"}
.pill.SKIPPED{color:var(--skip);background:var(--skip-bg)} .pill.SKIPPED::before{content:"–"}
.sev{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:2px 8px;border-radius:6px;color:#fff;white-space:nowrap}
.sev.critical{background:var(--rose)} .sev.performance{background:var(--blue)} .sev.minor{background:#b07a00}
.rating{font-weight:600;font-size:12.5px;white-space:nowrap}
.rating.fast{color:var(--pass)} .rating.ok{color:var(--warn)} .rating.slow{color:var(--fail)} .rating.unknown{color:var(--muted)}
.issues{display:grid;gap:12px}
.issue{background:var(--surface);border:1px solid var(--line);border-left:5px solid var(--rose);border-radius:12px;padding:14px 16px}
.issue.performance{border-left-color:var(--blue)} .issue.minor{border-left-color:#e0a526}
.issue h3{margin:0;font-size:16px;font-weight:700;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.issue .cnt{color:var(--muted);font-weight:600;font-size:13px}
.issue p{margin:6px 0}
.issue .fix{font-size:14px} .issue .fix b{font-weight:600}
.issue ul{margin:6px 0 0;padding-left:18px;font-size:13.5px} .issue li{margin:2px 0}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.tbl{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;font-weight:600;color:var(--muted);background:var(--soft);position:sticky;top:0}
th.sort{cursor:pointer;user-select:none} th.sort:hover{color:var(--violet)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.row{cursor:pointer} tr.row:hover td{background:var(--soft)}
tr.detail td{background:var(--soft);padding:14px 16px}
.url{font-family:var(--mono);font-size:12px;overflow-wrap:anywhere;color:var(--muted)}
.lbl{font-weight:600;overflow-wrap:anywhere}
.small{font-size:12.5px;color:var(--muted)}
.bar{height:10px;border-radius:5px;background:var(--line);min-width:120px;position:relative;overflow:hidden}
.bar i{position:absolute;inset:0 auto 0 0;border-radius:5px}
.bar i.fast{background:var(--teal)} .bar i.ok{background:#e0a526} .bar i.slow{background:var(--rose)} .bar i.unknown{background:var(--muted)}
.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0 12px}
.chip{font:inherit;font-size:13px;font-weight:600;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:999px;padding:5px 12px;cursor:pointer}
.chip[aria-pressed="true"]{background:var(--violet);border-color:var(--violet);color:#fff}
.chip .c{opacity:.8;margin-left:5px;font-variant-numeric:tabular-nums}
select,input[type=search]{font:inherit;font-size:13.5px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);max-width:100%}
input[type=search]{width:260px}
.btn{font:inherit;font-weight:600;font-size:13px;border-radius:8px;padding:6px 12px;border:1px solid var(--violet);color:var(--violet);background:transparent;cursor:pointer;text-decoration:none;display:inline-block}
:focus-visible{outline:2px solid var(--violet);outline-offset:2px}
.det{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:18px}
.det dl{display:grid;grid-template-columns:150px minmax(0,1fr);gap:4px 12px;margin:0 0 10px;font-size:13.5px}
.det dt{color:var(--muted)} .det dd{margin:0;overflow-wrap:anywhere}
.det .shot img{width:100%;border:1px solid var(--line);border-radius:8px;display:block}
.iss{margin:0 0 10px;padding:0;list-style:none;display:grid;gap:8px}
.iss li{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
details.tech summary{cursor:pointer;color:var(--violet);font-weight:600;font-size:13px;margin-top:6px}
details.tech table{font-size:12.5px;margin-top:6px;background:var(--surface)}
.thumb{width:56px;height:56px;object-fit:contain;background:var(--soft);border-radius:6px;display:block}
.legend{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));font-size:13.5px}
.legend > div{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:14px}
.kv dt{color:var(--muted)} .kv dd{margin:0;font-weight:600}
.empty{padding:22px;text-align:center;color:var(--muted)}
.pager{display:flex;gap:8px;align-items:center;justify-content:flex-end;padding:10px}
@media (max-width:760px){
  .det{grid-template-columns:1fr} .det dl{grid-template-columns:110px minmax(0,1fr)}
  input[type=search]{width:100%} h1{font-size:20px} .logo{height:34px}
  th.hide-s,td.hide-s{display:none}
}
</style>
</head>
<body>
<header class="top"><div class="wrap">
  <div><img class="logo light" src="${logoLight}" alt="VDB — Your Jewelry Tech Partner"><img class="logo dark" src="${logoDark}" alt="VDB — Your Jewelry Tech Partner"></div>
  <div style="min-width:0"><h1>Website QA Report</h1><div class="meta" id="meta"></div></div>
</div></header>
<nav class="tabs" aria-label="Report sections"><div class="wrap" role="tablist" id="tabs"></div></nav>
<main class="wrap">
  <section class="tab" id="t-summary" role="tabpanel"></section>
  <section class="tab" id="t-home" role="tabpanel"></section>
  <section class="tab" id="t-links" role="tabpanel"></section>
  <section class="tab" id="t-images" role="tabpanel"></section>
  <section class="tab" id="t-cases" role="tabpanel"></section>
</main>
<script type="application/json" id="qa-data">${json}</script>
<script>
(function(){
var D = JSON.parse(document.getElementById('qa-data').textContent);
var S = D.sum;
function e(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
var NAMES = { PASS:'Passed', WARN:'Passed with warnings', FAIL:'Failed', BLOCKED:"Couldn't verify", PENDING:'Not run yet', SKIPPED:'Skipped' };
var HELP = {
  PASS:'Works as expected.',
  WARN:'Works, but has a minor or speed issue worth fixing.',
  FAIL:'A shopper would hit a real problem here. Fix these first.',
  BLOCKED:'The test could not check it this time (store busy, needs login). Re-tried automatically next run.',
  PENDING:'Not tested yet because the time limit was reached. Runs first next time.',
  SKIPPED:'Out of scope on purpose (links to other websites, in-page jumps).'
};
var SEVN = { critical:'Critical', performance:'Performance', minor:'Minor' };
var SEVH = { critical:'Broken pages, wrong pages, missing prices or empty/wrong results. Shoppers are affected.', performance:'Pages that work but load slowly.', minor:'Cosmetic or wording problems. The journey still works.' };
var AREA = {}; D.areas.forEach(function(a){ AREA[a.key] = a.label; });
function pill(s){ return '<span class="pill ' + s + '">' + e(NAMES[s] || s) + '</span>'; }
function sev(s){ return '<span class="sev ' + s + '">' + e(SEVN[s] || s) + '</span>'; }
function secs(ms){ return ms ? (ms/1000).toFixed(1) + ' s' : '–'; }
function prating(p){ return p.alone ? rating(p.rating) + ' <span class="small" title="Measured on its own">✔</span>' : (p.rating==='slow' ? '<span class="rating unknown">Not confirmed</span>' : rating(p.rating)) + ' <span class="small">(busy)</span>'; }
function rating(r){ return '<span class="rating ' + (r||'unknown') + '">' + ({fast:'Fast',ok:'Acceptable',slow:'Slow',unknown:'Unknown'})[r||'unknown'] + '</span>'; }
function full(u){ return u && u.charAt(0) === '/' ? D.base.replace(/\\/$/, '') + u : u; }
function link(u, text){ return u ? '<a class="url" href="' + e(full(u)) + '" target="_blank" rel="noopener">' + e(text || u) + '</a>' : ''; }
function store(k, v){ try { if (v === undefined) return JSON.parse(localStorage.getItem('qa-' + k)); localStorage.setItem('qa-' + k, JSON.stringify(v)); } catch(x) { return null; } }

// ---------- header
var dur = Math.round(D.durationMs/60000*10)/10;
var started = new Date(D.startedAt);
var executed = D.runs.length ? D.runs[D.runs.length-1].executed : 0;
document.getElementById('meta').innerHTML = '<span>Site <b>' + e(D.base) + '</b></span><span>Run <b>' + e(started.toLocaleString()) + '</b></span><span>Took <b>' + dur + ' min</b></span>' +
  '<span>Tested this run <b>' + executed + '</b> · kept from earlier runs <b>' + D.links.filter(function(l){return l.carried;}).length + '</b></span><span>Testing cycle <b>' + e(D.cycleId) + '</b> (run ' + D.runs.length + ')</span>';

// ---------- tabs
var TABS = [['summary','Summary'],['home','Homepage & speed'],['links','Deeplinks'],['images','Images'],['cases','Test cases']];
var badge = { summary: S.critical, home: (D.places.length ? D.places.filter(function(p){ return p.s==='FAIL'; }).length : D.links.filter(function(l){ return l.depth===0 && l.s==='FAIL'; }).length) + D.comps.filter(function(c){return c.s==='FAIL' && c.kind!=='copy';}).length, links: S.fail, images: D.imgTotals.failed, cases: D.jr ? D.jr.cases.filter(function(c){ return c.s==='FAIL'; }).length : 0 };
var tabsEl = document.getElementById('tabs');
TABS.forEach(function(t){
  var b = document.createElement('button'); b.setAttribute('role','tab'); b.id = 'b-' + t[0];
  b.innerHTML = e(t[1]) + (badge[t[0]] ? '<span class="n">' + badge[t[0]] + '</span>' : '');
  b.onclick = function(){ show(t[0]); }; tabsEl.appendChild(b);
});
function show(id){
  TABS.forEach(function(t){ document.getElementById('t-' + t[0]).classList.toggle('on', t[0]===id); document.getElementById('b-' + t[0]).setAttribute('aria-selected', String(t[0]===id)); });
  try { history.replaceState(null, '', '#' + id); } catch(x) {}
}

// ---------- SUMMARY
(function(){
  var el = document.getElementById('t-summary');
  var crit = S.critical, perf = S.performance, minor = S.minor;
  var head = crit ? crit + ' critical problem' + (crit>1?'s':'') + ' need fixing' : 'No critical problems found';
  var sub = [perf ? perf + ' slow page' + (perf>1?'s':'') : '', minor ? minor + ' minor issue' + (minor>1?'s':'') : ''].filter(Boolean).join(' · ');
  var h = '<div class="banner"><div><div class="big">' + e(head) + '</div><div class="small">' + e(sub || 'No speed or minor issues') + ' · ' + S.total + ' links checked, ' + D.imgTotals.tested + ' images checked</div></div></div>';
  if (D.noLinks) h += '<div class="note"><b>The link check has not run yet.</b> Only the Phase 2 test cases are in this report (see the Test cases tab). Run a link check (New cycle) to fill the other tabs.</div>';
  if (D.jr) { var jf = D.jr.cases.filter(function(c){ return c.s==='FAIL'; }).length; h += '<div class="note" style="background:var(--soft);color:var(--ink)"><b>' + e(D.jr.phase) + ' test cases:</b> ' + D.jr.cases.filter(function(c){ return c.s==='PASS'||c.s==='WARN'; }).length + ' of ' + D.jr.cases.length + ' passed' + (jf ? ', <b style="color:var(--fail)">' + jf + ' failed</b>' : '') + ' (run ' + e(new Date(D.jr.at).toLocaleString()) + '). <a href="#cases">See the Test cases tab</a>.</div>'; }
  if (D.stopped || S.pending) h += '<div class="note"><b>Not everything was tested yet.</b> ' + e(D.stopped ? D.stopped + '.' : '') + (S.pending ? ' ' + S.pending + ' links are waiting. Run the tool again and it continues where it stopped; finished results are kept.' : '') + '</div>';

  h += '<h2>Results by link</h2><p class="lead">Every link a shopper can reach from the homepage (menus, sliders, footer, product cards) was opened and checked. Click a box to see those links.</p><div class="grid">';
  ['FAIL','WARN','PASS','BLOCKED','PENDING','SKIPPED'].forEach(function(s){
    var n = {PASS:S.pass,WARN:S.warn,FAIL:S.fail,BLOCKED:S.blocked,PENDING:S.pending,SKIPPED:S.skipped}[s];
    h += '<button class="tile ' + s + '" data-go="' + s + '"><div class="n">' + n + '</div><div class="l">' + e(NAMES[s]) + '</div><div class="h">' + e(HELP[s]) + '</div></button>';
  });
  h += '</div>';
  h += '<h2>Problems by seriousness</h2><div class="grid">';
  [['crit','critical',crit],['perf','performance',perf],['minor','minor',minor]].forEach(function(x){
    h += '<div class="tile ' + x[0] + '"><div class="n">' + x[2] + '</div><div class="l">' + SEVN[x[1]] + '</div><div class="h">' + e(SEVH[x[1]]) + '</div></div>';
  });
  h += '<div class="tile ' + (D.imgTotals.failed ? 'FAIL' : 'PASS') + '"><div class="n">' + D.imgTotals.failed + '</div><div class="l">Broken images</div><div class="h">of ' + D.imgTotals.tested + ' different images tested (' + D.imgTotals.identified + ' found)</div></div>';
  h += '</div>';

  // group issues by title
  var groups = {};
  D.links.forEach(function(l){ l.issues.forEach(function(i){
    var gk = i.severity + '|' + i.title;
    var g = groups[gk] || (groups[gk] = { sev:i.severity, title:i.title, fix:i.fix, owner:i.owner, items:[], explain:i.explain });
    g.items.push(l);
  }); });
  D.comps.filter(function(c){ return c.s==='FAIL' && !(c.kind==='copy' && groups['minor|Template placeholder text visible']); }).forEach(function(c){
    var t = c.kind==='copy' ? 'Template placeholder text visible' : c.kind==='session' ? 'Search filters carry over between searches' : c.kind==='search' ? 'Header search problem' : c.kind==='slider' ? 'Slider cannot show all slides' : c.kind==='menu' ? 'Menu problem' : c.name;
    var g = groups[t] || (groups[t] = { sev:c.sev, title:t, fix: c.kind==='session' ? 'Make the search page use the filters in its URL and ignore filters remembered from an earlier search.' : c.kind==='copy' ? 'Replace the placeholder text in the theme editor.' : 'See the Homepage & speed tab for the steps that failed.', owner: c.kind==='copy' ? 'Store admin / content' : 'Developer', items:[], explain:(c.why||[]).join(' ') });
    g.comps = (g.comps||[]).concat([c]);
  });
  var dead = D.dead.filter(function(d){ return d.status==='FAIL'; });
  if (dead.length) groups['Clickable element does nothing'] = { sev:'critical', title:'Clickable element does nothing', fix:'Give the element a real link or remove it.', owner:'Store admin / content', items:[], explain: dead.length + ' element(s) look clickable but have no destination and nothing happens when clicked.', deads: dead };
  var order = {critical:0,performance:1,minor:2};
  var list = Object.keys(groups).map(function(k){ return groups[k]; }).sort(function(a,b){ return order[a.sev]-order[b.sev] || (b.items.length+(b.comps||[]).length) - (a.items.length+(a.comps||[]).length); });
  h += '<h2>What needs attention</h2><p class="lead">The same kind of problem is grouped together. Each group says what is wrong, who usually fixes it and where it happens.</p>';
  if (!list.length) h += '<div class="panel empty">Nothing needs attention. 🎉</div>';
  h += '<div class="issues">' + list.map(function(g){
    var n = g.items.length + (g.comps||[]).length + (g.deads||[]).length;
    var items = g.items.slice(0,6).map(function(l){ return '<li><a href="#" data-link="' + e(l.id) + '">' + e(l.label) + '</a> <span class="small">' + e(posPlain(l)) + ' · ' + e(l.id) + '</span></li>'; }).join('');
    items += (g.comps||[]).map(function(c){ return '<li>' + e(c.name) + (c.why && c.why[0] ? ' <span class="small">– ' + e(c.why[0]) + '</span>' : '') + '</li>'; }).join('');
    items += (g.deads||[]).slice(0,6).map(function(d){ return '<li>' + e(d.label) + ' <span class="small">' + e(d.section) + ' · href "' + e(d.rawHref) + '"</span></li>'; }).join('');
    var more = g.items.length > 6 ? '<li class="small">+ ' + (g.items.length-6) + ' more (see Deeplinks tab)</li>' : '';
    return '<div class="issue ' + g.sev + '"><h3>' + sev(g.sev) + e(g.title) + '<span class="cnt">' + n + ' place' + (n>1?'s':'') + '</span></h3>' +
      '<p>' + e(g.items.length > 1 ? genericExplain(g) : g.explain) + '</p><p class="fix"><b>What to do:</b> ' + e(g.fix) + ' <span class="small">(' + e(g.owner) + ')</span></p><ul>' + items + more + '</ul></div>';
  }).join('') + '</div>';

  h += '<h2>How to read this report</h2><div class="legend">' + ['FAIL','WARN','PASS','BLOCKED','PENDING','SKIPPED'].map(function(s){ return '<div>' + pill(s) + '<div style="margin-top:4px">' + e(HELP[s]) + '</div></div>'; }).join('') +
    '<div><b>Speed ratings</b><div>Fast ≤ ' + D.perfCfg.fastMs/1000 + ' s · Acceptable ≤ ' + D.perfCfg.slowMs/1000 + ' s · Slow above that. "Ready" means the main content (products, results, prices) is visible.</div></div>' +
    '<div><b>Resuming</b><div>Results are saved as they finish. The next run skips what is already done (including failures, which stay in the report) and continues with what is left. Use <code>--fresh</code> to start over or <code>--retest-failed</code> after fixes.</div></div></div>';

  if (D.runs.length > 1) {
    h += '<h2>Runs in this testing cycle</h2><div class="panel tbl"><table><thead><tr><th>Run started</th><th class="num">Duration</th><th class="num">Links tested</th><th>Note</th></tr></thead><tbody>' +
      D.runs.map(function(r){ return '<tr><td>' + e(new Date(r.startedAt).toLocaleString()) + '</td><td class="num">' + (r.durationMs ? (r.durationMs/60000).toFixed(1) + ' min' : '–') + '</td><td class="num">' + r.executed + '</td><td>' + e(r.stoppedReason || (r.finishedAt ? 'Completed' : 'Interrupted')) + '</td></tr>'; }).join('') + '</tbody></table></div>';
  }
  el.innerHTML = h;
  el.querySelectorAll('[data-go]').forEach(function(b){ b.onclick = function(){ LS.status = b.getAttribute('data-go'); renderLinks(); show('links'); window.scrollTo(0,0); }; });
  el.querySelectorAll('[data-link]').forEach(function(a){ a.onclick = function(ev){ ev.preventDefault(); openLink(a.getAttribute('data-link')); }; });
  function genericExplain(g){ var x = g.explain.split(/[:(]/)[0]; return x.length > 30 ? x.replace(/\\s*$/, '') + (/[.!]$/.test(x) ? '' : '.') : g.explain; }
})();

// ---------- HOMEPAGE & SPEED
(function(){
  var el = document.getElementById('t-home');
  var home = D.perf.filter(function(p){ return p.type==='home' && !p.id; })[0];
  var h = '<h2>Homepage speed</h2><p class="lead">Measured in a real Chrome browser from the test machine' + (home && home.n > 1 ? ' (middle value of ' + home.n + ' loads)' : '') + '. Times depend on where the test runs; use them to compare pages and spot slow ones.</p>';
  if (home) {
    var pct = Math.min(100, (home.ready||0) / (D.perfCfg.slowMs*1.5) * 100);
    h += '<div class="split"><div class="panel" style="padding:16px"><div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline"><div><div class="small">Main content ready</div><div style="font-size:34px;font-weight:700">' + secs(home.ready) + '</div></div>' + rating(home.rating) + '</div>' +
      '<div class="bar" style="margin:10px 0 14px"><i class="' + home.rating + '" style="width:' + pct + '%"></i></div><dl class="kv">' +
      '<dt>Server responded</dt><dd>' + secs(home.ttfb) + '</dd><dt>Page structure ready</dt><dd>' + secs(home.dom) + '</dd><dt>Largest image/text visible</dt><dd>' + secs(home.lcp) + '</dd><dt>Everything finished loading</dt><dd>' + secs(home.load) + '</dd></dl></div>' +
      '<div class="panel" style="padding:16px"><b>What these mean</b><ul class="small" style="padding-left:18px;margin:8px 0 0"><li><b>Server responded</b>: how quickly Shopify started sending the page.</li><li><b>Page structure ready</b>: the HTML is in place; images may still be loading.</li><li><b>Main content ready</b>: what shoppers care about – the main picture, products or results are visible. Used for the rating.</li><li><b>Everything finished</b>: all images and scripts of the first screen have loaded.</li></ul></div></div>';
  }
  // slowest pages
  var alonePages = D.perf.filter(function(p){ return p.alone; });
  var pages = (alonePages.length ? alonePages : D.perf).slice().sort(function(a,b){ return (b.ready||0)-(a.ready||0); });
  var max = Math.max.apply(null, pages.map(function(p){ return p.ready||0; }).concat([1]));
  var nSlow = alonePages.filter(function(p){ return p.rating==='slow'; }).length;
  var waiting = D.perf.filter(function(p){ return !p.alone && p.rating==='slow'; }).length;
  h += '<h2>Slowest pages</h2><p class="lead">Measured one page at a time, so these numbers are reliable. ' + (nSlow ? nSlow + ' page' + (nSlow>1?'s take':' takes') + ' longer than ' + D.perfCfg.slowMs/1000 + ' s to show the main content.' : 'No re-measured page took longer than ' + D.perfCfg.slowMs/1000 + ' s.') + (waiting ? ' ' + waiting + ' more page(s) looked slow during the busy test run and will be re-measured next run.' : '') + '</p>';
  h += '<div class="panel tbl"><table><tbody>' + pages.slice(0,10).map(function(p){
    return '<tr><td style="width:38%"><div class="lbl">' + e(p.label) + '</div><div class="small">' + e(D.types[p.type]||p.type) + '</div></td><td style="width:45%"><div class="bar"><i class="' + p.rating + '" style="width:' + Math.max(2,(p.ready||0)/max*100) + '%"></i></div></td><td class="num">' + secs(p.ready) + '</td><td>' + rating(p.rating) + '</td></tr>';
  }).join('') + '</tbody></table></div>';
  h += '<h2>Load time of every page</h2><div class="controls"><button class="chip" id="pfSlow" aria-pressed="false">Slow only</button><input type="search" id="pfQ" placeholder="Find a page…" aria-label="Find a page"></div><div class="panel tbl"><table><thead><tr>' +
    '<th class="sort" data-k="label">Page</th><th class="hide-s">Type</th><th class="num sort" data-k="ready">Main content ready</th><th class="num sort hide-s" data-k="ttfb">Server responded</th><th class="num sort hide-s" data-k="load">Fully loaded</th><th class="num sort hide-s" data-k="kb">Downloaded</th></tr></thead><tbody id="pfBody"></tbody></table></div>' +
    '<p class="small">✔ = measured on its own (reliable). Other times were measured while several pages were being tested at once, so they are higher than a shopper would see; pages that looked slow are re-measured on their own.</p>';

  // homepage placements: every visible place a link appears
  var P = D.places;
  var hasP = P.length > 0;
  h += '<h2>Every link visible on the homepage</h2><p class="lead">Each place a link appears is listed on its own row with its <b>position</b> (for example <i>Mega menu › Engagement Rings › Shop By Metal</i> or <i>Homepage › Hero slideshow › Mini slider › Slide 2 of 6</i>). Each one was clicked like a shopper would (hovering menus, moving sliders), and the page it opens was checked. When the same URL appears in several places, its page is tested once and the result is shown for every place.</p>' +
    '<div class="controls" id="hfArea"></div><div class="controls"><select id="hfSecSel" aria-label="Section"></select><input type="search" id="hfQ" placeholder="Find a link or position…" aria-label="Find a homepage link"></div>' +
    '<div class="panel tbl"><table><thead><tr><th>Result</th><th>Position on the page</th><th>Link text</th><th>Should open</th><th>Clicking opened</th><th>Why it failed</th></tr></thead><tbody id="hfBody"></tbody></table></div>';
  if (D.menuImgs.length) {
    var mi = D.menuImgs.filter(function(i){ return i.s!=='SKIPPED'; });
    var mbad = mi.filter(function(i){ return i.s!=='PASS'; });
    h += '<h2>Mega menu icons &amp; images</h2><p class="lead">Every icon and image in each mega menu panel was checked while the panel was open (any size). ' + (mbad.length ? '<b style="color:var(--fail)">' + mbad.length + ' of ' + mi.length + ' have a problem.</b>' : 'All ' + mi.length + ' load and display correctly.') + '</p>' +
      '<div class="panel tbl"><table><thead><tr><th>Icon</th><th>Result</th><th>Position</th><th>Image file</th><th class="hide-s">Size</th></tr></thead><tbody>' +
      D.menuImgs.slice().sort(function(a,b){ var o={FAIL:0,BLOCKED:1,PASS:2,SKIPPED:3}; return o[a.s]-o[b.s] || String(a.pos).localeCompare(String(b.pos)); }).map(function(i){
        return '<tr><td>' + (i.s==='PASS' ? '<img class="thumb" loading="lazy" src="' + e(i.src) + '" alt="">' : '<div class="thumb"></div>') + '</td><td>' + pill(i.s) + '</td><td>' + e(i.pos) + (i.why && i.s!=='PASS' ? '<div class="small">' + e(i.why) + '</div>' : '') + '</td><td>' + link(i.src, i.src.length > 90 ? i.src.slice(0,90) + '…' : i.src) + '</td><td class="hide-s small">' + (i.w ? i.w + '×' + i.h : '–') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  h += '<h2>Menus, sliders, popup &amp; search</h2><div class="panel tbl"><table><thead><tr><th>Result</th><th>What was tested</th><th>What happened</th></tr></thead><tbody>' +
    D.comps.map(function(c){ return '<tr><td>' + pill(c.s) + '</td><td class="lbl">' + e(c.name) + '</td><td>' + c.steps.map(function(t){ return e(t.step) + (t.resultCount!=null ? ' → <b>' + e(t.resultCount) + '</b> results' : '') + (t.note ? ' <span class="small">(' + e(t.note) + ')</span>' : ''); }).join('<br>') + (c.why.length ? '<div style="color:var(--fail);margin-top:4px">' + c.why.map(e).join('<br>') + '</div>' : '') + (c.shot ? ' <a href="' + e(c.shot) + '" target="_blank">Screenshot</a>' : '') + '</td></tr>'; }).join('') + '</tbody></table></div>';
  if (D.dead.length) h += '<h2>Clickable items without a link</h2><div class="panel tbl"><table><thead><tr><th>Result</th><th>Element</th><th>Where</th><th>What happened</th></tr></thead><tbody>' +
    D.dead.map(function(d){ return '<tr><td>' + pill(d.status) + '</td><td class="lbl">' + e(d.label) + '</td><td>' + e(AREA[d.section]||d.section) + '</td><td>' + e(d.detail) + (d.screenshot ? ' <a href="' + e(d.screenshot) + '" target="_blank">Screenshot</a>' : '') + '</td></tr>'; }).join('') + '</tbody></table></div>';
  el.innerHTML = h;

  var pf = { slow:false, q:'', k:'ready', dir:-1 };
  function renderPerf(){
    var rows = D.perf.filter(function(p){ return (!pf.slow || p.rating==='slow') && (!pf.q || (p.label + ' ' + p.url).toLowerCase().indexOf(pf.q) >= 0); })
      .sort(function(a,b){ var x=a[pf.k], y=b[pf.k]; if (typeof x === 'string') return pf.dir * x.localeCompare(y); return pf.dir * ((x||0)-(y||0)); });
    document.getElementById('pfBody').innerHTML = rows.map(function(p){
      return '<tr><td><div class="lbl">' + e(p.label) + (p.id ? ' <span class="small">' + e(p.id) + '</span>' : '') + '</div>' + link(p.url) + (p.slow ? '<div class="small">Slowest file: ' + e(p.slow.url.slice(0,80)) + ' (' + secs(p.slow.ms) + ')</div>' : '') + '</td><td class="hide-s">' + e(D.types[p.type]||p.type) + '</td><td class="num">' + secs(p.ready) + '</td><td class="num hide-s">' + secs(p.ttfb) + '</td><td class="num hide-s">' + secs(p.load) + '</td><td class="num hide-s">' + (p.kb ? (p.kb > 1024 ? (p.kb/1024).toFixed(1) + ' MB' : p.kb + ' KB') : '–') + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="empty">No pages match.</td></tr>';
  }
  document.getElementById('pfSlow').onclick = function(){ pf.slow = !pf.slow; this.setAttribute('aria-pressed', String(pf.slow)); renderPerf(); };
  document.getElementById('pfQ').oninput = function(){ pf.q = this.value.toLowerCase(); renderPerf(); };
  el.querySelectorAll('th.sort').forEach(function(th){ th.onclick = function(){ var k = th.getAttribute('data-k'); pf.dir = pf.k===k ? -pf.dir : (k==='label' ? 1 : -1); pf.k = k; renderPerf(); }; });
  renderPerf();

  var hf = { area:'all', sec:'all', q:'' };
  var AREAS2 = ['Header','Mega menu','Homepage','Footer'];
  function renderHome(){
    var rows0 = P.length ? P : [];
    document.getElementById('hfArea').innerHTML = ['all'].concat(AREAS2).map(function(a){
      var n = rows0.filter(function(p){ return a==='all' || p.pos[0]===a; }).length;
      var f = rows0.filter(function(p){ return (a==='all' || p.pos[0]===a) && p.s==='FAIL'; }).length;
      return n ? '<button class="chip" data-a="' + e(a) + '" aria-pressed="' + (hf.area===a) + '">' + e(a==='all' ? 'All' : a) + '<span class="c">' + n + (f ? ' · ' + f + ' failed' : '') + '</span></button>' : '';
    }).join('');
    document.getElementById('hfArea').querySelectorAll('button').forEach(function(b){ b.onclick = function(){ hf.area = b.getAttribute('data-a'); hf.sec = 'all'; renderHome(); }; });
    var inArea = rows0.filter(function(p){ return hf.area==='all' || p.pos[0]===hf.area; });
    var secsSeen = {}; inArea.forEach(function(p){ var k = p.pos.slice(0,2).join(' › '); secsSeen[k] = (secsSeen[k]||0)+1; });
    var sel = document.getElementById('hfSecSel');
    sel.innerHTML = '<option value="all">Every section</option>' + Object.keys(secsSeen).map(function(k){ return '<option value="' + e(k) + '"' + (hf.sec===k?' selected':'') + '>' + e(k) + ' (' + secsSeen[k] + ')</option>'; }).join('');
    sel.onchange = function(){ hf.sec = this.value; renderHome(); };
    var order = {FAIL:0,BLOCKED:1,WARN:2,PENDING:3,PASS:4,SKIPPED:5};
    var rows = inArea.filter(function(p){ return (hf.sec==='all' || p.pos.slice(0,2).join(' › ')===hf.sec) && (!hf.q || (p.label + ' ' + p.pos.join(' ') + ' ' + p.href).toLowerCase().indexOf(hf.q) >= 0); })
      .sort(function(a,b){ return order[a.s]-order[b.s] || a.pid.localeCompare(b.pid); });
    document.getElementById('hfBody').innerHTML = rows.map(function(p){
      return '<tr class="row" data-id="' + e(p.linkId||'') + '"><td>' + pill(p.s) + '</td><td style="min-width:240px"><div class="lbl">' + p.pos.map(e).join(' <span class="small">›</span> ') + '</div><span class="small">' + e(p.pid) + (p.vis ? '' : ' · shown after hover / slide') + '</span></td><td>' + e(p.label) + '</td><td>' + link(p.href) + '<div class="small">' + e(D.types[p.dt]||p.dt) + '</div></td><td>' + (p.click ? link(p.click) : '<span class="small">' + e(p.cd || 'Not a page link (' + (D.types[p.dt]||p.dt) + ')') + '</span>') + '</td><td>' + (p.s==='PASS' ? '<span class="small">–</span>' : (p.sev ? sev(p.sev) + ' ' : '') + e(p.reasons[0] || '')) + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="empty">Nothing here.</td></tr>';
    document.getElementById('hfBody').querySelectorAll('tr.row').forEach(function(tr){ tr.onclick = function(){ var id = tr.getAttribute('data-id'); if (id) openLink(id); }; });
  }
  document.getElementById('hfQ').oninput = function(){ hf.q = this.value.toLowerCase(); renderHome(); };
  renderHome();
})();

// ---------- DEEPLINKS
var LS = Object.assign({ status:'FAIL', area:'all', ptype:'all', q:'', open:null }, store('links') || {});
var linkById = {}; D.links.forEach(function(l){ linkById[l.id] = l; });
// one row per place a shopper can click (homepage links appear once per position, with their exact text);
// links found deeper (product cards, links on product pages) get one row each with their route
var ROWS = [];
D.links.forEach(function(l){
  if (l.places.length) l.places.forEach(function(p){ ROWS.push(Object.assign({}, l, { rid: p.pid, s: p.s, label: p.label, pos: p.pos, issues: p.issues, reasons: p.reasons, click: p.click || l.click, where: p.dep ? 'Deeper pages' : p.pos[0], from: p.from })); });
  else ROWS.push(Object.assign({}, l, { rid: l.id, where: l.depth === 0 ? 'Homepage' : 'Deeper pages' }));
});
(function(){
  var el = document.getElementById('t-links');
  el.innerHTML = '<h2>Deeplinks</h2><p class="lead">Every link on the site, one row per place it appears, with the exact text shoppers see and its position (for links on listing and product pages: the route to reach them from the homepage). Each link URL is also opened directly in a fresh browser (like a shopper opening a shared or bookmarked link). Each one is checked for: the page opens, it is the right page, filters are kept, content and prices appear, images load, and the page survives a refresh. Click a row for details. (Back-button behaviour is not tested.)</p>' +
    '<div class="controls" id="lfStatus"></div><div class="controls"><select id="lfArea" aria-label="Where the link was found"></select><select id="lfType" aria-label="Product type"></select><input type="search" id="lfQ" placeholder="Find by name, URL, stock number…" aria-label="Find a link"><a class="btn" href="deeplinks.csv" download>Download CSV</a></div>' +
    '<div class="panel tbl"><table><thead><tr><th>Result</th><th>Link</th><th class="hide-s">Position</th><th>Link URL &amp; expected page</th><th>What actually happened</th><th>Reason</th><th class="num hide-s">Ready</th></tr></thead><tbody id="lfBody"></tbody></table></div>';
  var areaSel = document.getElementById('lfArea');
  areaSel.innerHTML = '<option value="all">Anywhere</option>' + ['Header','Mega menu','Homepage','Footer','Deeper pages'].map(function(a){ var n = ROWS.filter(function(r){ return r.where===a; }).length; return n ? '<option value="' + e(a) + '">' + e(a === 'Deeper pages' ? 'Pages opened from the homepage' : a) + ' (' + n + ')</option>' : ''; }).join('');
  var kinds = {}; D.links.forEach(function(l){ var k = l.prod ? l.prod.kl : (D.types[l.dt]||l.dt); kinds[k] = (kinds[k]||0)+1; });
  var typeSel = document.getElementById('lfType');
  typeSel.innerHTML = '<option value="all">Any page type</option>' + Object.keys(kinds).sort().map(function(k){ return '<option value="' + e(k) + '">' + e(k) + ' (' + kinds[k] + ')</option>'; }).join('');
  areaSel.onchange = function(){ LS.area = this.value; renderLinks(); };
  typeSel.onchange = function(){ LS.ptype = this.value; renderLinks(); };
  document.getElementById('lfQ').oninput = function(){ LS.q = this.value; renderLinks(); };
})();
function posPlain(l){
  var first = l.places && l.places.length ? l.places[0].pos : l.pos;
  return (first && first.length ? first.join(' › ') : (AREA[l.sec]||l.sec)) + (l.places && l.places.length > 1 ? ' (+' + (l.places.length-1) + ' more)' : '');
}
function posText(l){
  var first = l.places.length ? l.places[0].pos : l.pos;
  var t = first && first.length ? first.map(e).join(' › ') : e(AREA[l.sec]||l.sec);
  return t + (l.places.length > 1 ? '<div class="small">+ ' + (l.places.length-1) + ' more place' + (l.places.length>2?'s':'') + ' on the homepage</div>' : '');
}
function kindOf(l){ return l.prod ? l.prod.kl : (D.types[l.dt]||l.dt); }
function renderLinks(){
  store('links', { status:LS.status, area:LS.area, ptype:LS.ptype, q:LS.q });
  document.getElementById('lfArea').value = LS.area; document.getElementById('lfType').value = LS.ptype; document.getElementById('lfQ').value = LS.q;
  var base = ROWS.filter(function(l){
    if (LS.area!=='all' && l.where!==LS.area) return false;
    if (LS.ptype!=='all' && kindOf(l)!==LS.ptype) return false;
    if (LS.q) { var hay = (l.label + ' ' + (l.pos||[]).join(' ') + ' ' + l.href + ' ' + l.direct + ' ' + l.id + ' ' + l.rid + ' ' + (l.stock||'') + ' ' + (l.prod && l.prod.t || '')).toLowerCase(); if (hay.indexOf(LS.q.toLowerCase()) < 0) return false; }
    return true;
  });
  var st = document.getElementById('lfStatus');
  st.innerHTML = ['FAIL','WARN','BLOCKED','PENDING','SKIPPED','PASS','all'].map(function(s){
    var n = base.filter(function(l){ return s==='all' || l.s===s; }).length;
    return '<button class="chip" data-s="' + s + '" aria-pressed="' + (LS.status===s) + '">' + e(s==='all' ? 'All' : NAMES[s]) + '<span class="c">' + n + '</span></button>';
  }).join('');
  st.querySelectorAll('button').forEach(function(b){ b.onclick = function(){ LS.status = b.getAttribute('data-s'); renderLinks(); }; });
  var rows = base.filter(function(l){ return LS.status==='all' || l.s===LS.status; });
  var sevRank = {critical:0,performance:1,minor:2};
  var areaRank = {'Header':0,'Mega menu':1,'Homepage':2,'Footer':3,'Deeper pages':4};
  rows.sort(function(a,b){ var x = a.issues[0] ? sevRank[a.issues[0].severity] : 9, y = b.issues[0] ? sevRank[b.issues[0].severity] : 9; return x-y || (areaRank[a.where]||5)-(areaRank[b.where]||5) || a.rid.localeCompare(b.rid); });
  document.getElementById('lfBody').innerHTML = rows.map(function(l){
    var actual = l.direct ? link(l.direct) + (l.http ? ' <span class="small">HTTP ' + l.http + '</span>' : '') : (l.click ? link(l.click) : '<span class="small">–</span>');
    if (l.count != null || l.shown != null) actual += '<div class="small">' + (l.count != null ? l.count + ' results, ' : '') + (l.shown||0) + ' shown</div>';
    var reason = l.issues.length ? l.issues.map(function(i){ return sev(i.severity) + ' ' + e(i.title); }).join('<br>') : (l.s==='PASS' ? '<span class="small">All checks passed</span>' : '<span class="small">' + e(l.reasons[0]||'') + '</span>');
    var pos = (l.pos && l.pos.length ? l.pos.map(e).join(' › ') : e(AREA[l.sec]||l.sec));
    var row = '<tr class="row" data-id="' + e(l.rid) + '"><td>' + pill(l.s) + '</td><td><div class="lbl">' + e(l.label) + '</div><span class="small">' + e(l.rid) + (l.rid !== l.id ? ' · page ' + e(l.id) : '') + (l.prod ? ' · ' + e(l.prod.kl) : '') + '</span></td><td class="hide-s" style="min-width:220px">' + pos + '</td><td>' + link(l.href) + '<div class="small">Expected: ' + e(D.types[l.dt]||l.dt) + '</div></td><td>' + actual + '</td><td>' + reason + '</td><td class="num hide-s">' + (l.ready ? secs(l.ready) + '<br>' + prating(l) : '–') + '</td></tr>';
    if (LS.open === l.rid) row += '<tr class="detail"><td colspan="7">' + detail(l) + '</td></tr>';
    return row;
  }).join('') || '<tr><td colspan="7" class="empty">No links match these filters.</td></tr>';
  document.getElementById('lfBody').querySelectorAll('tr.row').forEach(function(tr){ tr.onclick = function(){ var id = tr.getAttribute('data-id'); LS.open = LS.open===id ? null : id; renderLinks(); }; });
}
function detail(l){
  var iss = l.issues.length ? '<ul class="iss">' + l.issues.map(function(i){ return '<li>' + sev(i.severity) + ' <b>' + e(i.title) + '</b><div>' + e(i.explain) + '</div><div class="small"><b>What to do:</b> ' + e(i.fix) + ' (' + e(i.owner) + ')</div></li>'; }).join('') + '</ul>' : (l.reasons.length ? '<p>' + l.reasons.map(e).join('<br>') + '</p>' : '<p>Everything worked.</p>');
  var where = l.places.length ? l.places.map(function(p){ return '<div>' + pill(p.s) + ' ' + p.pos.map(e).join(' › ') + ' <span class="small">' + e(p.pid) + '</span></div>'; }).join('') : (l.pos && l.pos.length ? l.pos.map(e).join(' › ') : e(AREA[l.sec]||l.sec)) + ' <span class="small">on ' + link(l.src) + '</span>';
  var dl = '<dl><dt>Position' + (l.places.length > 1 ? 's (' + l.places.length + ')' : '') + '</dt><dd>' + where + '</dd>' +
    '<dt>Link URL</dt><dd>' + link(l.href) + '</dd>' +
    (l.click ? '<dt>Clicking opened</dt><dd>' + link(l.click) + '</dd>' : '') +
    (l.direct ? '<dt>Opening directly gave</dt><dd>' + link(l.direct) + (l.http ? ' (HTTP ' + l.http + ')' : '') + '</dd>' : '') +
    (l.prod ? '<dt>Product type</dt><dd>' + e(l.prod.kl) + (l.prod.src ? '<div class="small">' + e(l.prod.src) + '</div>' : '') + '</dd>' + (l.prod.t ? '<dt>Product</dt><dd>' + e(l.prod.t) + (l.prod.pr ? ' · ' + e(l.prod.pr) : '') + '</dd>' : '') : '') +
    (l.stock ? '<dt>Stock / SKU</dt><dd>' + e(l.stock) + '</dd>' : '') +
    (l.ready ? '<dt>Load time</dt><dd>Main content ready ' + secs(l.ready) + (l.load ? ', fully loaded ' + secs(l.load) : '') + ' – ' + prating(l) + '</dd>' : '') +
    '<dt>Images</dt><dd>' + l.imgs + ' tested' + (l.badImgs ? ', <b style="color:var(--fail)">' + l.badImgs + ' broken</b> (see Images tab)' : '') + '</dd>' +
    '<dt>Tested</dt><dd>' + e(l.at ? new Date(l.at).toLocaleString() : 'not yet') + (l.carried ? ' <span class="small">(kept from an earlier run)</span>' : '') + '</dd></dl>';
  var tech = '<details class="tech"><summary>Technical details (' + l.checks.length + ' checks)</summary><table><tbody>' + l.checks.map(function(c){ return '<tr><td>' + e(c.n) + '</td><td>' + pill(c.s) + '</td><td class="url">' + e(c.d||'') + '</td></tr>'; }).join('') +
    (l.chain && l.chain.length ? '<tr><td>Redirects</td><td></td><td class="url">' + l.chain.map(e).join('<br>') + '</td></tr>' : '') + '<tr><td>Raw href</td><td></td><td class="url">' + e(l.raw) + '</td></tr></tbody></table></details>';
  return '<div class="det"><div>' + iss + dl + tech + '</div><div class="shot">' + (l.shot ? '<a href="' + e(l.shot) + '" target="_blank" rel="noopener"><img loading="lazy" src="' + e(l.shot) + '" alt="Screenshot of the page"></a><div class="small">Screenshot when tested</div>' : '<div class="small">No screenshot (taken only when something is wrong)</div>') + '</div></div>';
}
function openLink(id){
  var l = linkById[id]; if (!l) return;
  var r = ROWS.filter(function(x){ return x.id === id; }).sort(function(a,b){ return (a.s==='FAIL'?0:1)-(b.s==='FAIL'?0:1); })[0] || l;
  LS.status = r.s; LS.area = 'all'; LS.ptype = 'all'; LS.q = ''; LS.open = r.rid || id; renderLinks(); show('links');
  id = r.rid || id;
  setTimeout(function(){ var tr = document.querySelector('tr.row[data-id="' + id + '"]'); if (tr) tr.scrollIntoView({ block:'center' }); }, 30);
}
renderLinks();

// ---------- IMAGES
(function(){
  var el = document.getElementById('t-images'); var T = D.imgTotals;
  var h = '<h2>Image report</h2><p class="lead">Every image on the tested pages was found and listed. Visible images (and images inside slider slides) were loaded and decoded in the browser to make sure they really display. Hidden images, tiny icons and tracking pixels are listed as skipped, with the reason.</p><div class="grid">' +
    tile('', T.identified, 'Images found', 'Different image files found on the tested pages') +
    tile('', T.tested, 'Images tested', 'Downloaded and checked that they display (' + T.checks + ' checks across pages)') +
    tile('PASS', T.ok, 'Loaded & displayed', 'Downloaded and decoded into a real picture') +
    tile('FAIL', T.failed, 'Broken', 'Missing file, server error, or not a valid picture') +
    tile('BLOCKED', T.blocked, "Couldn't verify", 'Network or rate limit problem during the test') +
    tile('SKIPPED', T.skipped, 'Skipped', 'Hidden, icon-sized or tracking images') + '</div>';
  function tile(c, n, l, hh){ return '<div class="tile ' + c + '"><div class="n">' + n + '</div><div class="l">' + e(l) + '</div><div class="h">' + e(hh) + '</div></div>'; }
  var bad = D.images.filter(function(i){ return i.status==='FAIL' || i.status==='BLOCKED'; });
  h += '<h2>Images with problems</h2>' + (bad.length ? '<div class="panel tbl"><table><thead><tr><th>Result</th><th>Image file</th><th>Problem</th><th>Seen on</th></tr></thead><tbody>' + bad.map(function(i){
    return '<tr><td>' + pill(i.status) + (i.product ? '<div class="small">Product image</div>' : '') + '</td><td>' + link(i.src) + '</td><td>' + e(i.reason||'') + (i.http ? ' <span class="small">(HTTP ' + i.http + ')</span>' : '') + '</td><td>' + i.pages.slice(0,4).map(function(p){ return link(p, p.length > 70 ? p.slice(0,70) + '…' : p); }).join('<br>') + (i.pages.length > 4 ? '<div class="small">+' + (i.pages.length-4) + ' more</div>' : '') + '</td></tr>';
  }).join('') + '</tbody></table></div>' : '<div class="panel empty">No broken images. Every tested image loaded and displayed.</div>');
  var reasons = {}; D.images.filter(function(i){ return i.status==='SKIPPED'; }).forEach(function(i){ reasons[i.reason] = (reasons[i.reason]||0)+1; });
  if (T.skipped) h += '<h2>Why images were skipped</h2><div class="panel tbl"><table><tbody>' + Object.keys(reasons).sort(function(a,b){ return reasons[b]-reasons[a]; }).map(function(r){ return '<tr><td>' + e(r) + '</td><td class="num">' + reasons[r] + '</td></tr>'; }).join('') + '</tbody></table></div>';
  h += '<h2>All images</h2><div class="controls" id="imStatus"></div><div class="controls"><input type="search" id="imQ" placeholder="Find by file name or page…" aria-label="Find an image"></div><div class="panel tbl"><table><thead><tr><th>Preview</th><th>Result</th><th>Image file</th><th class="hide-s">Size</th><th>Seen on</th></tr></thead><tbody id="imBody"></tbody></table><div class="pager" id="imPager"></div></div>';
  el.innerHTML = h;
  var IS = { s:'PASS', q:'', page:0 }; var PER = 60;
  function render(){
    var base = D.images.filter(function(i){ return !IS.q || (i.src + ' ' + i.pages.join(' ')).toLowerCase().indexOf(IS.q) >= 0; });
    document.getElementById('imStatus').innerHTML = ['PASS','FAIL','BLOCKED','SKIPPED','all'].map(function(s){ var n = base.filter(function(i){ return s==='all' || i.status===s; }).length; return '<button class="chip" data-s="' + s + '" aria-pressed="' + (IS.s===s) + '">' + e(s==='all' ? 'All' : s==='PASS' ? 'Loaded OK' : s==='FAIL' ? 'Broken' : NAMES[s]) + '<span class="c">' + n + '</span></button>'; }).join('');
    document.getElementById('imStatus').querySelectorAll('button').forEach(function(b){ b.onclick = function(){ IS.s = b.getAttribute('data-s'); IS.page = 0; render(); }; });
    var rows = base.filter(function(i){ return IS.s==='all' || i.status===IS.s; });
    var pages = Math.max(1, Math.ceil(rows.length / PER)); if (IS.page >= pages) IS.page = pages-1;
    document.getElementById('imBody').innerHTML = rows.slice(IS.page*PER, IS.page*PER+PER).map(function(i){
      var prev = i.status==='PASS' && /^https?:/.test(i.src) ? '<img class="thumb" loading="lazy" src="' + e(i.src) + '" alt="">' : '<div class="thumb"></div>';
      return '<tr><td>' + prev + '</td><td>' + pill(i.status) + (i.kind==='background' ? '<div class="small">Background</div>' : '') + '</td><td>' + link(i.src, i.src.length > 110 ? i.src.slice(0,110) + '…' : i.src) + (i.reason && i.status!=='PASS' ? '<div class="small">' + e(i.reason) + '</div>' : '') + (i.position ? '<div class="small">' + e(i.position) + '</div>' : '') + (i.productId ? '<div class="small">Product: ' + e(i.productId) + '</div>' : '') + '</td><td class="hide-s small">' + (i.width ? i.width + '×' + i.height : '–') + '</td><td>' + i.pages.slice(0,2).map(function(p){ return link(p, p.length > 70 ? p.slice(0,70) + '…' : p); }).join('<br>') + (i.pages.length > 2 ? '<div class="small">+' + (i.pages.length-2) + ' more</div>' : '') + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="empty">No images match.</td></tr>';
    document.getElementById('imPager').innerHTML = pages > 1 ? '<button class="btn" id="imPrev"' + (IS.page ? '' : ' disabled') + '>Previous</button><span class="small">Page ' + (IS.page+1) + ' of ' + pages + ' · ' + rows.length + ' images</span><button class="btn" id="imNext"' + (IS.page < pages-1 ? '' : ' disabled') + '>Next</button>' : '<span class="small">' + rows.length + ' images</span>';
    var p = document.getElementById('imPrev'), n = document.getElementById('imNext');
    if (p) p.onclick = function(){ IS.page--; render(); }; if (n) n.onclick = function(){ IS.page++; render(); };
  }
  document.getElementById('imQ').oninput = function(){ IS.q = this.value.toLowerCase(); IS.page = 0; render(); };
  render();
})();

// ---------- TEST CASES (Phase 2)
(function(){
  var el = document.getElementById('t-cases');
  if (!D.jr) { el.innerHTML = '<h2>Test cases</h2><div class="panel empty">The Phase 2 test cases have not been run yet. On the run page choose <b>Phase 2 test cases</b> (or run <code>npm run qa:phase2</code>).</div>'; return; }
  var C = D.jr.cases;
  var CS = { s: 'all', area: 'all', q: '', open: null };
  var h = '<h2>' + e(D.jr.phase) + ' test cases</h2><p class="lead">Each case from the test case sheet, run in a real browser like a shopper: filters set, buttons clicked, results read on screen and compared with the data the store sent. Run ' + e(new Date(D.jr.at).toLocaleString()) + ', took ' + (Math.round(D.jr.ms/6000)/10) + ' min. Nothing is submitted or bought; Add to cart uses a temporary cart. Click a row for the steps.</p><div class="grid">';
  ['FAIL','WARN','BLOCKED','PASS'].forEach(function(s){
    var n = C.filter(function(c){ return c.s===s; }).length;
    h += '<button class="tile ' + s + '" data-go="' + s + '"><div class="n">' + n + '</div><div class="l">' + e(NAMES[s]) + '</div><div class="h">' + e({FAIL:'The store did not do what the test case expects.',WARN:'Works; something is worth a look (see the reason).',BLOCKED:'The test could not decide (for example no stock to check). See the reason.',PASS:'Works as the test case expects.'}[s]) + '</div></button>';
  });
  h += '</div><div class="controls" id="tcStatus" style="margin-top:18px"></div><div class="controls"><select id="tcArea" aria-label="Area"></select><input type="search" id="tcQ" placeholder="Find by ID or words…" aria-label="Find a test case"></div>' +
    '<div class="panel tbl"><table><thead><tr><th>ID</th><th>Result</th><th>Test case</th><th class="hide-s">Expected result</th><th>What happened</th></tr></thead><tbody id="tcBody"></tbody></table></div>';
  el.innerHTML = h;
  var areas = []; C.forEach(function(c){ if (areas.indexOf(c.area) < 0) areas.push(c.area); });
  var sel = document.getElementById('tcArea');
  sel.innerHTML = '<option value="all">All areas</option>' + areas.map(function(a){ return '<option value="' + e(a) + '">' + e(a) + ' (' + C.filter(function(c){ return c.area===a; }).length + ')</option>'; }).join('');
  sel.onchange = function(){ CS.area = this.value; render(); };
  document.getElementById('tcQ').oninput = function(){ CS.q = this.value.toLowerCase(); render(); };
  el.querySelectorAll('button.tile').forEach(function(b){ b.onclick = function(){ CS.s = b.getAttribute('data-go'); render(); }; });
  function render(){
    var base = C.filter(function(c){ return (CS.area==='all' || c.area===CS.area) && (!CS.q || (c.id + ' ' + c.t + ' ' + c.exp + ' ' + c.act + ' ' + c.why.join(' ')).toLowerCase().indexOf(CS.q) >= 0); });
    var st = document.getElementById('tcStatus');
    st.innerHTML = ['all','FAIL','WARN','BLOCKED','PASS'].map(function(s){ var n = base.filter(function(c){ return s==='all' || c.s===s; }).length; return '<button class="chip" data-s="' + s + '" aria-pressed="' + (CS.s===s) + '">' + e(s==='all' ? 'All' : NAMES[s]) + '<span class="c">' + n + '</span></button>'; }).join('');
    st.querySelectorAll('button').forEach(function(b){ b.onclick = function(){ CS.s = b.getAttribute('data-s'); render(); }; });
    var rows = base.filter(function(c){ return CS.s==='all' || c.s===CS.s; });
    document.getElementById('tcBody').innerHTML = rows.map(function(c){
      var what = (c.act ? '<div>' + e(c.act) + '</div>' : '') + (c.why.length ? '<div style="color:' + (c.s==='FAIL' ? 'var(--fail)' : 'var(--muted)') + ';margin-top:4px">' + c.why.map(e).join('<br>') + '</div>' : '');
      var row = '<tr class="row" data-id="' + e(c.id) + '"><td class="lbl" style="white-space:nowrap">' + e(c.id) + '<div class="small">' + e(c.pr) + '</div></td><td>' + pill(c.s) + '</td><td><div class="lbl">' + e(c.t) + '</div><div class="small">' + e(c.area) + '</div></td><td class="hide-s small" style="max-width:300px">' + e(c.exp) + '</td><td style="min-width:260px">' + what + (c.shot ? ' <a href="' + e(c.shot) + '" target="_blank">Screenshot</a>' : '') + '</td></tr>';
      if (CS.open === c.id) row += '<tr class="detail"><td colspan="5"><div class="det"><div><dl>' +
        '<dt>Steps in the sheet</dt><dd style="white-space:pre-line">' + e(c.steps) + '</dd>' +
        '<dt>Expected</dt><dd>' + e(c.exp) + '</dd>' +
        (c.known ? '<dt>Note in the sheet</dt><dd>' + e(c.known) + '</dd>' : '') +
        '<dt>What the test did</dt><dd>' + (c.log.length ? '<ol style="margin:0;padding-left:18px">' + c.log.map(function(x){ return '<li>' + e(x) + '</li>'; }).join('') + '</ol>' : '–') + '</dd>' +
        (c.url ? '<dt>Page</dt><dd>' + link(c.url) + '</dd>' : '') +
        '<dt>Tested</dt><dd>' + e(new Date(c.at).toLocaleString()) + ' · ' + (Math.round(c.ms/100)/10) + ' s</dd></dl></div>' +
        (c.shot ? '<div class="shot"><a href="' + e(c.shot) + '" target="_blank"><img src="' + e(c.shot) + '" alt="Screenshot of ' + e(c.id) + '" loading="lazy"></a></div>' : '<div></div>') + '</div></td></tr>';
      return row;
    }).join('') || '<tr><td colspan="5" class="empty">No test cases match.</td></tr>';
    document.getElementById('tcBody').querySelectorAll('tr.row').forEach(function(tr){ tr.onclick = function(){ var id = tr.getAttribute('data-id'); CS.open = CS.open===id ? null : id; render(); }; });
  }
  render();
})();

var start = (location.hash || '').slice(1);
show(TABS.some(function(t){ return t[0]===start; }) ? start : (D.noLinks && D.jr ? 'cases' : 'summary'));
window.addEventListener('hashchange', function(){ var h = (location.hash || '').slice(1); if (TABS.some(function(t){ return t[0]===h; })) show(h); });
})();
</script>
</body>
</html>`;
}
