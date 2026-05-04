import { Actor } from 'apify';
import { PlaywrightCrawler, log, sleep } from 'crawlee';

const DEFAULT_SOURCE_TYPE = 'apify_shopee_variant_crawl';
const MIN_VARIANT_WARNING_COUNT = 2;

function stripDiacritics(value = '') {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function compactWhitespace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugifyVietnamese(value = '') {
  return compactWhitespace(stripDiacritics(value).toLowerCase());
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(/,/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function toCount(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;
  const raw = slugifyVietnamese(value).replace(/\s+/g, '');
  const match = raw.match(/(\d+(?:[.,]\d+)?)(k|nghin|tr|trieu|m)?/i);
  if (!match) return toNumber(value);
  const parsed = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(parsed)) return null;
  const unit = match[2] || '';
  if (unit === 'k' || unit === 'nghin') return Math.round(parsed * 1000);
  if (unit === 'tr' || unit === 'trieu' || unit === 'm') return Math.round(parsed * 1000000);
  return Math.round(parsed);
}

function cleanPrice(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (value > 100000000) return Math.round(value / 100000);
    if (value > 1000000 && value % 100000 === 0) return Math.round(value / 100000);
    return Math.round(value);
  }
  return toNumber(value);
}

function parseShopeeIds(url = '') {
  const text = String(url || '');
  const match =
    text.match(/product\/(\d+)\/(\d+)/i) ||
    text.match(/(?:^|[.-])i\.(\d+)\.(\d+)(?:[/?#]|$)/i) ||
    text.match(/[?&]shopid=(\d+).*?[?&]itemid=(\d+)/i);
  return {
    shopId: match?.[1] || '',
    productId: match?.[2] || '',
  };
}

function normalizeWeight(text = '') {
  const normalized = slugifyVietnamese(text);
  const match = normalized.match(/(\d+(?:[.,]\d+)?)\s*(kg|g)\b/);
  if (!match) return '';
  const value = match[1].replace(',', '.');
  return `${value}${match[2]}`;
}

function normalizeVolume(text = '') {
  const normalized = slugifyVietnamese(text);
  const match = normalized.match(/(\d+(?:[.,]\d+)?)\s*(ml|l)\b/);
  if (!match) return '';
  const value = match[1].replace(',', '.');
  return `${value}${match[2].toUpperCase()}`;
}

function normalizePackCount(text = '') {
  const normalized = slugifyVietnamese(text);
  const patterns = [
    /(?:combo|set|box|hop)\s*(\d+)/,
    /(\d+)\s*(?:tui|goi|cay|vien|pcs|pack|packs)\b/,
    /x\s*(\d+)\b/,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function normalizeFlavor(text = '') {
  const normalized = slugifyVietnamese(text);
  const flavorMap = [
    ['ca hoi', /\bca\s*hoi\b/],
    ['ca ngu', /\bca ngu\b/],
    ['hai san', /\bhai san\b/],
    ['ga nuong', /\bga\s*nuong\b/],
    ['ga', /\b(thit\s*)?ga\b/],
    ['bo', /\b(thit\s*)?bo\b/],
    ['cuu', /\b(thit\s*)?cuu\b/],
    ['vit', /\b(thit\s*)?vit\b/],
    ['heo', /\b(thit\s*)?(heo|lon)\b/],
    ['gan ga', /\bgan\s*ga\b/],
    ['ca', /\bca\b/],
    ['sua', /\bsua\b/],
    ['gan', /\bgan\b/],
    ['tom', /\btom\b/],
    ['rau cu', /\brau\s*cu\b/],
  ];
  for (const [label, pattern] of flavorMap) {
    if (pattern.test(normalized)) return label;
  }
  return '';
}

function normalizeType(productTitle = '', variantText = '') {
  const normalized = slugifyVietnamese(`${productTitle} ${variantText}`);
  if (normalized.includes('pate')) return 'pate';
  if (normalized.includes('sup') || normalized.includes('soup')) return 'soup';
  if (normalized.includes('snack') || normalized.includes('thuong')) return 'snack';
  if (normalized.includes('hat')) return 'hat';
  if (normalized.includes('cat')) return 'cat';
  return 'other';
}

function buildVariantName(parts = []) {
  return parts.filter(Boolean).map(compactWhitespace).join(' - ');
}

function buildVariantKey(item) {
  return [
    item.variant_name || '',
    item.variant_price || '',
    item.seed_product_link || '',
  ].join('|');
}

async function closeCommonPopups(page) {
  const candidates = [
    'button:has-text("Đồng ý")',
    'button:has-text("Cho phép")',
    'button:has-text("OK")',
    'button:has-text("Bỏ qua")',
    'button[aria-label="close"]',
    '.shopee-popup__close-btn',
  ];

  for (const selector of candidates) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 500 })) {
        await locator.click({ timeout: 1000 });
      }
    } catch {
      // ignore popup failures
    }
  }
}

async function extractParentMeta(page, seed) {
  return page.evaluate((seedRow) => {
    const safeText = (selectors) => {
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (node?.textContent?.trim()) return node.textContent.trim();
      }
      return '';
    };

    const safeAttr = (selectors, attr) => {
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        const value = node?.getAttribute?.(attr);
        if (value) return value;
      }
      return '';
    };

    const imageUrl =
      safeAttr(['meta[property="og:image"]'], 'content') ||
      safeAttr(['img'], 'src');

    const productTitle =
      safeAttr(['meta[property="og:title"]'], 'content') ||
      safeText(['h1', '[data-testid="pdp-product-name"]']) ||
      seedRow.product_name ||
      '';

    const shopName = safeText([
      'a[href*="/shop/"]',
      '[data-testid="shop-page-shop-name"]',
      '.page-product__shop-info a',
    ]);

    let shopLink = safeAttr(['a[href*="/shop/"]'], 'href');
    if (shopLink && shopLink.startsWith('/')) {
      shopLink = new URL(shopLink, location.href).href;
    }

    return {
      parent_product_name: productTitle,
      competitor_shop_name: shopName,
      competitor_shop_link: shopLink,
      image_url: imageUrl,
      currency: 'VND',
    };
  }, seed);
}

