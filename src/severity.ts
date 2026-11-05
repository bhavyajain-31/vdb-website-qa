/**
 * Turns technical check results into plain-language issues with a severity:
 *   critical    – a shopper hits a broken page, wrong page, missing price, empty or wrong results
 *   performance – the page works but is slow
 *   minor       – cosmetic or copy problems; the journey still works
 */
import type { Check, Issue, Severity } from './types.js';

type Rule = { severity: Severity; title: string; explain: (d: string) => string; fix: string; owner: Issue['owner'] };

const RULES: Record<string, Rule> = {
  'Valid href': {
    severity: 'critical', title: 'Broken link address',
    explain: () => 'The link address is malformed, so clicking it does not open the intended page.',
    fix: 'Correct the link URL in Shopify admin (Online Store → Navigation, or the section settings).', owner: 'Store admin / content',
  },
  'Click from source': {
    severity: 'critical', title: 'Clicking does not work',
    explain: d => /did not navigate|nothing/i.test(d) ? 'Clicking this element does nothing: the shopper stays on the same page.'
      : /different|instead/i.test(d) ? 'Clicking goes to a different page than the link points to.'
      : 'The element could not be clicked like a shopper would.',
    fix: 'Check the element is visible, not covered by another element, and has a working link.', owner: 'Developer',
  },
  'Required option feedback': {
    severity: 'critical', title: 'Button does nothing and shows no message',
    explain: d => `The button does nothing until an option is chosen, and no popup or message tells the shopper why. ${d}`,
    fix: 'Show a clear message such as "Please choose a ring size" when the button is clicked without a selection.', owner: 'Developer',
  },
  'Direct open': {
    severity: 'critical', title: 'Page does not open',
    explain: d => /HTTP 404/.test(d) ? 'The page does not exist (error 404 "Not found").'
      : /HTTP 5\d\d/.test(d) ? 'The server returned an error while opening this page.'
      : /loop/i.test(d) ? 'The page keeps redirecting and never opens.'
      : 'The page failed to open.',
    fix: 'Fix or remove the link, or restore the missing page.', owner: 'Investigate',
  },
  'Redirects': {
    severity: 'critical', title: 'Too many redirects',
    explain: () => 'Opening this link bounces through many redirects, which is slow and may never finish.',
    fix: 'Point the link straight at the final URL and remove redirect chains.', owner: 'Developer',
  },
  'Correct destination': {
    severity: 'critical', title: 'Opens the wrong page',
    explain: d => /homepage/i.test(d) ? 'Instead of the expected page, the shopper is sent back to the homepage.'
      : /start page|Stock number not found/i.test(d) ? 'The item in the link no longer exists, so the shopper lands on the Ring Builder start page.'
      : /login/i.test(d) ? 'The shopper is asked to log in unexpectedly.'
      : 'The link opens a different kind of page than expected.',
    fix: 'Update the link to a page/item that exists, or remove it.', owner: 'Store admin / content',
  },
  'Page title': {
    severity: 'critical', title: '"Not found" page',
    explain: () => 'The page opens but shows a "Not found" message.', fix: 'Restore the page or update the link.', owner: 'Store admin / content',
  },
  'Parameters preserved': {
    severity: 'critical', title: 'Filters are lost',
    explain: () => 'The link asks for specific filters (shape, colour, stock number…), but the page that opens does not keep them, so the shopper sees the wrong selection.',
    fix: 'Make the page read its filters from the URL and keep them.', owner: 'Developer',
  },
  'Click matches direct open': {
    severity: 'minor', title: 'Clicking and opening the link give different pages',
    explain: () => 'Clicking the link and opening it directly (e.g. from a shared URL) end up on slightly different pages.',
    fix: 'Make sure the link URL is the final page URL.', owner: 'Developer',
  },
  'Content loaded': {
    severity: 'critical', title: 'Page stays blank',
    explain: () => 'The page opened, but its main content never appeared.',
    fix: 'Check the app or theme section that renders this page (browser console errors, failed API calls).', owner: 'Developer',
  },
  'Results rendered': {
    severity: 'critical', title: 'No results shown',
    explain: d => /render failure|no empty-state|No products rendered and no empty/i.test(d) ? 'No products appear and there is no "no results" message: the list failed to load.'
      : 'The page shows "no results" for a category that the site links to.',
    fix: 'Add products to the collection/filter, or change the link to a populated one.', owner: 'Store admin / content',
  },
  'Result count matches cards': {
    severity: 'minor', title: 'Result count is wrong',
    explain: d => `The number of results the page announces does not match what it shows (${d}).`,
    fix: 'Check how the results counter is calculated.', owner: 'Developer',
  },
  'Results match filter': {
    severity: 'critical', title: 'Shows products that do not match the filter',
    explain: d => `Some products shown do not match what the link asks for. ${d}`,
    fix: 'Check the filter logic or the product data (shape/colour/type) of the listed items.', owner: 'Investigate',
  },
  'Product cards complete': {
    severity: 'minor', title: 'Product cards missing details',
    explain: d => `Some product cards are missing a name, price or image: ${d}`,
    fix: 'Fill in the missing product data.', owner: 'Store admin / content',
  },
  'No duplicate results': {
    severity: 'minor', title: 'Same product listed twice',
    explain: d => `The same item appears more than once in the list: ${d}`, fix: 'Check the listing query / pagination.', owner: 'Developer',
  },
  'Detail modal': {
    severity: 'critical', title: 'Item details do not open',
    explain: d => /did not open|not clickable/i.test(d) ? 'Clicking an item in the results does not open its detail view.'
      : `The item detail view opens but has a problem: ${d}`,
    fix: 'Check the detail popup for this item type.', owner: 'Developer',
  },
  'Correct stock number shown': {
    severity: 'critical', title: 'Wrong or missing item on detail page',
    explain: () => 'The detail page does not show the item (stock number) the link points to.', fix: 'Update the link or restore the item.', owner: 'Store admin / content',
  },
  'Product loaded': {
    severity: 'critical', title: 'Product page is empty',
    explain: () => 'The product page opened without a product title.', fix: 'Check the product is published and its template renders.', owner: 'Investigate',
  },
  'Product has price': {
    severity: 'critical', title: 'Price missing on product page',
    explain: () => 'The product page shows no price, so the shopper cannot see what it costs.', fix: 'Set a price for the product (or fix the app that renders the price).', owner: 'Store admin / content',
  },
  'Title matches product data': {
    severity: 'minor', title: 'Product title does not match its options',
    explain: d => `The product name mentions one shape but the product only offers others (${d}).`, fix: 'Correct the product title or its shape options in Shopify admin.', owner: 'Store admin / content',
  },
  'Label matches filters': {
    severity: 'minor', title: 'Menu label and link filters disagree',
    explain: d => `The link text promises one thing but the link filters something else: ${d}`, fix: 'Align the menu label and the link URL.', owner: 'Store admin / content',
  },
  'Images': {
    severity: 'critical', title: 'Broken images',
    explain: d => `Some images on this page do not load or display. ${d}`, fix: 'Re-upload the missing images or fix their URLs (see the Images tab for the exact files).', owner: 'Store admin / content',
  },
  'Refresh': {
    severity: 'critical', title: 'Page breaks when refreshed',
    explain: d => /nothing rendered/i.test(d) ? 'After refreshing the page, its results disappear.' : `Refreshing the page changes what it shows (${d}).`,
    fix: 'Make the page render the same results on reload.', owner: 'Developer',
  },
  'Placeholder text': {
    severity: 'minor', title: 'Template placeholder text visible',
    explain: d => `Demo/template text is visible to shoppers: "${d.slice(0, 90)}"`, fix: 'Replace the placeholder text in the theme editor.', owner: 'Store admin / content',
  },
  'Page speed': {
    severity: 'performance', title: 'Slow page',
    explain: d => `The page takes a long time to show its main content (${d}).`, fix: 'Compress large images, reduce apps/scripts loading on this page, check slow API calls.', owner: 'Developer',
  },
  'Valid address': {
    severity: 'critical', title: 'Invalid email/phone link', explain: d => `The contact link is not a valid address: ${d}`, fix: 'Correct the address in the link.', owner: 'Store admin / content',
  },
  'External link reachable': {
    severity: 'critical', title: 'External site link broken', explain: d => `The link to another website fails (${d}).`, fix: 'Update or remove the external link.', owner: 'Store admin / content',
  },
};

