require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'resell.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Migrations ───────────────────────────────────────────────────────────────
// Append new entries to add columns/tables. Never edit or reorder existing ones.

const MIGRATIONS = [
  // v1 — initial items table
  `CREATE TABLE IF NOT EXISTS items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    barcode          TEXT,
    name             TEXT NOT NULL,
    description      TEXT,
    image_url        TEXT,
    category         TEXT,
    buy_price        REAL,
    buy_date         TEXT,
    sell_price       REAL,
    sell_date        TEXT,
    shipping_cost    REAL DEFAULT 0,
    selling_platform TEXT,
    platform_fee_pct REAL DEFAULT 0,
    ebay_avg_price   REAL,
    ebay_low_price   REAL,
    ebay_high_price  REAL,
    status           TEXT DEFAULT 'inventory',
    notes            TEXT,
    created_at       TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at       TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  // v2 — settings table for API keys configured via the UI
  `CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  // v3 — quantity: how many units were purchased in one buy
  `ALTER TABLE items ADD COLUMN quantity INTEGER DEFAULT 1`,

  // v4 — quantity_sold: units sold so far (item fully sold when quantity_sold >= quantity)
  `ALTER TABLE items ADD COLUMN quantity_sold INTEGER DEFAULT 0`,
];

function runMigrations() {
  db.exec(`CREATE TABLE IF NOT EXISTS _schema_version (
    version INTEGER PRIMARY KEY,
    applied TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  const applied = new Set(
    db.prepare('SELECT version FROM _schema_version').all().map(r => r.version)
  );
  const insert = db.prepare('INSERT INTO _schema_version (version) VALUES (?)');

  db.transaction(() => {
    MIGRATIONS.forEach((sql, idx) => {
      const v = idx + 1;
      if (!applied.has(v)) {
        db.exec(sql);
        insert.run(v);
        console.log(`Migration v${v} applied`);
      }
    });
  })();
}

runMigrations();

// DB setting takes priority over env var, env var is the fallback.
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return (row && row.value) || process.env[key] || '';
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Settings ──────────────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  const keys = ['EBAY_APP_ID', 'UPC_API_KEY'];
  const result = {};
  for (const key of keys) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    const val = (row && row.value) || '';
    // Mask everything except last 4 chars so the UI can show "configured" state
    result[key] = val
      ? { configured: true, preview: val.slice(-4).padStart(val.length, '•') }
      : { configured: false, preview: '' };
  }
  res.json(result);
});

app.post('/api/settings', (req, res) => {
  const allowed = ['EBAY_APP_ID', 'UPC_API_KEY', 'LOWES_STORE_ID', 'LOWES_STORE_NAME'];
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  db.transaction(() => {
    for (const key of allowed) {
      if (key in req.body) {
        const val = (req.body[key] || '').trim();
        if (val === '') {
          db.prepare('DELETE FROM settings WHERE key = ?').run(key);
        } else {
          upsert.run(key, val);
        }
      }
    }
  })();

  res.json({ success: true });
});

// ── Items CRUD ───────────────────────────────────────────────────────────────

app.get('/api/items', (req, res) => {
  const { status } = req.query;
  let rows;
  if (status === 'inventory') {
    rows = db.prepare('SELECT * FROM items WHERE status = ? ORDER BY buy_date DESC, created_at DESC').all(status);
  } else if (status === 'sold') {
    rows = db.prepare('SELECT * FROM items WHERE status = ? ORDER BY sell_date DESC, created_at DESC').all(status);
  } else {
    // All items: inventory first, each group sorted by its relevant date
    rows = db.prepare(`
      SELECT * FROM items
      ORDER BY
        CASE WHEN status = 'inventory' THEN 0 ELSE 1 END ASC,
        CASE WHEN status = 'inventory' THEN buy_date ELSE sell_date END DESC,
        created_at DESC
    `).all();
  }
  res.json(rows);
});

app.get('/api/items/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.post('/api/items', (req, res) => {
  const {
    barcode, name, description, image_url, category,
    buy_price, buy_date, sell_price, sell_date,
    shipping_cost, selling_platform, platform_fee_pct,
    ebay_avg_price, ebay_low_price, ebay_high_price,
    status, notes, quantity
  } = req.body;

  if (!name) return res.status(400).json({ error: 'Name is required' });

  const result = db.prepare(`
    INSERT INTO items (
      barcode, name, description, image_url, category,
      buy_price, buy_date, sell_price, sell_date,
      shipping_cost, selling_platform, platform_fee_pct,
      ebay_avg_price, ebay_low_price, ebay_high_price,
      status, notes, quantity
    ) VALUES (
      @barcode, @name, @description, @image_url, @category,
      @buy_price, @buy_date, @sell_price, @sell_date,
      @shipping_cost, @selling_platform, @platform_fee_pct,
      @ebay_avg_price, @ebay_low_price, @ebay_high_price,
      @status, @notes, @quantity
    )
  `).run({
    barcode: barcode || null, name,
    description: description || null, image_url: image_url || null,
    category: category || null, buy_price: buy_price || null,
    buy_date: buy_date || null, sell_price: sell_price || null,
    sell_date: sell_date || null, shipping_cost: shipping_cost || 0,
    selling_platform: selling_platform || null, platform_fee_pct: platform_fee_pct || 0,
    ebay_avg_price: ebay_avg_price || null, ebay_low_price: ebay_low_price || null,
    ebay_high_price: ebay_high_price || null,
    status: status || 'inventory', notes: notes || null,
    quantity: quantity || 1
  });

  res.status(201).json({ id: result.lastInsertRowid });
});

app.put('/api/items/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const {
    barcode, name, description, image_url, category,
    buy_price, buy_date, sell_price, sell_date,
    shipping_cost, selling_platform, platform_fee_pct,
    ebay_avg_price, ebay_low_price, ebay_high_price,
    status, notes, quantity
  } = req.body;

  db.prepare(`
    UPDATE items SET
      barcode = @barcode, name = @name, description = @description,
      image_url = @image_url, category = @category,
      buy_price = @buy_price, buy_date = @buy_date,
      sell_price = @sell_price, sell_date = @sell_date,
      shipping_cost = @shipping_cost, selling_platform = @selling_platform,
      platform_fee_pct = @platform_fee_pct,
      ebay_avg_price = @ebay_avg_price, ebay_low_price = @ebay_low_price,
      ebay_high_price = @ebay_high_price,
      status = @status, notes = @notes, quantity = @quantity,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({
    id: req.params.id,
    barcode: barcode || null, name, description: description || null,
    image_url: image_url || null, category: category || null,
    buy_price: buy_price || null, buy_date: buy_date || null,
    sell_price: sell_price || null, sell_date: sell_date || null,
    shipping_cost: shipping_cost || 0, selling_platform: selling_platform || null,
    platform_fee_pct: platform_fee_pct || 0,
    ebay_avg_price: ebay_avg_price || null, ebay_low_price: ebay_low_price || null,
    ebay_high_price: ebay_high_price || null,
    status: status || 'inventory', notes: notes || null,
    quantity: quantity || 1
  });

  res.json({ success: true });
});

