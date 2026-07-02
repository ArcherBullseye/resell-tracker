function getRetailer() {
  const host = location.hostname.replace('www.', '');
  if (host.includes('lowes.com'))          return 'lowes';
  if (host.includes('tractorsupply.com'))  return 'tractorsupply';
  if (host.includes('homedepot.com'))      return 'homedepot';
  if (host.includes('walmart.com'))        return 'walmart';
  return 'unknown';
}

// ── JSON-LD parser ─────────────────────────────────────────────────────────────
// Proven by bookmarklet tests (v1.2.14). Works on a live document OR a doc
// parsed from a fetch() response via DOMParser.
function extractJsonLdFromDoc(doc) {
  const results = [];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    try {
      const j = JSON.parse(s.textContent);
      const arr = Array.isArray(j) ? j : (j['@graph'] ? j['@graph'] : [j]);
      arr.forEach(p => {
        if (!p) return;
        if (p['@type'] === 'Product') {
          pushProduct(p, results);
        } else if (p['@type'] === 'ItemList') {
          (p.itemListElement || []).forEach(item => {
            const prod = item.item || item;
            if (prod && prod['@type'] === 'Product') pushProduct(prod, results);
          });
        }
      });
    } catch(e) {}
  });
  return results;
}

function pushProduct(p, results) {
  const off  = Array.isArray(p.offers) ? p.offers[0] : p.offers;
  const url  = (off && off.url) || p.url || '';
  const name = p.name || '';
  if (!name || !url) return;
  results.push({
    id: String(p.sku || ''),
    name,
    now_price: (off && off.price != null) ? Number(off.price) : null,
    was_price: null,
    url,
    image: typeof p.image === 'string' ? p.image : (Array.isArray(p.image) ? p.image[0] : ''),
  });
}

// Convenience wrapper for the current document
function extractJsonLd() { return extractJsonLdFromDoc(document); }

// ── Lowe's: JSON-LD from current page (page 1), fetch for subsequent pages ────
// Lowe's only includes JSON-LD on the server-rendered page 1 response.
// Navigating to page 2 in the browser strips it (React client-side routing).
// The bookmarklet worked by fetching each page's HTML with credentials.
// The extension content script does the same — stays on page 1 and fetches all
// subsequent pages, parsing JSON-LD from each server-sent HTML response.
async function extractLowesAllPages(sendProgress) {
  const seen = new Set();
  const all  = [];

  function addProducts(prods) {
    prods.forEach(p => {
      const key = p.url || p.id;
      if (key && !seen.has(key)) { seen.add(key); all.push(p); }
    });
  }

  // Page 1: already in the DOM
  addProducts(extractJsonLd());
  if (all.length === 0) return [];   // Not on a Lowe's listing page

  if (sendProgress) await sendProgress(all.slice(-all.length));

  // Pages 2+: fetch server HTML, parse JSON-LD from each
  const base = new URL(location.href);
  const step = parseInt(base.searchParams.get('Nrpp') || '24', 10);
  let nao = step;

  for (let page = 1; page < 40; page++) {
    base.searchParams.set('Nao', String(nao));
    const html = await fetch(base.toString(), { credentials: 'include' })
      .then(r => r.text())
      .catch(() => null);

    if (!html || html.length < 1500 || /Access Denied|CAPTCHA/i.test(html)) break;

    const doc   = new DOMParser().parseFromString(html, 'text/html');
    const prods = extractJsonLdFromDoc(doc);
    if (prods.length === 0) break;

    const before = all.length;
    addProducts(prods);
    const added = all.length - before;
    if (added === 0) break; // All dupes — ran out of unique products

    if (sendProgress) await sendProgress(all.slice(-added));

    nao += step;
    await sleep(450); // polite delay
  }

  return all;
}

function extractLowes() {
  // For single-page manual scan — just the current page's JSON-LD, fall to DOM
  const ld = extractJsonLd();
  if (ld.length >= 5) return ld;

  const cards = findCards([
    '[class*="ProductCard"]',
    '[data-testid*="product"]',
    'ol[class*="plp"] > li',
    'ul[class*="plp"] > li',
    '[class*="grid"] > li',
    '[class*="grid"] > article',
    'article[data-testid]',
  ]);
  const dom = cardsToProducts(cards, 'a[href*="/pd/"], a[href*="/p/"]');
  return dom.length > ld.length ? dom : ld;
}

// ── Tractor Supply ────────────────────────────────────────────────────────────
function extractTSC() {
  const ld = extractJsonLd();
  if (ld.length >= 5) return ld;

  const cards = findCards([
    '[class*="product-tile"]',
    '[class*="ProductTile"]',
    '[class*="product-card"]',
    '[class*="ProductCard"]',
    '[class*="tile-body"]',
    '[class*="plp-item"]',
    '.product-item',
    'li[class*="item"]',
    '[data-testid*="product"]',
  ]);
  const dom = cardsToProducts(cards, 'a[href*="/p/"], a[href*="/pd/"]');
  return dom.length > ld.length ? dom : ld;
}