async function extractStructuredVariants(page) {
  return page.evaluate(() => {
    const scripts = Array.from(document.scripts || []);

    function extractBraceBlock(text, startIndex) {
      let depth = 0;
      let started = false;
      for (let i = startIndex; i < text.length; i += 1) {
        const char = text[i];
        if (char === '{') {
          depth += 1;
          started = true;
        } else if (char === '}') {
          depth -= 1;
          if (started && depth === 0) {
            return text.slice(startIndex, i + 1);
          }
        }
      }
      return null;
    }

    function findStructuredObject() {
      for (const script of scripts) {
        const text = script.textContent || '';
        if (!text.includes('tier_variations') || !text.includes('models')) continue;
        const idx = text.indexOf('{');
        if (idx === -1) continue;
        const candidate = extractBraceBlock(text, idx);
        if (!candidate) continue;
        try {
          const parsed = JSON.parse(candidate);
          const walk = (obj) => {
            if (!obj || typeof obj !== 'object') return null;
            if (Array.isArray(obj?.tier_variations) && Array.isArray(obj?.models)) {
              return obj;
            }
            for (const value of Object.values(obj)) {
              const found = walk(value);
              if (found) return found;
            }
            return null;
          };
          const found = walk(parsed);
          if (found) return found;
        } catch {
          // try next script
        }
      }
      return null;
    }

    const structured = findStructuredObject();
    if (!structured) return [];

    const tiers = Array.isArray(structured.tier_variations) ? structured.tier_variations : [];
    const models = Array.isArray(structured.models) ? structured.models : [];

    return models.map((model) => {
      const groups = [];
      const indexes = Array.isArray(model.extinfo?.tier_index)
        ? model.extinfo.tier_index
        : Array.isArray(model.tier_index)
          ? model.tier_index
          : [];

      indexes.forEach((tierOptionIndex, tierIndex) => {
        const tier = tiers[tierIndex];
        const optionValue = tier?.options?.[tierOptionIndex];
        groups.push({
          groupName: tier?.name || `group_${tierIndex + 1}`,
          optionValue: typeof optionValue === 'string' ? optionValue : optionValue?.name || '',
        });
      });

      return {
        modelId: model.modelid || model.model_id || '',
        name: model.name || '',
        price: model.price || model.price_stocks?.[0]?.current_price || null,
        originalPrice: model.price_before_discount || null,
        stock:
          typeof model.stock === 'number'
            ? model.stock
            : typeof model.normal_stock === 'number'
              ? model.normal_stock
              : null,
        sold: typeof model.sold === 'number' ? model.sold : null,
        groups,
      };
    });
  });
}

