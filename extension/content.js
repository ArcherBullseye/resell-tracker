// Detect which retailer this page is
function getRetailer() {
  const host = location.hostname.replace('www.', '');
  if (host.includes('lowes.com'))          return 'lowes';
  if (host.includes('tractorsupply.com'))  return 'tractorsupply';
  if (host.includes('homedepot.com'))      return 'homedepot';
  if (host.includes('walmart.com'))        return 'walmart';
  return 'unknown';
}

// ── Lowe's extraction ─────────────────────────────────────────────────────────
// Selectors are guesses — Lowe's React app may need tuning after first live test.
function extractLowes() {
  const cards = findCards([
    '[class*="ProductCard"]',
    '[data-testid*="product"]',
    'ol[class*="plp"] > li',
    'ul[class*="plp"] > li',
    '[class*="grid"] > li',
    '[class*="grid"] > article',
    'article[data-testid]',
  ]);
  return cards.map(card => {
    const link  = card.querySelector('a[href*="/pd/"], a[href*="/p/"]') || card.querySelector('a');
    const title = textOf(card, ['[class*="description"]', '[class*="title"]', '[class*="name"]', 'h2', 'h3']);
    const price = priceOf(card);
    const img   = (card.querySelector('img') || {}).src || null;
    const url   = link ? new URL(link.href, location.origin).href : null;
    if (!title || !url) return null;
    return { id: null, name: title, now_price: price, was_price: null, url, image: img };
  }).filter(Boolean);
}

// ── Tractor Supply extraction ─────────────────────────────────────────────────
function extractTSC() {
  const cards = findCards([
    '[class*="product-card"]',
    '[class*="ProductCard"]',
    '[data-testid*="product"]',
    '[class*="plp-item"]',
    '.grid-item',
    'li[class*="item"]',
  ]);
  return cards.map(card => {
    const link  = card.querySelector('a[href*="/p/"], a[href*="/pd/"]') || card.querySelector('a');
    const title = textOf(card, ['[class*="product-name"]', '[class*="title"]', 'h2', 'h3']);
    const price = priceOf(card);
    const img   = (card.querySelector('img') || {}).src || null;
    const url   = link ? new URL(link.href, location.origin).href : null;
    if (!title || !url) return null;
    return { id: null, name: title, now_price: price, was_price: null, url, image: img };
  }).filter(Boolean);
}

// ── Generic helpers ───────────────────────────────────────────────────────────

function findCards(selectors) {
  for (const sel of selectors) {
    const els = [...document.querySelectorAll(sel)];
    // Filter out tiny/nested elements; we want top-level product containers
    const filtered = els.filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 80 && rect.height > 80;
    });
    if (filtered.length >= 2) return filtered;
  }
  return [];
}

function textOf(container, selectors) {
  for (const sel of selectors) {
    const el = container.querySelector(sel);
    if (el) {
      const t = el.textContent.trim();
      if (t.length > 3) return t;
    }
  }
  return null;
}

function priceOf(container) {
  // Look for dollar amounts; prefer clearance/sale price (usually first or smaller)
  const candidates = [...container.querySelectorAll('[class*="price"], [class*="Price"], [aria-label*="price"]')];
  for (const el of candidates) {
    const t = el.textContent.trim();
    const m = t.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
    if (m) {
      const v = parseFloat(m[1].replace(',', ''));
      if (!isNaN(v) && v > 0) return v;
    }
  }
  return null;
}

// ── Main extract dispatcher ───────────────────────────────────────────────────

function extractProducts() {
  const retailer = getRetailer();
  let products = [];
  if (retailer === 'lowes')         products = extractLowes();
  else if (retailer === 'tractorsupply') products = extractTSC();
  else products = extractLowes(); // generic fallback tries same heuristics
  return { retailer, products };
}

// ── Message handler from popup ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true, retailer: getRetailer(), url: location.href });
    return;
  }
  if (msg.type === 'EXTRACT_AND_SEND') {
    const { retailer, products } = extractProducts();
    if (products.length === 0) {
      sendResponse({ ok: false, error: 'No products found on this page. Try scrolling to load more, then scan again.' });
      return;
    }
    chrome.runtime.sendMessage({ type: 'SEND_PRODUCTS', products, retailer }, result => {
      sendResponse(result || { ok: false, error: 'Background worker did not respond.' });
    });
    return true; // async
  }
});
