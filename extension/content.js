function getRetailer() {
  const host = location.hostname.replace('www.', '');
  if (host.includes('lowes.com'))          return 'lowes';
  if (host.includes('tractorsupply.com'))  return 'tractorsupply';
  if (host.includes('homedepot.com'))      return 'homedepot';
  if (host.includes('walmart.com'))        return 'walmart';
  return 'unknown';
}

// ── JSON-LD parser — proven reliable on Lowe's via bookmarklet tests ──────────
function extractJsonLd() {
  const results = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    try {
      const j = JSON.parse(s.textContent);
      const arr = Array.isArray(j) ? j : (j['@graph'] ? j['@graph'] : [j]);
      arr.forEach(p => {
        if (!p || p['@type'] !== 'Product') return;
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
      });
    } catch(e) {}
  });
  return results;
}

// ── Lowe's: JSON-LD primary (proven by bookmarklet), DOM fallback ─────────────
function extractLowes() {
  const ld = extractJsonLd();
  if (ld.length > 0) return ld;

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
    const url   = link ? new URL(link.href, location.origin).href : null;
    if (!title || !url) return null;
    return { id: null, name: title, now_price: priceOf(card), was_price: null, url, image: (card.querySelector('img') || {}).src || null };
  }).filter(Boolean);
}

// ── Tractor Supply ────────────────────────────────────────────────────────────
function extractTSC() {
  const ld = extractJsonLd();
  if (ld.length > 0) return ld;

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
    const url   = link ? new URL(link.href, location.origin).href : null;
    if (!title || !url) return null;
    return { id: null, name: title, now_price: priceOf(card), was_price: null, url, image: (card.querySelector('img') || {}).src || null };
  }).filter(Boolean);
}

// ── Walmart ───────────────────────────────────────────────────────────────────
function extractWalmart() {
  const ld = extractJsonLd();
  if (ld.length > 0) return ld;

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
    const url   = link ? new URL(link.href, location.origin).href : null;
    if (!title || !url) return null;
    return { id: null, name: title, now_price: priceOf(card), was_price: null, url, image: (card.querySelector('img') || {}).src || null };
  }).filter(Boolean);
}

// ── Home Depot: Apollo cache primary (confirmed by HD API research), DOM fallback
// HD is an Apollo/GraphQL app. Products live in window.__APOLLO_CLIENT__.cache
// which is accessible from the page context (not the extension isolated world).
// We inject a <script> to read it and relay via window.postMessage.
async function extractHomeDepot() {
  const apollo = await readHdApolloCache();
  if (apollo.length > 0) return apollo;

  const ld = extractJsonLd();
  if (ld.length > 0) return ld;

  const cards = findCards([
    '[class*="plp-pod"]',
    '[data-testid*="pod"]',
    '[class*="product-pod"]',
    'li[data-productid]',
    'article',
  ]);
  return cards.map(card => {
    const link  = card.querySelector('a[href*="/p/"]') || card.querySelector('a');
    const title = textOf(card, ['[class*="product-header"]', '[class*="product-title"]', '[class*="productHeader"]', 'h2', 'h3']);
    const url   = link ? new URL(link.href, location.origin).href : null;
    if (!title || !url) return null;
    return { id: null, name: title, now_price: priceOf(card), was_price: null, url, image: (card.querySelector('img') || {}).src || null };
  }).filter(Boolean);
}

// Injects into page context, reads Apollo cache, relays via postMessage
function readHdApolloCache() {
  return new Promise(resolve => {
    const listener = event => {
      if (event.source !== window || event.data?.type !== 'HD_APOLLO_PRODUCTS') return;
      window.removeEventListener('message', listener);
      resolve(event.data.products || []);
    };
    window.addEventListener('message', listener);
    setTimeout(() => { window.removeEventListener('message', listener); resolve([]); }, 1500);

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

  const nextEl = findNextElement(retailer);
  if (nextEl) {
    try {
      const href = new URL(nextEl.href || nextEl.getAttribute('href'), location.origin).href;
      if (href !== location.href) return href;
    } catch {}
  }

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
  for (const a of document.querySelectorAll('a[href]')) {
    if (isDisabled(a)) continue;
    const text  = a.textContent.trim();
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
    // Nao=N (offset) + Nrpp=N (page size) — confirmed by bookmarklet pagination tests
    const step = parseInt(p.get('Nrpp') || '24', 10);
    const nao  = parseInt(p.get('Nao')  || '0',  10);
    p.set('Nao', String(nao + step));
    return url.toString();
  }
  if (retailer === 'tractorsupply') {
    p.set('page', String(parseInt(p.get('page') || '1', 10) + 1));
    return url.toString();
  }
  if (retailer === 'walmart') {
    p.set('page', String(parseInt(p.get('page') || '1', 10) + 1));
    return url.toString();
  }
  if (retailer === 'homedepot') {
    // HD GraphQL uses startIndex for pagination (from searchModel variables)
    const step = 24;
    const si   = parseInt(p.get('startIndex') || '0', 10);
    p.set('startIndex', String(si + step));
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

// ── Main extract dispatcher (async to support HD's Apollo cache read) ─────────

async function extractProducts() {
  const retailer = getRetailer();
  let products = [];
  if      (retailer === 'lowes')          products = extractLowes();
  else if (retailer === 'tractorsupply')  products = extractTSC();
  else if (retailer === 'walmart')        products = extractWalmart();
  else if (retailer === 'homedepot')      products = await extractHomeDepot();
  return { retailer, products };
}

// ── Auto-scan: follows pagination automatically ───────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function doScanStep(retailer) {
  let { products } = await extractProducts();

  if (products.length === 0) {
    await sleep(2500);
    ({ products } = await extractProducts());
  }

  // 0 products after retry = end of listing, stop scan
  if (products.length === 0) {
    await chrome.storage.local.set({ autoScanning: false });
    chrome.runtime.sendMessage({ type: 'AUTO_SCAN_COMPLETE' });
    return;
  }

  await new Promise(resolve =>
    chrome.runtime.sendMessage({ type: 'SEND_PRODUCTS', products, retailer }, resolve)
  );

  const next = findNextPageUrl();
  if (next) {
    await sleep(500);
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
  await sleep(3500);
  await doScanStep(retailer);
})();

// ── Message handler from popup ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true, retailer: getRetailer(), url: location.href });
    return;
  }

  if (msg.type === 'EXTRACT_AND_SEND') {
    extractProducts().then(({ retailer, products }) => {
      if (products.length === 0) {
        sendResponse({ ok: false, error: 'No products found. Try scrolling down to load more items, then scan again.' });
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
    doScanStep(retailer)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});