// ── Walmart ───────────────────────────────────────────────────────────────────
function extractWalmart() {
  const ld = extractJsonLd();
  if (ld.length >= 5) return ld;

  const cards = findCards([
    '[data-item-id]',
    '[data-testid="list-view"]',
    '[class*="search-result-gridview-item"]',
    'div[data-testid*="product"]',
    '[class*="Grid-module"] > div',
  ]);
  const dom = cardsToProducts(cards, 'a[href*="/ip/"]');
  return dom.length > ld.length ? dom : ld;
}

// ── Home Depot: Apollo cache (reads all cached products at once) ──────────────
async function extractHomeDepot() {
  const apollo = await readHdApolloCache();
  if (apollo.length >= 5) return apollo;

  const ld = extractJsonLd();
  if (ld.length >= 5) return ld;

  const cards = findCards([
    '[class*="plp-pod"]',
    '[data-testid*="pod"]',
    '[class*="product-pod"]',
    'li[data-productid]',
    'article',
  ]);
  const dom = cardsToProducts(cards, 'a[href*="/p/"]');
  return dom.length > apollo.length ? dom : apollo;
}

function readHdApolloCache() {
  return new Promise(resolve => {
    const listener = event => {
      if (event.source !== window || event.data?.type !== 'HD_APOLLO_PRODUCTS') return;
      window.removeEventListener('message', listener);
      resolve(event.data.products || []);
    };
    window.addEventListener('message', listener);
    setTimeout(() => { window.removeEventListener('message', listener); resolve([]); }, 2000);

    const script = document.createElement('script');
    script.textContent = `(function(){
      try {
        var cache = window.__APOLLO_CLIENT__ && window.__APOLLO_CLIENT__.cache.extract();
        var products = [];
        if (cache) {
          Object.values(cache).forEach(function(item) {
            if (!item || item.__typename !== 'Product') return;
            var id = item.identifiers || {};
            var pr = item.pricing || {};
            var img = '';
            if (item.media && item.media.images && item.media.images.length) {
              img = (item.media.images[0].url || '').replace('<SIZE>', '600');
            }
            var url = id.canonicalUrl ? 'https://www.homedepot.com' + id.canonicalUrl : '';
            var name = id.productLabel || '';
            if (!name || !url) return;
            products.push({
              id: String(item.itemId || ''),
              name: name,
              now_price: pr.value != null ? Number(pr.value) : null,
              was_price: pr.original != null ? Number(pr.original) : null,
              url: url,
              image: img
            });
          });
        }
        window.postMessage({ type: 'HD_APOLLO_PRODUCTS', products: products }, '*');
      } catch(e) {
        window.postMessage({ type: 'HD_APOLLO_PRODUCTS', products: [] }, '*');
      }
    })();`;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  });
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

function cardsToProducts(cards, linkSel) {
  return cards.map(card => {
    const link  = (linkSel && card.querySelector(linkSel)) || card.querySelector('a');
    const title = textOf(card, ['[class*="description"]', '[class*="title"]', '[class*="name"]', '[class*="label"]', 'h2', 'h3', 'h4']);
    const url   = link ? tryUrl(link.href) : null;
    if (!title || !url) return null;
    return { id: null, name: title, now_price: priceOf(card), was_price: null, url, image: (card.querySelector('img') || {}).src || null };
  }).filter(Boolean);
}

function tryUrl(href) {
  try { return new URL(href, location.origin).href; } catch { return null; }
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

// ── Retailer-specific next-page URL (used for TSC/Walmart page navigation) ───

function buildNextPageUrl() {
  const retailer = getRetailer();
  const url = new URL(location.href);
  const p   = url.searchParams;

  // Try DOM next-link first
  const selMap = {
    tractorsupply: ['a[aria-label*="next" i]', '[class*="pagination"] a[class*="next" i]', 'li.next a', 'a[title="Next"]'],
    walmart:       ['a[aria-label="Next Page"]', 'button[aria-label="Next Page"]', '[class*="paginator"] a[class*="next" i]'],
    homedepot:     ['a[aria-label="Next"]', '[class*="hd-pagination"] a[aria-label*="next" i]', '[class*="pagination"] a[class*="next" i]'],
  };
  for (const sel of (selMap[retailer] || [])) {
    for (const el of document.querySelectorAll(sel)) {
      if (!isDisabled(el) && (el.href || el.getAttribute('href'))) {
        try {
          const href = new URL(el.href || el.getAttribute('href'), location.origin).href;
          if (href !== location.href) return href;
        } catch {}
      }
    }
  }
  // Generic Next text fallback
  for (const a of document.querySelectorAll('a[href]')) {
    if (isDisabled(a)) continue;
    const text  = a.textContent.trim();
    const label = (a.getAttribute('aria-label') || '').toLowerCase();
    if (text === 'Next' || text === '›' || text === '»' || label === 'next page') {
      try {
        const href = new URL(a.href, location.origin).href;
        if (href !== location.href) return href;
      } catch {}
    }
  }

  // URL construction fallback
  if (retailer === 'tractorsupply') { p.set('page', String(parseInt(p.get('page') || '1', 10) + 1)); return url.toString(); }
  if (retailer === 'walmart')       { p.set('page', String(parseInt(p.get('page') || '1', 10) + 1)); return url.toString(); }
  if (retailer === 'homedepot')     { p.set('startIndex', String(parseInt(p.get('startIndex') || '0', 10) + 24)); return url.toString(); }
  return null;
}

function isDisabled(el) {
  return el.hasAttribute('disabled')
    || el.getAttribute('aria-disabled') === 'true'
    || !!el.closest('[disabled]')
    || !!el.closest('[aria-disabled="true"]');
}

// ── Single-page extract dispatcher ───────────────────────────────────────────

async function extractProducts() {
  const retailer = getRetailer();
  let products = [];
  if      (retailer === 'lowes')          products = extractLowes();
  else if (retailer === 'tractorsupply')  products = extractTSC();
  else if (retailer === 'walmart')        products = extractWalmart();
  else if (retailer === 'homedepot')      products = await extractHomeDepot();
  return { retailer, products };
}

// ── Auto-scan ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// sendProgress: sends a batch of products to the background buffer and returns
// the result (for badge update). Used during multi-page fetch loops.
async function sendBatch(products, retailer) {
  if (!products.length) return;
  return new Promise(resolve =>
    chrome.runtime.sendMessage({ type: 'SEND_PRODUCTS', products, retailer }, resolve)
  );
}

// Lowe's all-pages scan: stays on current page, fetches all subsequent pages.
// This matches exactly how the bookmarklet worked (v1.2.14-v1.2.15).
async function doLowesAutoScan() {
  const retailer = 'lowes';
  await sleep(1000); // small grace period for page to stabilize

  const allProducts = await extractLowesAllPages(async (batch) => {
    await sendBatch(batch, retailer);
  });

  await chrome.storage.local.set({ autoScanning: false });
  chrome.runtime.sendMessage({ type: 'AUTO_SCAN_COMPLETE' });
}

// HD all-pages scan: Apollo cache gets all products at once, no navigation needed.
async function doHDAutoScan() {
  const retailer = 'homedepot';
  await sleep(1500);

  const products = await extractHomeDepot();
  if (products.length > 0) await sendBatch(products, retailer);

  await chrome.storage.local.set({ autoScanning: false });
  chrome.runtime.sendMessage({ type: 'AUTO_SCAN_COMPLETE' });
}

// TSC / Walmart: navigate page by page, polling for DOM products on each page.
async function doPageNavAutoScan(retailer) {
  await sleep(1500);

  // Poll for products (handles slow JS renders — up to 10s per page)
  const deadline = Date.now() + 10000;
  let products = [];
  while (Date.now() < deadline) {
    const r = await extractProducts();
    if (r.products.length > 0) { products = r.products; break; }
    await sleep(600);
  }

  if (products.length === 0) {
    // Nothing on this page = end of listing
    await chrome.storage.local.set({ autoScanning: false });
    chrome.runtime.sendMessage({ type: 'AUTO_SCAN_COMPLETE' });
    return;
  }

  await sendBatch(products, retailer);

  const next = buildNextPageUrl();
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

  if (retailer === 'lowes') {
    // Lowe's fetches all pages from here — no further navigation
    await doLowesAutoScan();
  } else if (retailer === 'homedepot') {
    // HD reads Apollo cache — no navigation
    await doHDAutoScan();
  } else {
    // TSC / Walmart — page-by-page navigation
    await doPageNavAutoScan(retailer);
  }
})();

// ── Message handler from popup ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true, retailer: getRetailer(), url: location.href });
    return;
  }

  if (msg.type === 'EXTRACT_AND_SEND') {
    // Manual single-page scan
    extractProducts().then(({ retailer, products }) => {
      if (products.length === 0) {
        sendResponse({ ok: false, error: 'No products found. Scroll down to load more items, then scan again.' });
        return;
      }
      chrome.runtime.sendMessage({ type: 'SEND_PRODUCTS', products, retailer }, result => {
        sendResponse(result || { ok: false, error: 'Background worker did not respond.' });
      });
    });
    return true;
  }

  if (msg.type === 'START_AUTO_SCAN') {
    const retailer = getRetailer();
    if (retailer === 'unknown') {
      sendResponse({ ok: false, error: 'Not a supported retailer page.' });
      return;
    }
    // Respond immediately so popup doesn't time out waiting
    sendResponse({ ok: true });

    if (retailer === 'lowes') {
      doLowesAutoScan().catch(console.error);
    } else if (retailer === 'homedepot') {
      doHDAutoScan().catch(console.error);
    } else {
      doPageNavAutoScan(retailer).catch(console.error);
    }
  }
});