function ruleFor(name: string): Rule | undefined {
  return RULES[name] ?? RULES[name.replace(/:.*$/, '')];
}

export function severityOf(name: string): Severity {
  return ruleFor(name)?.severity ?? 'critical';
}

/** Plain-language issues for the failing checks of one case. */
export function issuesFor(checks: Check[]): Issue[] {
  const out: Issue[] = [];
  const seen = new Set<string>();
  for (const c of checks) {
    if (!c.mandatory || (c.status !== 'FAIL' && c.status !== 'WARN')) continue;
    const r = ruleFor(c.name);
    const d = c.detail ?? '';
    const sev = c.severity ?? r?.severity ?? 'critical';
    let title = r?.title ?? c.name;
    if (c.name === 'Results rendered' && /no empty-state|render failure|No products rendered/i.test(d)) title = 'Results never load';
    if (c.name === 'Refresh' && /^Intermittent/i.test(d)) title = 'Results sometimes disappear on refresh';
    if (seen.has(title)) continue;
    seen.add(title);
    const never = title === 'Results never load';
    out.push({
      severity: sev, title,
      explain: r ? r.explain(d) : d,
      fix: never ? 'Check the app or section that renders these results (browser console errors, failed API calls). If there are no items, show a "no results" message instead of an empty page.' : r?.fix ?? 'Investigate the technical detail.',
      owner: never ? 'Developer' : r?.owner ?? 'Investigate',
      tech: d ? `${c.name}: ${d}` : c.name,
      check: c.name,
    });
  }
  const order: Record<Severity, number> = { critical: 0, performance: 1, minor: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Plain explanation for statuses that are not failures. */
export function blockedReason(checks: Check[]): string | undefined {
  const b = checks.find(c => c.mandatory && c.status === 'BLOCKED');
  if (!b) return undefined;
  const d = b.detail ?? '';
  if (/429|rate/i.test(d)) return 'The store temporarily refused requests (too many requests). It will be re-tried on the next run.';
  if (/login/i.test(d)) return 'This page needs a customer login, which the test does not have.';
  if (/bot protection/i.test(d)) return 'The store\'s bot protection (security check page) blocked the test browser. It will be re-tried on the next run.';
  if (/took too long|time limit/i.test(d)) return 'The page took too long to test. It will be re-tried on the next run.';
  return `Could not be verified: ${d}`;
}
