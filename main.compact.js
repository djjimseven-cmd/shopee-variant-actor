import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

const SOURCE = 'apify_shopee_variant_crawl';
const today = () => new Date().toISOString().slice(0, 10);
const txt = (v = '') => String(v || '').replace(/\s+/g, ' ').trim();
const noMark = (v = '') => txt(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v > 100000000 ? Math.round(v / 100000) : Math.round(v);
  const n = Number(String(v).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const ids = (url = '') => {
  const m = String(url).match(/product\/(\d+)\/(\d+)/i);
  return { shopId: m?.[1] || '', productId: m?.[2] || '' };
};
const norm = (title, variant) => {
  const s = noMark(`${title} ${variant}`);
  const weight = s.match(/(\d+(?:[.,]\d+)?)\s*(kg|g)\b/);
  const volume = s.match(/(\d+(?:[.,]\d+)?)\s*(ml|l)\b/);
  const pack = s.match(/(?:combo|set|box|hop)\s*(\d+)|(\d+)\s*(?:tui|goi|cay|vien|pcs|pack|packs)\b|x\s*(\d+)\b/);
  const flavor = s.includes('ca ngu') ? 'ca ngu' : s.includes('ca') ? 'ca' : s.includes('ga') ? 'ga' : s.includes('bo') ? 'bo' : s.includes('sua') ? 'sua' : '';
  const type = s.includes('pate') ? 'pate' : s.includes('sup') || s.includes('soup') ? 'soup' : s.includes('snack') || s.includes('thuong') ? 'snack' : s.includes('hat') ? 'hat' : s.includes('cat') ? 'cat' : 'other';
  return { normalized_weight: weight ? `${weight[1].replace(',', '.')}${weight[2]}` : '', normalized_volume: volume ? `${volume[1].replace(',', '.')}${volume[2].toUpperCase()}` : '', normalized_pack_count: pack ? Number(pack[1] || pack[2] || pack[3]) : null, normalized_flavor: flavor, normalized_type: type };
};
const row = (seed, meta, v, date) => {
  const parsed = ids(seed.product_link);
  const name = txt(v.variant_name || v.name || v.groups?.filter(Boolean).join(' - ') || meta.title || seed.product_name);
  return { sku: seed.sku, seed_product_link: seed.product_link, parent_product_id: seed.product_id || parsed.productId, parent_product_name: meta.title || seed.product_name || '', competitor_shop_name: meta.shop || '', competitor_shop_link: meta.shopLink || '', competitor_product_link: seed.product_link, competitor_product_id: seed.product_id || parsed.productId, variant_id: String(v.variant_id || v.modelId || ''), variant_name: name, variant_group_1: v.groups?.[0] || '', variant_group_2: v.groups?.[1] || '', variant_group_3: v.groups?.[2] || '', ...norm(meta.title || seed.product_name, name), variant_price: num(v.price || v.variant_price || meta.price), variant_original_price: num(v.originalPrice || v.variant_original_price), variant_stock: v.stock ?? null, variant_sold_est: v.sold ?? null, currency: 'VND', image_url: meta.image || '', source_type: SOURCE, snapshot_date: date, raw_json: v.raw || v };
};
async function meta(page, seed) {
  return page.evaluate((seedRow) => {
    const q = (sel, attr) => document.querySelector(sel)?.getAttribute?.(attr) || document.querySelector(sel)?.textContent?.trim() || '';
    const title = q('meta[property="og:title"]', 'content') || document.querySelector('h1')?.textContent?.trim() || seedRow.product_name || '';
    const image = q('meta[property="og:image"]', 'content') || document.querySelector('img')?.src || '';
    const shopA = document.querySelector('a[href*="/shop/"]');
    const shopLink = shopA?.href || '';
    const shop = shopA?.textContent?.trim() || '';
    const body = document.body.innerText || '';
    const price = body.match(/₫\s*[\d.,]+|[\d.,]+\s*đ/i)?.[0] || '';
    return { title, image, shop, shopLink, price };
  }, seed);
}
async function variants(page) {
  return page.evaluate(() => {
    const out = [];
    const walk = (x) => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x.tier_variations) && Array.isArray(x.models)) {
        for (const m of x.models) {
          const ix = m.extinfo?.tier_index || m.tier_index || [];
          const groups = ix.map((n, i) => x.tier_variations[i]?.options?.[n]?.name || x.tier_variations[i]?.options?.[n] || '').filter(Boolean);
          out.push({ modelId: m.modelid || m.model_id, name: m.name, groups, price: m.price || m.price_stocks?.[0]?.current_price, originalPrice: m.price_before_discount, stock: m.stock ?? m.normal_stock, sold: m.sold, raw: m });
        }
      }
      for (const v of Object.values(x)) walk(v);
    };
    for (const s of [...document.scripts].map(s => s.textContent || '').filter(t => t.includes('tier_variations') && t.includes('models'))) {
      const matches = s.match(/\{[\s\S]*\}/g) || [];
      for (const m of matches.slice(0, 3)) try { walk(JSON.parse(m)); } catch {}
    }
    return out;
  });
}
await Actor.init();
const input = await Actor.getInput();
const date = input.snapshot_date || today();
const all = [];
const crawler = new PlaywrightCrawler({ maxRequestsPerCrawl: input.max_requests_per_crawl || 50, maxConcurrency: 2, async requestHandler({ request, page }) {
  const seed = request.userData.seed;
  log.info(`Crawling ${seed.sku}`);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const m = await meta(page, seed);
  const vs = await variants(page);
  const rows = (vs.length ? vs : [{ variant_name: m.title, price: m.price, raw: { fallback: true } }]).map(v => row(seed, m, v, date));
  for (const r of rows) { all.push(r); await Actor.pushData(r); }
}, async failedRequestHandler({ request, error }) {
  const seed = request.userData.seed; const r = row(seed, {}, { raw: { crawl_status: 'failed', crawl_error: error.message } }, date); all.push(r); await Actor.pushData(r);
}});
await crawler.run((input.items || []).map(i => ({ url: i.product_link, uniqueKey: `${i.sku}:${i.product_link}`, userData: { seed: i } })));
await Actor.setValue('OUTPUT', { items: all });
if (input.webhook_url) await fetch(input.webhook_url, { method: 'POST', headers: { 'content-type': 'application/json', ...(input.webhook_headers || {}) }, body: JSON.stringify({ items: all }) });
await Actor.exit();
