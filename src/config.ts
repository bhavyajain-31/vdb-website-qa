import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface Config {
  baseUrl: string;
  /** 0 = homepage links only, 1 = + cards on listing pages, 2 = + links on product/detail pages. */
  maxDepth: number;
  /** Hard cap on unique links tested (after dedupe). */
  maxLinks: number;
  /** Product cards sampled per listing page. */
  cardsPerListing: number;
  /** Links taken from a product / Ring Builder detail page (one level below the pages opened from the homepage). */
  linksPerPage: number;
  /** Links (other than product cards) taken from each page opened from the homepage: banners, sliders, CTAs… */
  linksPerLandingPage: number;
  /** Result modals opened per diamond / gemstone search page. */
  modalsPerSearch: number;
  /** Parallel browser sessions for page tests. */
  concurrency: number;
  /** Max simultaneous page loads served by Shopify app proxy (/apps/...). Protects against HTTP 429. */
  appConcurrency: number;
  /** Minimum gap between two app page loads (ms). */
  appGapMs: number;
  viewport: 'desktop' | 'tablet' | 'mobile';
  navTimeoutMs: number;
  contentTimeoutMs: number;
  imageTimeoutMs: number;
  /** Hard limit per test case; a hung page is reported as "could not verify". */
  caseTimeoutMs: number;
  /** Stop starting new tests after this many minutes (0 = no limit). Remaining tests run next time. */
  timeBudgetMin: number;
  checkExternal: boolean;
  outDir: string;
  stateFile: string;
  /** Start a new testing cycle: forget previous results. */
  fresh: boolean;
  /** Re-run cases that failed in this cycle (e.g. after a fix). */
  retestFailed: boolean;
  /** Re-crawl the homepage even when resuming (picks up new links). */
  rediscover: boolean;
  /** Refresh check: how many links per app page (rb list, diamond search…) get a reload test. 0 = all. */
  refreshPerPage: number;
  /** Re-measure pages rated slow one at a time at the end (accurate numbers without test load). Max pages. */
  confirmSlow: number;
  /** Page timing thresholds (ms) for "ready" (main content visible). */
  perf: { fastMs: number; slowMs: number };
  allowEmpty: RegExp[];
  meaningfulParams: string[];
  trackingHosts: RegExp[];
  headless: boolean;
  only: RegExp | null;
  blockThirdParty: RegExp[] | null;
  /** Do not download fonts and videos (never validated; saves bandwidth and CPU). */
  blockFontsAndMedia: boolean;
}

const defaults: Config = {
  baseUrl: 'https://shopify.vdbapp.com/',
  maxDepth: 2,
  maxLinks: 400,
  cardsPerListing: 2,
  linksPerPage: 2,
  linksPerLandingPage: 60,
  modalsPerSearch: 1,
  // ~1.5 browser sessions per CPU core (pages are CPU-heavy), between 2 and 8
  concurrency: Math.max(2, Math.min(8, Math.round(os.cpus().length * 1.5))),
  appConcurrency: 3,
  appGapMs: 350,
  viewport: 'desktop',
  navTimeoutMs: 40_000,
  contentTimeoutMs: 30_000,
  imageTimeoutMs: 8_000,
  caseTimeoutMs: 150_000,
  timeBudgetMin: 23,
  checkExternal: true,
  outDir: path.resolve('reports/latest'),
  stateFile: path.resolve('state/progress.json'),
  fresh: false,
  retestFailed: false,
  rediscover: false,
  perf: { fastMs: 3000, slowMs: 6000 },
  refreshPerPage: 3,
  confirmSlow: 40,
  allowEmpty: [/\/apps\/vdb-wishlist/, /\/cart\b/],
  meaningfulParams: [
    'q', 'shapes', 'fancy', 'gem_type', 'diamondSearchType', 'diamond_type', 'color_type',
    'ring_style', 'metal_type', 'brands', 'supported_shape', 'jewelry_type',
    'natural_stock_num', 'labgrown_stock_num', 'gemstone_stock_num', 'ring_stock_num',
    'stone_reference_id', 'ring_reference_id', 'ring_var_id', 'quiz_start', 'sort_by', 'page',
    'filter.v.availability', 'filter.p.m.custom.metal_type', 'filter.p.product_type', 'stock_num',
  ],
  trackingHosts: [/facebook\.com\/tr/, /google-analytics/, /doubleclick/, /bat\.bing/, /klaviyo/, /pixel/],
  headless: true,
  only: null,
  blockFontsAndMedia: true,
  blockThirdParty: [
    /google-analytics\.com/, /googletagmanager\.com/, /connect\.facebook\.net/, /facebook\.com\/tr/,
    /klaviyo\.com/, /glood\.ai/, /acsbapp\.com/, /shop\.app\//, /otlp-http-production\.shopifysvc\.com/,
    /monorail-edge\.shopifysvc\.com/, /hotjar\.com/, /clarity\.ms/, /doubleclick\.net/, /bat\.bing\.com/,
    /\/api\/collect/, /\/api\/event\/collect/,
    // reCAPTCHA is NOT blocked: the Ring Builder now requires a reCAPTCHA token to load its results
  ],
};

export const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false },
  tablet: { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true },
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
} as const;

