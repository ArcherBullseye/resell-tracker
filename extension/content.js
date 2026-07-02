function getRetailer() {
  const host = location.hostname.replace('www.', '');
  if (host.includes('lowes.com'))          return 'lowes';
  if (host.includes('tractorsupply.com'))  return 'tractorsupply';
  if (host.includes('homedepot.com'))      return 'homedepot';
  if (host.includes('walmart.com'))        return 'walmart';
  return 'unknown';
}

// ── Lowe's extraction ─────────────────────────────────────────────────────────
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

// ── Walmart extraction ────────────────────────────────────────────────────────
function extractWalmart() {
  const cards = findCards([
    '[data-item-id]',
    '[data-testid="list-view"]',
    '[class*="search-result-gridview-item"]',
    'div[data-testid*="product"]',
    '[class*="Grid-module"] > div',
  ]);
  return cards.map(card => {
    const link  = card.querySelector('a[href*="/ip/"]') || card.querySelector('a');
    const title = textOf(card, ['[class*="product-title"]', '[data-automation-id="product-title"]', 'span[class*="line-clamp"]', 'h2', 'h3']);
    const price = priceOf(card);
    const img   = (card.querySelector('img') || {}).src || null;
    const url   = link ? new URL(link.href, location.origin).href : null;
    if (!title || !url) return null;
    return { id: null, name: title, now_price: price, was_price: null, url, image: img };
  }).filter(Boolean);
}

