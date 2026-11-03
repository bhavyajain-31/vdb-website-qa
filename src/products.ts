/**
 * Product classification and product-page checks.
 *
 * The old tool treated every product the same and judged Shopify products from page text only,
 * which caused false reports, e.g. "Round Halo ring is mislabelled because Supported Shape says Oval":
 * those rings are native Shopify products offered in 7 shapes, and Oval is merely the first variant.
 * Native products are now identified and checked against Shopify's own product data (/products/<handle>.js).
 */
import type { BrowserContext, Page } from 'playwright';
import type { Config } from './config.js';
import { SHAPES } from './content.js';
import type { Check, DiscoveredLink, ProductInfo } from './types.js';

interface ShopifyProductJson {
  title: string; handle: string; vendor: string; type: string; tags: string[]; price: number; available: boolean;
  options: { name: string; values: string[] }[]; variants: { sku: string | null; title: string }[];
}

const cache = new Map<string, Promise<ShopifyProductJson | null>>();

async function shopifyProduct(ctx: BrowserContext, base: string, handle: string): Promise<ShopifyProductJson | null> {
  if (!cache.has(handle)) {
    cache.set(handle, (async () => {
      try {
        const r = await ctx.request.get(new URL(`products/${handle}.js`, base).toString(), { timeout: 15_000 });
        if (!r.ok()) return null;
        return (await r.json()) as ShopifyProductJson;
      } catch { return null; }
    })());
  }
  return cache.get(handle)!;
}