/** Keys that may be set in qa.config.json (plain JSON values only). */
type FileConfig = Partial<Omit<Config, 'allowEmpty' | 'trackingHosts' | 'only' | 'blockThirdParty'>> & {
  allowEmpty?: string[]; trackingHosts?: string[]; only?: string; blockThirdParty?: string[] | null;
};

function applyFile(c: Config, file: string) {
  if (!fs.existsSync(file)) return;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as FileConfig & { $comment?: unknown };
  delete raw.$comment;
  const { allowEmpty, trackingHosts, only, blockThirdParty, outDir, stateFile, perf, ...rest } = raw;
  Object.assign(c, rest);
  if (perf) c.perf = { ...c.perf, ...perf };
  if (outDir) c.outDir = path.resolve(outDir);
  if (stateFile) c.stateFile = path.resolve(stateFile);
  if (allowEmpty) c.allowEmpty = allowEmpty.map(s => new RegExp(s));
  if (trackingHosts) c.trackingHosts = trackingHosts.map(s => new RegExp(s));
  if (only) c.only = new RegExp(only, 'i');
  if (blockThirdParty !== undefined) c.blockThirdParty = blockThirdParty ? blockThirdParty.map(s => new RegExp(s)) : null;
}

export const HELP = `Usage: npm run qa -- [options]

Run control
  --fresh               Start a new testing cycle (forget previous results)
  --retest-failed       Re-run cases that failed earlier in this cycle (after a fix)
  --rediscover          Re-crawl the homepage menus/sliders even when resuming
  --budget <min>        Stop starting new tests after <min> minutes (default ${defaults.timeBudgetMin}; 0 = no limit)

Scope
  --base-url <url>      Site to test (default ${defaults.baseUrl})
  --depth <n>           0 homepage links, 1 + listing cards, 2 + detail-page links (default ${defaults.maxDepth})
  --max-links <n>       Max unique links to test (default ${defaults.maxLinks})
  --cards <n>           Product cards sampled per listing (default ${defaults.cardsPerListing})
  --modals <n>          Result modals opened per diamond/gemstone search (default ${defaults.modalsPerSearch})
  --only <regex>        Test only links whose label or URL matches
  --no-external         Do not open links to other websites (social icons etc.)
  --refresh-all         Reload-test every app result page (default: ${defaults.refreshPerPage} per page type)
  --viewport <v>        desktop | tablet | mobile (default desktop)

Speed
  --concurrency <n>     Parallel browser sessions (default ${defaults.concurrency})
  --app-concurrency <n> Parallel app-proxy page loads (default ${defaults.appConcurrency})

Output
  --out <dir>           Report folder (default reports/latest)
  --state <file>        Progress file used for resuming (default state/progress.json)
  --config <file>       Settings file (default qa.config.json if present)
  --headed              Show the browser
  --no-block            Do not block analytics/chat/marketing requests`;

export function loadConfig(argv = process.argv.slice(2)): Config {
  const c: Config = { ...defaults, perf: { ...defaults.perf } };
  const cfgAt = argv.indexOf('--config');
  applyFile(c, path.resolve(cfgAt >= 0 ? argv[cfgAt + 1] : 'qa.config.json'));
  const take = (i: number) => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`Missing value for ${argv[i]}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--config': i++; break;
      case '--base-url': c.baseUrl = take(i++); break;
      case '--depth': c.maxDepth = Number(take(i++)); break;
      case '--max-links': c.maxLinks = Number(take(i++)); break;
      case '--cards': c.cardsPerListing = Number(take(i++)); break;
      case '--modals': c.modalsPerSearch = Number(take(i++)); break;
      case '--concurrency': c.concurrency = Number(take(i++)); break;
      case '--app-concurrency': c.appConcurrency = Number(take(i++)); break;
      case '--viewport': c.viewport = take(i++) as Config['viewport']; break;
      case '--out': c.outDir = path.resolve(take(i++)); break;
      case '--state': c.stateFile = path.resolve(take(i++)); break;
      case '--budget': c.timeBudgetMin = Number(take(i++)); break;
      case '--external': c.checkExternal = true; break;
      case '--no-external': c.checkExternal = false; break;
      case '--refresh-all': c.refreshPerPage = 0; break;
      case '--headed': c.headless = false; break;
      case '--fresh': c.fresh = true; break;
      case '--retest-failed': c.retestFailed = true; break;
      case '--rediscover': c.rediscover = true; break;
      case '--no-block': c.blockThirdParty = null; break;
      case '--only': c.only = new RegExp(take(i++), 'i'); break;
      case '--help': case '-h':
        console.log(HELP);
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`Unknown option ${a} (try --help)`);
    }
  }
  if (!c.baseUrl.endsWith('/')) c.baseUrl += '/';
  if (!['desktop', 'tablet', 'mobile'].includes(c.viewport)) throw new Error(`Unknown viewport ${c.viewport}`);
  return c;
}

/** Plain-JSON copy of the config for the report. */
export function configForReport(c: Config): Record<string, unknown> {
  return {
    baseUrl: c.baseUrl, maxDepth: c.maxDepth, maxLinks: c.maxLinks, cardsPerListing: c.cardsPerListing,
    modalsPerSearch: c.modalsPerSearch, concurrency: c.concurrency, appConcurrency: c.appConcurrency,
    viewport: c.viewport, timeBudgetMin: c.timeBudgetMin, checkExternal: c.checkExternal, perf: c.perf,
    retestFailed: c.retestFailed, only: c.only ? String(c.only) : null,
  };
}