async function extractApiVariants(page, seed) {
  const ids = parseShopeeIds(seed.product_link);
  if (!ids.shopId || !ids.productId) {
    const pageIds = parseShopeeIds(page.url());
    ids.shopId = ids.shopId || pageIds.shopId;
    ids.productId = ids.productId || pageIds.productId;
  }
  if (!ids.shopId || !ids.productId) return [];

  return page.evaluate(async ({ shopId, itemId }) => {
    const normalize = (value = '') =>
      String(value || '')
        .replace(/\s+/g, ' ')
        .trim();

    const apiUrls = [
      `/api/v4/pdp/get_pc?shop_id=${encodeURIComponent(shopId)}&item_id=${encodeURIComponent(itemId)}&tz_offset_minutes=420&detail_level=0`,
      `/api/v4/item/get?shopid=${encodeURIComponent(shopId)}&itemid=${encodeURIComponent(itemId)}`,
    ];

    async function fetchJson(path) {
      try {
        const response = await fetch(path, {
          credentials: 'include',
          headers: {
            accept: 'application/json',
            'x-api-source': 'pc',
            'x-requested-with': 'XMLHttpRequest',
          },
        });
        if (!response.ok) return null;
        return response.json();
      } catch {
        return null;
      }
    }

    function findItemData(value, seen = new Set()) {
      if (!value || typeof value !== 'object' || seen.has(value)) return null;
      seen.add(value);
      if (Array.isArray(value.tier_variations) && Array.isArray(value.models)) return value;
      if (value.item && typeof value.item === 'object') {
        const found = findItemData(value.item, seen);
        if (found) return found;
      }
      if (value.data && typeof value.data === 'object') {
        const found = findItemData(value.data, seen);
        if (found) return found;
      }
      for (const child of Object.values(value)) {
        const found = findItemData(child, seen);
        if (found) return found;
      }
      return null;
    }

    function optionName(option) {
      if (typeof option === 'string') return option;
      return normalize(option?.name || option?.option || option?.value || '');
    }

    function priceFromModel(model) {
      return (
        model.price ||
        model.price_before_discount ||
        model.price_stocks?.[0]?.current_price ||
        model.price_stocks?.[0]?.price ||
        model.price_stocks?.[0]?.promotion_price ||
        null
      );
    }

    function stockFromModel(model) {
      if (typeof model.stock === 'number') return model.stock;
      if (typeof model.normal_stock === 'number') return model.normal_stock;
      if (typeof model.price_stocks?.[0]?.stock === 'number') return model.price_stocks[0].stock;
      return null;
    }

    function soldFromModel(model, item) {
      if (typeof model.sold === 'number') return model.sold;
      if (typeof model.historical_sold === 'number') return model.historical_sold;
      if (typeof item.sold === 'number') return item.sold;
      if (typeof item.historical_sold === 'number') return item.historical_sold;
      return null;
    }

    for (const apiUrl of apiUrls) {
      const payload = await fetchJson(apiUrl);
      const item = findItemData(payload);
      if (!item) continue;

      const tiers = Array.isArray(item.tier_variations) ? item.tier_variations : [];
      const models = Array.isArray(item.models) ? item.models : [];
      const title = normalize(item.title || item.name || item.item?.title || '');
      const shop = item.shop_detailed || item.shop || {};
      const image =
        item.image ||
        item.images?.[0] ||
        item.image_url ||
        '';

      return models.map((model) => {
        const tierIndexes = Array.isArray(model.extinfo?.tier_index)
          ? model.extinfo.tier_index
          : Array.isArray(model.tier_index)
            ? model.tier_index
            : [];
        const groups = tierIndexes.map((tierOptionIndex, tierIndex) => {
          const tier = tiers[tierIndex] || {};
          return {
            groupName: normalize(tier.name || `group_${tierIndex + 1}`),
            optionValue: optionName(tier.options?.[tierOptionIndex]),
          };
        });

        return {
          modelId: model.modelid || model.model_id || '',
          name: normalize(model.name),
          price: priceFromModel(model),
          originalPrice: model.price_before_discount || null,
          stock: stockFromModel(model),
          sold: soldFromModel(model, item),
          groups,
          parentMeta: {
            parent_product_name: title,
            competitor_shop_name: normalize(shop.name || shop.shop_name || ''),
            competitor_shop_link: shop.shopid ? `/shop/${shop.shopid}` : '',
            image_url: image,
            currency: 'VND',
          },
        };
      });
    }

    return [];
  }, { shopId: ids.shopId, itemId: ids.productId });
}

