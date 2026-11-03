/**
 * Status of a single check or a whole test case.
 *
 * PASS     – everything worked.
 * WARN     – works, but has a minor or performance issue ("Passed with warnings").
 * FAIL     – a critical problem a shopper would hit.
 * BLOCKED  – could not be verified (rate limited, network drop, login needed). Re-run next time.
 * PENDING  – not run yet (time budget reached). Runs next time.
 * SKIPPED  – deliberately out of scope (external sites, in-page anchors, over the link cap).
 */
export type Status = 'PASS' | 'WARN' | 'FAIL' | 'BLOCKED' | 'PENDING' | 'SKIPPED';

/** How serious a failed check is. */
export type Severity = 'critical' | 'performance' | 'minor';

/** Where on the site a link was found. */
export type Section =
  | 'homepage' | 'header' | 'megamenu' | 'footer' | 'sliders'
  | 'category' | 'plp' | 'pdp' | 'search';

/** What kind of page a URL is expected to open. */
export type DestType =
  | 'home' | 'collection' | 'product' | 'search'
  | 'diamond-search' | 'gemstone-search' | 'rb-list' | 'rb-details' | 'rb-start'
  | 'wishlist' | 'cart' | 'page' | 'policy' | 'login'
  | 'external' | 'mailto' | 'tel' | 'anchor' | 'malformed' | 'other';

export interface Reveal {
  kind: 'none' | 'menu' | 'drawer' | 'carousel';
  /** Label of the top-level menu item to hover before clicking. */
  topLabel?: string;
}

export interface DiscoveredLink {
  /** Stable key (same link → same key across runs). Used by the resume store. */
  key: string;
  /** Human-friendly ID, stable within a testing cycle (L0001…). */
  id: string;
  sourceUrl: string;
  section: Section;
  label: string;
  rawHref: string;
  /** Absolute expected destination, when identifiable. */
  href: string;
  destType: DestType;
  depth: number;
  reveal: Reveal;
  productId?: string;
  /** Where the link was first found, e.g. ["Mega menu", "Engagement Rings", "Shop By Metal"]. */
  position?: string[];
  /** Every other place the same destination was found (deduped). */
  alsoFoundIn?: { sourceUrl: string; section: Section; label: string }[];
}

/**
 * One visible occurrence of a link on the homepage. The same URL can appear in several places
 * (menu, slider, footer): each place is click-tested on its own; the destination URL is tested once.
 */
export interface Placement {
  pid: string;
  /** Key of the deeplink (unique URL) this placement opens. */
  key: string;
  position: string[];
  section: Section;
  label: string;
  rawHref: string;
  reveal: Reveal;
  secId?: string;
  nth?: number;
  /** Visible without hovering or sliding. */
  visibleAtLoad: boolean;
}

export interface Check {
  name: string;
  status: Status;
  /** Mandatory checks decide the case status; others are informational. */
  mandatory: boolean;
  /** For failing checks: how serious. Defaults from severity.ts by check name. */
  severity?: Severity;
  detail?: string;
}

export type ImageStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'SKIPPED';

export interface ImageResult {
  pageUrl: string;
  src: string;
  status: ImageStatus;
  /** Why it failed / could not be verified / was skipped (plain language). */
  reason?: string;
  kind: 'img' | 'background';
  productId?: string;
  httpStatus?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  /** Page area the image sits in (section id, header, footer…). */
  context?: string;
  /** True when the image belongs to a product card / product gallery. */
  product?: boolean;
  /** Where it sits, e.g. "Mega menu › Engagement Rings › Yellow Gold (icon)". */
  position?: string;
}

export interface ListingInfo {
  resultCount?: number;
  displayed: number;
  emptyState: boolean;
  mismatches: string[];
  incomplete: string[];
  duplicates: string[];
  sample: string[];
}

/** How the destination product is built: native Shopify product vs. VDB app pages. */
export type ProductKind =
  | 'shopify-product'      // native Shopify product (/products/<handle>, real Shopify product data)
  | 'vdb-configurator'     // VDB ring configurator rendered on a placeholder Shopify product
  | 'rb-setting'           // VDB Ring Builder setting (app page, not a Shopify product)
  | 'rb-stone'             // VDB Ring Builder stone (natural / lab-grown / gemstone)
  | 'diamond'              // VDB diamond search result (modal)
  | 'gemstone';            // VDB gemstone search result (modal)