app.delete('/api/items/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Quick-sell one unit from a multi-quantity item
app.post('/api/items/:id/sell', (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });

  const { sell_price, sell_date, selling_platform, platform_fee_pct, shipping_cost } = req.body;
  const newQtySold = (item.quantity_sold || 0) + 1;
  const fullySOld  = newQtySold >= (item.quantity || 1);

  db.prepare(`
    UPDATE items SET
      quantity_sold    = @quantity_sold,
      sell_price       = @sell_price,
      sell_date        = @sell_date,
      selling_platform = @selling_platform,
      platform_fee_pct = @platform_fee_pct,
      shipping_cost    = @shipping_cost,
      status           = @status,
      updated_at       = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({
    id: item.id,
    quantity_sold:    newQtySold,
    sell_price:       sell_price || null,
    sell_date:        sell_date || null,
    selling_platform: selling_platform || null,
    platform_fee_pct: platform_fee_pct || 0,
    shipping_cost:    shipping_cost || 0,
    status:           fullySOld ? 'sold' : 'inventory'
  });

  res.json({ success: true, fully_sold: fullySOld, quantity_sold: newQtySold });
});

// ── Dashboard stats ──────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  const total     = db.prepare('SELECT COUNT(*) as c FROM items').get().c;
  const inventory = db.prepare("SELECT COUNT(*) as c FROM items WHERE status='inventory'").get().c;
  const sold      = db.prepare("SELECT COUNT(*) as c FROM items WHERE status='sold'").get().c;

  const inventoryValue = db.prepare("SELECT COALESCE(SUM(buy_price * COALESCE(quantity,1)),0) as s FROM items WHERE status='inventory'").get().s;
  const totalInvested = db.prepare('SELECT COALESCE(SUM(buy_price * COALESCE(quantity,1)),0) as s FROM items').get().s;
  const totalRevenue  = db.prepare("SELECT COALESCE(SUM(sell_price * COALESCE(quantity_sold,1)),0) as s FROM items WHERE quantity_sold > 0").get().s;
  const totalShipping = db.prepare("SELECT COALESCE(SUM(shipping_cost * COALESCE(quantity_sold,1)),0) as s FROM items WHERE quantity_sold > 0").get().s;
  const totalFees     = db.prepare(
    "SELECT COALESCE(SUM(sell_price * platform_fee_pct / 100 * COALESCE(quantity_sold,1)), 0) as s FROM items WHERE quantity_sold > 0"
  ).get().s;
  const costOfSold = db.prepare("SELECT COALESCE(SUM(buy_price * COALESCE(quantity_sold,1)),0) as s FROM items WHERE quantity_sold > 0").get().s;

  res.json({
    total, inventory, sold, inventoryValue, totalInvested, totalRevenue,
    netProfit: totalRevenue - costOfSold - totalShipping - totalFees,
    totalShipping, totalFees
  });
});

// ── Schema info ──────────────────────────────────────────────────────────────

app.get('/api/schema', (req, res) => {
  const versions = db.prepare('SELECT * FROM _schema_version ORDER BY version').all();
  const columns  = db.prepare('PRAGMA table_info(items)').all();
  res.json({ migrations_applied: versions.length, versions, columns });
});

// ── External API proxies ─────────────────────────────────────────────────────

app.get('/api/lookup/barcode', async (req, res) => {
  const { upc } = req.query;
  if (!upc) return res.status(400).json({ error: 'upc required' });

  try {
    const apiKey = getSetting('UPC_API_KEY');
    const base = apiKey
      ? 'https://api.upcitemdb.com/prod/v1/lookup'
      : 'https://api.upcitemdb.com/prod/trial/lookup';
    const headers = apiKey ? { 'user_key': apiKey } : {};

    const response = await fetch(`${base}?upc=${encodeURIComponent(upc)}`, { headers });
    const data = await response.json();

    if (!data.items || data.items.length === 0) return res.json({ found: false });

    const item = data.items[0];
    res.json({
      found: true,
      name: item.title, description: item.description,
      brand: item.brand, category: item.category,
      image_url: item.images?.[0] || null, images: item.images || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lookup/ebay', async (req, res) => {
  const { q } = req.query;
  const appId = getSetting('EBAY_APP_ID');

  if (!appId) return res.status(400).json({ error: 'eBay App ID not configured — add it in Settings.' });
  if (!q)     return res.status(400).json({ error: 'q required' });

  try {
    const params = new URLSearchParams({
      'OPERATION-NAME': 'findCompletedItems',
      'SERVICE-VERSION': '1.0.0',
      'SECURITY-APPNAME': appId,
      'RESPONSE-DATA-FORMAT': 'JSON',
      'outputSelector': 'SellerInfo',
      'keywords': q,
      'itemFilter(0).name': 'SoldItemsOnly',
      'itemFilter(0).value': 'true',
      'sortOrder': 'EndTimeSoonest',
      'paginationInput.entriesPerPage': '20'
    });

    const response = await fetch(`https://svcs.ebay.com/services/search/FindingService/v1?${params}`);
    const data = await response.json();

    const items = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
    if (items.length === 0) return res.json({ found: false, count: 0 });

    const prices = items
      .map(i => parseFloat(i.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] || 0))
      .filter(p => p > 0);

    const avg  = prices.reduce((a, b) => a + b, 0) / prices.length;

    res.json({
      found: true, count: prices.length,
      avg: +avg.toFixed(2), low: +Math.min(...prices).toFixed(2), high: +Math.max(...prices).toFixed(2),
      recentSales: items.slice(0, 5).map(i => ({
        title:   i.title?.[0],
        price:   parseFloat(i.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] || 0),
        endTime: i.listingInfo?.[0]?.endTime?.[0],
        itemUrl: i.viewItemURL?.[0]
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lookup/ebay/lowest', async (req, res) => {
  const { q } = req.query;
  const appId = getSetting('EBAY_APP_ID');
  if (!appId) return res.status(400).json({ error: 'eBay App ID not configured' });
  if (!q)     return res.status(400).json({ error: 'q required' });

  try {
    const params = new URLSearchParams({
      'OPERATION-NAME':          'findItemsAdvanced',
      'SERVICE-VERSION':         '1.0.0',
      'SECURITY-APPNAME':        appId,
      'RESPONSE-DATA-FORMAT':    'JSON',
      'keywords':                q,
      'sortOrder':               'PricePlusShippingLowest',
      'paginationInput.entriesPerPage': '3'
    });
    const response = await fetch(`https://svcs.ebay.com/services/search/FindingService/v1?${params}`);
    const data = await response.json();
    const items = data?.findItemsAdvancedResponse?.[0]?.searchResult?.[0]?.item || [];
    if (!items.length) return res.json({ found: false });
    const price    = parseFloat(items[0].sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] || 0);
    const shipping = parseFloat(items[0].shippingInfo?.[0]?.shippingServiceCost?.[0]?.['__value__'] || 0);
    res.json({ found: true, price, shipping, total: +(price + shipping).toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Lowe's Scanner ───────────────────────────────────────────────────────────

const LOWES_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

const LOWES_API_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.lowes.com',
  'Referer': 'https://www.lowes.com/',
};

async function lowesGet(url, headers = LOWES_HEADERS) {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (res.status === 403) throw new Error('BLOCKED');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('NO_NEXT_DATA');
  return JSON.parse(m[1]);
}

function dig(obj, ...paths) {
  for (const path of paths) {
    let cur = obj;
    for (const key of path.split('.')) {
      if (cur == null) break;
      cur = cur[key];
    }
    if (cur != null) return cur;
  }
  return null;
}

function parseProducts(nextData, minDiscount) {
  const products = dig(nextData,
    'props.pageProps.data.productResults.products',
    'props.pageProps.productResults.products',
    'props.pageProps.data.products',
    'props.pageProps.initialData.products',
    'props.pageProps.products'
  );
  if (!Array.isArray(products)) return { products: [], total: 0, raw_keys: Object.keys(nextData?.props?.pageProps || {}) };

  const out = products
    .map(p => {
      const now  = p.currentPrice ?? p.salePrice ?? p.price ?? p.pricing?.salePrice ?? p.pricing?.currentPrice;
      const was  = p.regularPrice ?? p.wasPrice   ?? p.pricing?.regularPrice ?? p.pricing?.wasPrice;
      const pct  = (was && now && was > now) ? Math.round((was - now) / was * 100) : (p.discount ?? p.pctDiscount ?? 0);
      return {
        id:           p.itemId ?? p.omniItemId ?? p.sku ?? p.productId,
        name:         p.description ?? p.title ?? p.name,
        image:        p.imageUrl ?? p.image ?? p.thumbnail ?? p.images?.[0],
        now_price:    now,
        was_price:    was,
        discount_pct: pct,
        model:        p.modelNumber ?? p.model ?? p.modelId,
        category:     Array.isArray(p.categoryHierarchy) ? p.categoryHierarchy.join(' > ') : (p.category ?? null),
        url:          p.pdUrl ? `https://www.lowes.com${p.pdUrl}` : (p.url ?? null),
        store_avail:  p.storePickupAvailability ?? p.availability?.storePickup ?? null,
      };
    })
    .filter(p => p.name && p.discount_pct >= minDiscount)
    .sort((a, b) => b.discount_pct - a.discount_pct);

  return { products: out, total: products.length };
}

// Store search by ZIP
app.get('/api/lowes/stores', async (req, res) => {
  const { zip } = req.query;
  if (!zip) return res.status(400).json({ error: 'zip required' });

  const endpoints = [
    `https://www.lowes.com/store/api/search?q=${encodeURIComponent(zip)}&count=10`,
    `https://www.lowes.com/store/v1/stores?q=${encodeURIComponent(zip)}&maxStores=10`,
  ];

  for (const url of endpoints) {
    try {
      const r = await lowesGet(url, LOWES_API_HEADERS);
      const data = await r.json();
      const raw = data.stores ?? data.results ?? data.data?.stores ?? [];
      if (!raw.length) continue;
      const stores = raw.map(s => ({
        id:       String(s.storeId ?? s.id ?? s.store_id ?? ''),
        name:     s.storeName ?? s.name ?? s.description ?? '',
        address:  s.address?.address1 ?? s.streetAddress ?? '',
        city:     s.address?.city ?? s.city ?? '',
        state:    s.address?.state ?? s.state ?? '',
        zip:      s.address?.zipCode ?? s.postalCode ?? '',
        distance: s.distance ?? null,
        phone:    s.phone ?? s.phoneNumber ?? null,
      })).filter(s => s.id);
      return res.json({ stores });
    } catch (err) {
      if (err.message === 'BLOCKED') return res.status(502).json({ error: 'BLOCKED', message: 'Lowe\'s is blocking requests. Try again later or from a different network.' });
    }
  }

  res.status(502).json({ error: 'STORE_SEARCH_FAILED', message: 'Could not reach Lowe\'s store search. Try entering your store ID manually.' });
});

// Clearance scan
app.get('/api/lowes/clearance', async (req, res) => {
  const { storeId, minDiscount = 30, page = 1, category = '' } = req.query;
  if (!storeId) return res.status(400).json({ error: 'storeId required' });

  const offset = (parseInt(page) - 1) * 48;
  const catPath = category ? `clearance-${category}` : 'clearance-items';
  const url = `https://www.lowes.com/l/sale/${catPath}?storeId=${encodeURIComponent(storeId)}&Nrpp=48&Nao=${offset}&sortMethod=ageSort`;

  try {
    const r = await lowesGet(url, { ...LOWES_HEADERS, 'Cookie': `sn=${storeId}; akamai_generated_bot_manager_page=1` });
    const html = await r.text();

    let nextData;
    try {
      nextData = extractNextData(html);
    } catch {
      // If no __NEXT_DATA__, page may be blocked or CAPTCHA
      const blocked = html.includes('captcha') || html.includes('Access Denied') || html.includes('robot');
      return res.status(502).json({
        error: blocked ? 'BLOCKED' : 'NO_NEXT_DATA',
        message: blocked
          ? 'Lowe\'s served a CAPTCHA or bot check. Try opening lowes.com in your browser first, then retry.'
          : 'Could not parse Lowe\'s page structure. The site layout may have changed.',
        url,
      });
    }

    const result = parseProducts(nextData, parseFloat(minDiscount));
    res.json({ ...result, page: parseInt(page), store_id: storeId });
  } catch (err) {
    if (err.message === 'BLOCKED') {
      return res.status(502).json({ error: 'BLOCKED', message: 'Lowe\'s blocked the request. Residential IP usually works — try from Umbrel directly.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Get saved Lowe's store settings
app.get('/api/lowes/settings', (req, res) => {
  res.json({
    storeId:   getSetting('LOWES_STORE_ID')   || '',
    storeName: getSetting('LOWES_STORE_NAME') || '',
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Resell Tracker v1.2.1 running on port ${PORT}`);
});