// ── Home Depot extraction ─────────────────────────────────────────────────────
function extractHomeDepot() {
  const cards = findCards([
    '[class*="plp-pod"]',
    'div[data-testid*="product-pod"]',
    '[class*="product-pod"]',
    'li[class*="plp-pod"]',
  ]);
  return cards.map(card => {
    const link  = card.querySelector('a[href*="/p/"]') || card.querySelector('a');
    const title = textOf(card, ['[class*="product-header"]', 'h2', 'h3', 'span[class*="title"]']);
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

// ── Retailer-specific next-page logic ─────────────────────────────────────────

function findNextPageUrl() {
  const retailer = getRetailer();

  // 1. Retailer-specific DOM selectors
  const nextEl = findNextElement(retailer);
  if (nextEl) {
    try {
      const href = new URL(nextEl.href || nextEl.getAttribute('href'), location.origin).href;
      if (href !== location.href) return href;
    } catch {}
  }

  // 2. Retailer-specific URL construction
  return buildNextPageUrl(retailer);
}

function findNextElement(retailer) {
  const selMap = {
    lowes: [
      'a[aria-label="next page" i]',
      'button[aria-label="next page" i]',
      '[data-testid="pagination-next"] a',
      '[class*="pagination"] a[class*="next" i]',
    ],
    tractorsupply: [
      'a[aria-label*="next" i]',
      '[class*="pagination"] a[class*="next" i]',
      'li.next a',
      'a[title="Next"]',
    ],
    walmart: [
      'a[aria-label="Next Page"]',
      'button[aria-label="Next Page"]',
      '[class*="paginator"] a[class*="next" i]',
    ],
    homedepot: [
      'a[aria-label="Next"]',
      '[class*="hd-pagination"] a[aria-label*="next" i]',
      '[class*="pagination"] a[class*="next" i]',
    ],
  };
  for (const sel of (selMap[retailer] || [])) {
    for (const el of document.querySelectorAll(sel)) {
      if (!isDisabled(el) && (el.href || el.getAttribute('href'))) return el;
    }
  }
  // Generic text fallback
  for (const a of document.querySelectorAll('a[href]')) {
    if (isDisabled(a)) continue;
    const text = a.textContent.trim();
    const label = (a.getAttribute('aria-label') || '').toLowerCase();
    if (text === 'Next' || text === '›' || text === '»' || label === 'next page') {
      try {
        const href = new URL(a.href, location.origin).href;
        if (href !== location.href) return a;
      } catch {}
    }
  }
  return null;
}

function buildNextPageUrl(retailer) {
  const url = new URL(location.href);
  const p   = url.searchParams;

  if (retailer === 'lowes') {
    // Lowe's uses ?offset=N&limit=24 (or similar)
    const limit  = parseInt(p.get('limit')  || '24', 10);
    const offset = parseInt(p.get('offset') || '0',  10);
    p.set('offset', String(offset + limit));
    p.set('limit', String(limit));
    return url.toString();
  }
  if (retailer === 'tractorsupply') {
    const page = parseInt(p.get('page') || '1', 10);
    p.set('page', String(page + 1));
    return url.toString();
  }
  if (retailer === 'walmart') {
    const page = parseInt(p.get('page') || '1', 10);
    p.set('page', String(page + 1));
    return url.toString();
  }
  if (retailer === 'homedepot') {
    // HD uses Nao=N (N = items offset, increments by 24)
    const hash  = url.hash; // e.g. #Nao=24
    const match = hash.match(/Nao=(\d+)/);
    const nao   = match ? parseInt(match[1], 10) : 0;
    url.hash = hash.replace(/Nao=\d+/, '') + (hash.includes('Nao=') ? '' : '') + `Nao=${nao + 24}`;
    if (!hash.includes('Nao=')) url.hash = (hash || '#') + `&Nao=${nao + 24}`;
    return url.toString();
  }
  return null;
}

function isDisabled(el) {
  return el.hasAttribute('disabled')
    || el.getAttribute('aria-disabled') === 'true'
    || !!el.closest('[disabled]')
    || !!el.closest('[aria-disabled="true"]');
}

// ── Main extract dispatcher ───────────────────────────────────────────────────

function extractProducts() {
  const retailer = getRetailer();
  let products = [];
  if      (retailer === 'lowes')          products = extractLowes();
  else if (retailer === 'tractorsupply')  products = extractTSC();
  else if (retailer === 'walmart')        products = extractWalmart();
  else if (retailer === 'homedepot')      products = extractHomeDepot();
  return { retailer, products };
}

// ── Auto-scan: follows pagination automatically ───────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function doScanStep(retailer) {
  const { products } = extractProducts();
  if (products.length > 0) {
    await new Promise(resolve =>
      chrome.runtime.sendMessage({ type: 'SEND_PRODUCTS', products, retailer }, resolve)
    );
  }
  const next = findNextPageUrl();
  if (next) {
    await sleep(400);
    window.location.href = next;
  } else {
    await chrome.storage.local.set({ autoScanning: false });
    chrome.runtime.sendMessage({ type: 'AUTO_SCAN_COMPLETE' });
  }
}

// Runs on every page load — continues auto-scan if flag is set
(async function initAutoScan() {
  const { autoScanning } = await chrome.storage.local.get('autoScanning');
  if (!autoScanning) return;
  const retailer = getRetailer();
  if (retailer === 'unknown') return;
  await sleep(2500); // wait for JS-rendered product cards
  await doScanStep(retailer);
})();

// ── Message handler from popup ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true, retailer: getRetailer(), url: location.href });
    return;
  }

  if (msg.type === 'EXTRACT_AND_SEND') {
    // Manual single-page scan
    const { retailer, products } = extractProducts();
    if (products.length === 0) {
      sendResponse({ ok: false, error: 'No products found on this page. Try scrolling to load more, then scan again.' });
      return;
    }
    chrome.runtime.sendMessage({ type: 'SEND_PRODUCTS', products, retailer }, result => {
      sendResponse(result || { ok: false, error: 'Background worker did not respond.' });
    });
    return true;
  }

  if (msg.type === 'START_AUTO_SCAN') {
    // First page of auto-scan — popup triggers this
    const retailer = getRetailer();
    if (retailer === 'unknown') {
      sendResponse({ ok: false, error: 'Not a supported retailer page.' });
      return;
    }
    doScanStep(retailer)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});