export interface ProductInfo {
  kind: ProductKind;
  /** Plain label, e.g. "Shopify product". */
  kindLabel: string;
  title?: string;
  handle?: string;
  stockNumber?: string;
  price?: string;
  vendor?: string;
  productType?: string;
  /** e.g. "Synced from VDB jewelry feed" when Shopify tags show it. */
  source?: string;
  /** Option values (e.g. Supported Shape: Oval, Round …) from Shopify product data. */
  options?: { name: string; values: string[] }[];
}

/** Load timing of one page as the browser measured it. All values in milliseconds from navigation start. */
export interface PerfSample {
  url: string;
  label: string;
  pageType: DestType;
  /** Server response started. */
  ttfbMs?: number;
  /** HTML parsed (DOMContentLoaded). */
  domReadyMs?: number;
  /** Browser "load" event: all initial files finished. */
  loadMs?: number;
  /** Largest Contentful Paint: main content visible. */
  lcpMs?: number;
  /** The page's own content (results, product, stock #) appeared. */
  contentMs?: number;
  /** Shopper-facing number used for the rating: when main content is ready. */
  readyMs?: number;
  rating: 'fast' | 'ok' | 'slow' | 'unknown';
  requests?: number;
  transferKB?: number;
  slowestResource?: { url: string; ms: number };
  measuredAt: string;
  /** Re-measured on its own after the main pass (accurate). */
  measuredAlone?: boolean;
  /** Ready time measured during the busy main pass, before re-measuring. */
  firstMs?: number;
}

export interface ClickOutcome {
  checks: Check[];
  /** URL the click navigated to (first main-frame navigation). */
  clickUrl?: string;
  /** "Opened the cart drawer" etc. */
  note?: string;
  screenshot?: string;
  at: string;
}

/** Result of opening a link directly (deeplink test), without the click check. */
export interface Validation {
  status: Status;
  checks: Check[];
  directUrl?: string;
  directHttpStatus?: number;
  redirectChain?: string[];
  pageTitle?: string;
  listing?: ListingInfo;
  stockNumber?: string;
  product?: ProductInfo;
  perf?: PerfSample;
  images: ImageResult[];
  screenshot?: string;
  placeholder?: string[];
  testedAt: string;
  durationMs: number;
  attempts: number;
  runId: string;
}

/** Plain-language issue derived from a failing check. */
export interface Issue {
  severity: Severity;
  /** Short title a non-technical reader understands. */
  title: string;
  /** What happened, in simple words. */
  explain: string;
  /** Suggested next step. */
  fix: string;
  /** Who usually fixes it. */
  owner: 'Developer' | 'Store admin / content' | 'Investigate';
  /** Technical detail for developers. */
  tech?: string;
  check: string;
}

export interface LinkResult extends DiscoveredLink, Omit<Validation, 'status' | 'runId'> {
  status: Status;
  clickUrl?: string;
  failureReasons: string[];
  issues: Issue[];
  /** Run that produced this result; differs from the current run when carried over. */
  runId?: string;
  carriedOver?: boolean;
}

/** A homepage placement with its click result and the result of the page it opens. */
export interface PlacementResult extends Placement {
  status: Status;
  linkId?: string;
  href: string;
  destType: DestType;
  clickUrl?: string;
  clickChecks: Check[];
  /** Status of the destination page (deeplink test), without the click. */
  destStatus: Status;
  issues: Issue[];
  reasons: string[];
}

export interface ScenarioResult {
  id: string;
  name: string;
  kind: 'menu' | 'slider' | 'popup' | 'drawer' | 'search' | 'session' | 'copy' | 'other';
  status: Status;
  steps: { step: string; url: string; resultCount?: number; note?: string }[];
  failureReasons: string[];
  screenshot?: string;
  testedAt: string;
  images?: ImageResult[];
  runId?: string;
}

export interface DeadClickable {
  sourceUrl: string;
  section: Section;
  label: string;
  rawHref: string;
  status: Status;
  detail: string;
  screenshot?: string;
}

export interface RunInfo {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  executed: number;
  carriedOver: number;
  stoppedReason?: string;
}

export interface RunReport {
  baseUrl: string;
  cycleId: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  config: Record<string, unknown>;
  runs: RunInfo[];
  links: LinkResult[];
  /** Every visible homepage placement (same URL in several places = several rows). */
  placements: PlacementResult[];
  deadClickables: DeadClickable[];
  scenarios: ScenarioResult[];
  homePerf: PerfSample[];
  /** Images found on the homepage (outside menus) during discovery. */
  homeImages: ImageResult[];
  stoppedReason?: string;
}