async function extractDomVariantGroups(page) {
  return page.evaluate(() => {
    const normalize = (value = '') =>
      String(value || '')
        .replace(/\s+/g, ' ')
        .trim();

    const isVisible = (node) => {
      const rect = node.getBoundingClientRect?.();
      const style = window.getComputedStyle?.(node);
      return Boolean(
        rect &&
          rect.width > 10 &&
          rect.height > 10 &&
          style?.display !== 'none' &&
          style?.visibility !== 'hidden'
      );
    };

    const getOptionLabel = (node) => {
      const text = normalize(node.innerText || node.textContent || '');
      if (!text) return '';
      return text
        .split('\n')
        .map(normalize)
        .filter(Boolean)
        .at(-1) || text;
    };

    const optionSelector = [
      'button',
      '[role="button"]',
      '[class*="product-variation"]',
      '[class*="variation"]',
      '[class*="Variation"]',
      '[aria-disabled]',
    ].join(',');

    const isDisabled = (node) => {
      const className = String(node.className || '');
      return (
        node.hasAttribute('disabled') ||
        node.getAttribute('aria-disabled') === 'true' ||
        /disabled|soldout|sold-out|hethang|het-hang|khong.*hang|không.*hàng/i.test(className) ||
        /hết hàng|sold out/i.test(node.innerText || node.textContent || '')
      );
    };

    const productRoot =
      document.querySelector('[class*="product-briefing"]') ||
      document.querySelector('[class*="ProductBriefing"]') ||
      document.querySelector('[class*="pdp"]') ||
      document.querySelector('main') ||
      document.body;

    const bodyText = normalize(document.body.innerText || document.body.textContent || '').toLowerCase();
    const looksLikeAuthGate =
      /log in|login|back to home page|skip to main content|dang nhap|đăng nhập/i.test(bodyText) &&
      !/₫|\d[\d.,]+\s*đ|them vao gio hang|thêm vào giỏ hàng|mua ngay/i.test(bodyText);
    const looksLikeProduct =
      /₫|\d[\d.,]+\s*đ|them vao gio hang|thêm vào giỏ hàng|mua ngay|phan loai|phân loại/i.test(bodyText);
    if (looksLikeAuthGate || !looksLikeProduct) return [];

    const sections = Array.from(productRoot.querySelectorAll('div')).filter((node) => {
      if (!isVisible(node)) return false;
      const text = normalize(node.innerText || node.textContent || '');
      if (!text || text.length > 1200) return false;
      const optionNodes = Array.from(node.querySelectorAll(optionSelector)).filter(
        (child) => child !== node && isVisible(child)
      );
      const labels = new Set(
        optionNodes
          .map(getOptionLabel)
          .filter((label) => label && label.length <= 80)
      );
      return labels.size >= 2;
    });

    const groups = [];
    for (const section of sections) {
      const titleCandidate = Array.from(section.children).find((child) => {
        const text = normalize(child.textContent || '');
        return text && text.length <= 40 && !child.querySelector(optionSelector);
      });
      const seen = new Set();
      const options = Array.from(section.querySelectorAll(optionSelector))
        .map((button) => ({
          label: getOptionLabel(button),
          disabled: isDisabled(button),
        }))
        .filter((option) => {
          if (!option.label || option.label.length > 80) return false;
          if (/^(phân loại|phan loai|tặng kèm|tang kem|số lượng|so luong)$/i.test(option.label)) {
            return false;
          }
          const key = option.label.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

      if (options.length >= 2) {
        const optionText = options.map((option) => option.label).join('|');
        if (groups.some((group) => group.options.map((option) => option.label).join('|') === optionText)) {
          continue;
        }
        groups.push({
          title: titleCandidate?.textContent?.trim() || `group_${groups.length + 1}`,
          options,
        });
      }
    }

    const primaryGroups = groups.filter((group) => {
      const title = normalize(group.title).toLowerCase();
      return !/tặng kèm|tang kem|quà tặng|qua tang|số lượng|so luong/i.test(title);
    });

    return (primaryGroups.length ? primaryGroups : groups).slice(0, 2);
  });
}

function cartesianCombinations(groups) {
  if (!groups.length) return [[]];
  return groups.reduce(
    (acc, group) =>
      acc.flatMap((prefix) =>
        group.options
          .filter((option) => !option.disabled)
          .map((option) => [...prefix, { groupTitle: group.title, ...option }])
      ),
    [[]]
  );
}

async function clickVariantCombination(page, combination) {
  for (const option of combination) {
    const escaped = option.label.replace(/"/g, '\\"');
    const locator = page
      .locator(
        `button:has-text("${escaped}"), [role="button"]:has-text("${escaped}"), [class*="product-variation"]:has-text("${escaped}"), [class*="variation"]:has-text("${escaped}")`
      )
      .first();
    if ((await locator.count()) > 0) {
      await locator.click({ timeout: 3000 });
    } else {
      await page.getByText(option.label, { exact: true }).first().click({ timeout: 3000 });
    }
    await sleep(300);
  }
}

async function readCurrentVariantState(page) {
  return page.evaluate(() => {
    const findPriceText = () => {
      const candidates = Array.from(document.querySelectorAll('*'))
        .map((node) => node.textContent?.trim() || '')
        .filter((text) => /₫|\d[\d.,]+\s*đ/i.test(text))
        .sort((a, b) => a.length - b.length);
      return candidates[0] || '';
    };

    const allText = document.body.innerText || '';
    const soldMatch = allText.match(/(\d[\d.,]*(?:\s*(?:k|K|nghìn|tr|triệu|m))?)\s*(da ban|đã bán|sold)/i);
    const stockMatch = allText.match(/(?:kho|stock|con lai|còn lại)[:\s]+(\d[\d.,]*)/i);
    const originalMatch = allText.match(/(?:Gia goc|Giá gốc|original price)[:\s]*([₫\d.,]+)/i);

    return {
      priceText: findPriceText(),
      soldText: soldMatch?.[1] || '',
      stockText: stockMatch?.[1] || '',
      originalPriceText: originalMatch?.[1] || '',
    };
  });
}

function buildNormalizedFields(productTitle, variantName) {
  const text = `${productTitle} ${variantName}`;
  return {
    normalized_weight: normalizeWeight(text),
    normalized_volume: normalizeVolume(text),
    normalized_pack_count: normalizePackCount(text),
    normalized_flavor: normalizeFlavor(text),
    normalized_type: normalizeType(productTitle, variantName),
  };
}

function buildRow(seed, parentMeta, item) {
  const ids = parseShopeeIds(item.competitor_product_link || seed.product_link);
  const variantGroups = item.groups || [];
  const variantName = compactWhitespace(
    item.name ||
      buildVariantName([
        variantGroups[0]?.optionValue,
        variantGroups[1]?.optionValue,
        variantGroups[2]?.optionValue,
      ])
  );

  const mergedParentMeta = {
    ...parentMeta,
    ...(item.parentMeta || {}),
  };
  const normalized = buildNormalizedFields(mergedParentMeta.parent_product_name, variantName);

  return {
    sku: seed.sku,
    seed_product_link: seed.product_link,
    parent_product_id: seed.product_id || ids.productId || '',
    parent_product_name: mergedParentMeta.parent_product_name || seed.product_name || '',
    competitor_shop_name: mergedParentMeta.competitor_shop_name || '',
    competitor_shop_link: mergedParentMeta.competitor_shop_link || '',
    competitor_product_link: item.competitor_product_link || seed.product_link,
    competitor_product_id: item.competitor_product_id || ids.productId || '',
    variant_id: item.variant_id || item.modelId || '',
    variant_name: variantName,
    variant_group_1: variantGroups[0]?.optionValue || item.variant_group_1 || '',
    variant_group_2: variantGroups[1]?.optionValue || item.variant_group_2 || '',
    variant_group_3: variantGroups[2]?.optionValue || item.variant_group_3 || '',
    normalized_weight: item.normalized_weight || normalized.normalized_weight,
    normalized_volume: item.normalized_volume || normalized.normalized_volume,
    normalized_pack_count:
      item.normalized_pack_count ?? normalized.normalized_pack_count ?? null,
    normalized_flavor: item.normalized_flavor || normalized.normalized_flavor,
    normalized_type: item.normalized_type || normalized.normalized_type,
    variant_price: cleanPrice(item.variant_price ?? item.price),
    variant_original_price: cleanPrice(item.variant_original_price ?? item.originalPrice),
    variant_stock:
      item.variant_stock === undefined || item.variant_stock === null
        ? toCount(item.stock) ?? null
        : toCount(item.variant_stock),
    variant_sold_est:
      item.variant_sold_est === undefined || item.variant_sold_est === null
        ? toCount(item.sold) ?? null
        : toCount(item.variant_sold_est),
    currency: item.currency || mergedParentMeta.currency || 'VND',
    image_url: item.image_url || mergedParentMeta.image_url || '',
    source_type: DEFAULT_SOURCE_TYPE,
    snapshot_date: item.snapshot_date || seed.snapshot_date || new Date().toISOString().slice(0, 10),
    raw_json: item.raw_json || item.raw || {},
  };
}

async function extractVariantsFromDom(page, seed, parentMeta) {
  const groups = await extractDomVariantGroups(page);
  if (!groups.length) {
    const current = await readCurrentVariantState(page);
    const hasProductSignal = current.priceText || current.stockText || current.soldText;
    const parentName = slugifyVietnamese(parentMeta.parent_product_name || '');
    const looksLikeShopeeShell =
      /log in|login|back to home page|skip to main content|hot deals|shopee viet nam/.test(parentName);
    if (!hasProductSignal && looksLikeShopeeShell) return [];

    return [
      buildRow(seed, parentMeta, {
        variant_name: parentMeta.parent_product_name,
        variant_price: current.priceText,
        variant_original_price: current.originalPriceText,
        variant_stock: toNumber(current.stockText),
        variant_sold_est: toNumber(current.soldText),
        competitor_product_link: seed.product_link,
        raw_json: { fallback: 'no_variant_groups_detected' },
      }),
    ];
  }

  const combinations = cartesianCombinations(groups);
  const rows = [];

  for (const combination of combinations) {
    try {
      await clickVariantCombination(page, combination);
      await sleep(350);
      const current = await readCurrentVariantState(page);
      rows.push(
        buildRow(seed, parentMeta, {
          groups: combination.map((option) => ({
            optionValue: option.label,
          })),
          variant_name: buildVariantName(combination.map((option) => option.label)),
          variant_price: current.priceText,
          variant_original_price: current.originalPriceText,
          variant_stock: toNumber(current.stockText),
          variant_sold_est: toNumber(current.soldText),
          competitor_product_link: seed.product_link,
          raw_json: {
            extraction: 'dom_click',
            combination,
            current,
          },
        })
      );
    } catch (error) {
      rows.push(
        buildRow(seed, parentMeta, {
          groups: combination.map((option) => ({
            optionValue: option.label,
          })),
          variant_name: buildVariantName(combination.map((option) => option.label)),
          competitor_product_link: seed.product_link,
          raw_json: {
            extraction: 'dom_click_failed',
            combination,
            error: error.message,
          },
        })
      );
    }
  }

  return rows;
}

async function extractRows(page, seed) {
  await closeCommonPopups(page);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const parentMeta = await extractParentMeta(page, seed);
  const apiVariants = await extractApiVariants(page, seed);

  if (apiVariants.length) {
    log.info(`Extracted ${apiVariants.length} variants from Shopee API for ${seed.sku}.`);
    return apiVariants.map((item) =>
      buildRow(seed, parentMeta, {
        ...item,
        competitor_product_link: seed.product_link,
        raw_json: {
          extraction: 'shopee_pdp_api',
          api_item: item,
        },
      })
    );
  }

  const structured = await extractStructuredVariants(page);

  if (structured.length) {
    log.info(`Extracted ${structured.length} variants from structured scripts for ${seed.sku}.`);
    return structured.map((item) =>
      buildRow(seed, parentMeta, {
        ...item,
        competitor_product_link: seed.product_link,
        raw_json: {
          extraction: 'structured_script',
          structured_item: item,
        },
      })
    );
  }

  const domRows = await extractVariantsFromDom(page, seed, parentMeta);
  log.info(`Extracted ${domRows.length} variants from DOM fallback for ${seed.sku}.`);
  return domRows;
}

async function postWebhook(webhookUrl, headers, items) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(headers || {}),
    },
    body: JSON.stringify({ items }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Webhook POST failed with ${response.status}: ${text}`);
  }

  return response.json().catch(() => ({}));
}

await Actor.init();

const input = (await Actor.getInput()) || {};
const items = Array.isArray(input.items) ? input.items : [];

if (!items.length) {
  throw new Error('Input items array is required.');
}

const results = [];
const seen = new Set();

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: input.max_requests_per_crawl || 100,
  headless: true,
  requestHandlerTimeoutSecs: 120,
  maxConcurrency: 3,
  async requestHandler({ request, page }) {
    const seed = request.userData.seed;
    log.info(`Processing ${seed.sku} -> ${seed.product_link}`);

    const rows = await extractRows(page, {
      ...seed,
      snapshot_date: input.snapshot_date || new Date().toISOString().slice(0, 10),
    });

    if (rows.length > 0 && rows.length < MIN_VARIANT_WARNING_COUNT) {
      log.warning(
        `Only ${rows.length} variant row extracted for ${seed.sku}. Check dataset raw_json.extraction; Shopee may have blocked API/script variant data or the product has no variants.`
      );
    }

    if (!rows.length) {
      const fallback = {
        sku: seed.sku,
        seed_product_link: seed.product_link,
        parent_product_id: seed.product_id || parseShopeeIds(seed.product_link).productId || '',
        parent_product_name: seed.product_name || '',
        competitor_shop_name: '',
        competitor_shop_link: '',
        competitor_product_link: seed.product_link,
        competitor_product_id: seed.product_id || '',
        variant_id: '',
        variant_name: seed.product_name || '',
        variant_group_1: '',
        variant_group_2: '',
        variant_group_3: '',
        normalized_weight: '',
        normalized_volume: '',
        normalized_pack_count: null,
        normalized_flavor: '',
        normalized_type: normalizeType(seed.product_name || '', ''),
        variant_price: null,
        variant_original_price: null,
        variant_stock: null,
        variant_sold_est: null,
        currency: 'VND',
        image_url: '',
        source_type: DEFAULT_SOURCE_TYPE,
        snapshot_date: input.snapshot_date || new Date().toISOString().slice(0, 10),
        raw_json: {
          extraction: 'empty_fallback',
        },
      };
      const key = buildVariantKey(fallback);
      if (!seen.has(key)) {
        seen.add(key);
        results.push(fallback);
        await Actor.pushData(fallback);
      }
      return;
    }

    for (const row of rows) {
      const key = buildVariantKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(row);
      await Actor.pushData(row);
    }
  },
  async failedRequestHandler({ request, error }) {
    const seed = request.userData.seed;
    const failed = {
      sku: seed?.sku || '',
      seed_product_link: seed?.product_link || '',
      parent_product_id: seed?.product_id || '',
      parent_product_name: seed?.product_name || '',
      competitor_shop_name: '',
      competitor_shop_link: '',
      competitor_product_link: seed?.product_link || '',
      competitor_product_id: seed?.product_id || '',
      variant_id: '',
      variant_name: '',
      variant_group_1: '',
      variant_group_2: '',
      variant_group_3: '',
      normalized_weight: '',
      normalized_volume: '',
      normalized_pack_count: null,
      normalized_flavor: '',
      normalized_type: '',
      variant_price: null,
      variant_original_price: null,
      variant_stock: null,
      variant_sold_est: null,
      currency: 'VND',
      image_url: '',
      source_type: DEFAULT_SOURCE_TYPE,
      snapshot_date: input.snapshot_date || new Date().toISOString().slice(0, 10),
      raw_json: {
        crawl_status: 'failed',
        crawl_error: error.message,
      },
    };
    results.push(failed);
    await Actor.pushData(failed);
  },
});

await crawler.run(
  items.map((item) => ({
    url: item.product_link,
    uniqueKey: `${item.sku}:${item.product_link}`,
    userData: {
      seed: item,
    },
  }))
);

await Actor.setValue('OUTPUT', { items: results });

if (input.webhook_url) {
  try {
    const webhookResponse = await postWebhook(input.webhook_url, input.webhook_headers, results);
    await Actor.setValue('WEBHOOK_RESPONSE', webhookResponse);
    log.info('Webhook POST completed successfully.');
  } catch (error) {
    await Actor.setValue('WEBHOOK_ERROR', {
      message: error.message,
    });
    log.exception(error, 'Webhook POST failed');
  }
}

await Actor.exit();