export function handleOf(url: string): string | undefined {
  try { return new URL(url).pathname.match(/\/products\/([^/?#]+)/)?.[1]; } catch { return undefined; }
}

const money = (cents: number) => (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Classify the destination of a link (no page needed). */
export async function classifyProduct(ctx: BrowserContext, link: DiscoveredLink, cfg: Config): Promise<ProductInfo | undefined> {
  if (link.destType === 'rb-details') {
    const u = new URL(link.href);
    if (/rb-setting-details/.test(u.pathname)) return { kind: 'rb-setting', kindLabel: 'Ring Builder setting (VDB app)', stockNumber: u.searchParams.get('ring_stock_num') ?? undefined };
    const nat = u.searchParams.get('natural_stock_num'), lab = u.searchParams.get('labgrown_stock_num'), gem = u.searchParams.get('gemstone_stock_num');
    return {
      kind: 'rb-stone',
      kindLabel: `Ring Builder ${nat ? 'natural diamond' : lab ? 'lab-grown diamond' : gem ? 'gemstone' : 'stone'} (VDB app)`,
      stockNumber: nat ?? lab ?? gem ?? undefined,
    };
  }
  if (link.destType !== 'product') return undefined;
  const handle = handleOf(link.href);
  if (!handle) return undefined;
  const p = await shopifyProduct(ctx, cfg.baseUrl, handle);
  const u = new URL(link.href);
  const configurator = /^configure-/.test(handle) || (!!p && p.price === 0 && u.searchParams.has('stock_num'));
  if (configurator) {
    return {
      kind: 'vdb-configurator', kindLabel: 'Ring configurator (VDB app on a Shopify page)', handle,
      title: p?.title, stockNumber: u.searchParams.get('stock_num') ?? undefined, vendor: p?.vendor,
    };
  }
  if (!p) return { kind: 'shopify-product', kindLabel: 'Shopify product', handle };
  const vdb = p.tags?.some(t => /^VDBJL$|^vdb_stock_num_/i.test(t));
  return {
    kind: 'shopify-product', kindLabel: 'Shopify product', handle, title: p.title, price: money(p.price),
    vendor: p.vendor, productType: p.type || undefined,
    source: vdb ? 'Native Shopify product, synced from VDB jewelry inventory' : 'Native Shopify product',
    stockNumber: p.tags?.find(t => /^vdb_stock_num_/.test(t))?.replace(/^vdb_stock_num_/, '') || p.variants?.[0]?.sku || undefined,
    options: p.options?.map(o => ({ name: o.name, values: o.values })),
  };
}

const PRICE_RE = /(Rs\.?|₹|\$|€|£|INR|USD)\s?\d[\d,]*(\.\d{1,2})?/;

/** Checks for product and ring-builder detail pages. */
export async function productChecks(page: Page, link: DiscoveredLink, info: ProductInfo | undefined): Promise<{ checks: Check[]; stock?: string; title?: string }> {
  const checks: Check[] = [];
  if (link.destType === 'rb-details') {
    const stock = info?.stockNumber;
    const text = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (stock) {
      const found = text.includes(stock);
      checks.push({ name: 'Correct stock number shown', status: found ? 'PASS' : 'FAIL', mandatory: true, detail: found ? `Stock # ${stock} on page` : `Stock # ${stock} not found on page` });
    }
    return { checks, stock };
  }

  // Shopify product page or VDB configurator: wait briefly for an app-rendered price
  const read = () => page.evaluate((src) => {
    const vis = (window as any).__qaVis as (e: Element) => boolean;
    const re = new RegExp(src);
    const h1 = [...document.querySelectorAll('h1, .product__title')].find(e => vis(e)) as HTMLElement | undefined;
    const title = (h1?.innerText || '').split('\n')[0].replace(/\s+/g, ' ').trim();
    const main = document.querySelector('main') || document.body;
    const priceEls = [...main.querySelectorAll('.price-item, .price, [class*="price"], [class*="Price"]')].filter(e => vis(e)) as HTMLElement[];
    let price = '';
    for (const e of priceEls) { const m = (e.innerText || '').match(re); if (m) { price = m[0]; break; } }
    const sku = (document.querySelector('.product__sku, [id^="Sku"]') as HTMLElement | null)?.innerText.replace(/^SKU:\s*/i, '').trim() || '';
    return { title, price, sku };
  }, PRICE_RE.source).catch(() => ({ title: '', price: '', sku: '' }));
  let info2 = await read();
  for (let i = 0; i < 12 && !info2.price; i++) { await page.waitForTimeout(500); info2 = await read(); }

  const titleShown = info2.title || info?.title || '';
  checks.push({ name: 'Product loaded', status: info2.title ? 'PASS' : 'FAIL', mandatory: true, detail: info2.title ? `"${info2.title}"${info2.sku ? ' · SKU ' + info2.sku : ''}` : 'No product title on page' });
  checks.push({ name: 'Product has price', status: info2.price ? 'PASS' : 'FAIL', mandatory: true, detail: info2.price || (info?.kind === 'vdb-configurator' ? 'No price shown (the configurator app did not render a price)' : 'No price shown') });

  // Title vs Shopify product data: the shape in the title must be one the product is offered in.
  if (info?.kind === 'shopify-product' && titleShown) {
    const t = titleShown.toLowerCase();
    const titleShape = SHAPES.find(s => new RegExp(`\\b${s}\\b`).test(t));
    const shapeOpt = info.options?.find(o => /shape/i.test(o.name));
    if (titleShape && shapeOpt) {
      const values = shapeOpt.values.map(v => v.toLowerCase());
      const ok = values.some(v => v.startsWith(titleShape));
      checks.push({
        name: 'Title matches product data', status: ok ? 'PASS' : 'FAIL', mandatory: true, severity: 'minor',
        detail: ok ? `"${titleShape}" is one of the offered shapes (${shapeOpt.values.join(', ')})` : `title says ${titleShape}, but the product is only offered in ${shapeOpt.values.join(', ')}`,
      });
    }
  }
  return { checks, stock: info?.stockNumber || info2.sku || undefined, title: titleShown || undefined };
}

/** A label that is really a variant handle / swatch list / card dump gets replaced by the product title. */
export function displayLabel(label: string, info?: ProductInfo): string {
  const looksLikeHandle = /^[a-z0-9.-]+(,[a-z0-9.-]+)*$/.test(label) || /^\d+k (white|yellow|rose) gold$/i.test(label) || label === '(no text)' || /^view$/i.test(label);
  if (info?.title && looksLikeHandle) return info.title;
  return label;
}
