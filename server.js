require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const VERSION = '1.3.1';
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

  // v5 — saved scanner filters with optional schedule and Telegram alerts
  `CREATE TABLE IF NOT EXISTS scanner_filters (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    store_id       TEXT NOT NULL,
    store_name     TEXT DEFAULT '',
    min_discount   INTEGER DEFAULT 40,
    category       TEXT DEFAULT '',
    interval_hours INTEGER DEFAULT 0,
    notify_telegram INTEGER DEFAULT 1,
    last_run       TEXT,
    last_count     INTEGER DEFAULT 0,
    enabled        INTEGER DEFAULT 1,
    created_at     TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  // v6 — shelf location for physical storage
  `ALTER TABLE items ADD COLUMN shelf TEXT`,

  // v7 — business expenses (supplies, fees, subscriptions); deducted from net profit
  `CREATE TABLE IF NOT EXISTS expenses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT,
    description TEXT NOT NULL,
    category    TEXT DEFAULT '',
    amount      REAL NOT NULL DEFAULT 0,
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
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

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value);
}

app.use(express.json({ limit: '12mb' })); // __NEXT_DATA__ blobs from bookmarklet import can be large
app.use(express.static(path.join(__dirname, 'public')));

// ── Settings ──────────────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  const masked = ['EBAY_APP_ID', 'UPC_API_KEY', 'TELEGRAM_BOT_TOKEN'];
  const result = {};
  for (const key of masked) {
    const val = getSetting(key);
    result[key] = val
      ? { configured: true, preview: val.slice(-4).padStart(val.length, '•') }
      : { configured: false, preview: '' };
  }
  result.TELEGRAM_CHAT_ID = getSetting('TELEGRAM_CHAT_ID');
  result.VERSION = VERSION;
  res.json(result);
});

app.post('/api/settings', (req, res) => {
  const allowed = ['EBAY_APP_ID', 'UPC_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
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
    barcode, name, description, image_url, category, shelf,
    buy_price, buy_date, sell_price, sell_date,
    shipping_cost, selling_platform, platform_fee_pct,
    ebay_avg_price, ebay_low_price, ebay_high_price,
    status, notes, quantity
  } = req.body;

  if (!name) return res.status(400).json({ error: 'Name is required' });

  const result = db.prepare(`
    INSERT INTO items (
      barcode, name, description, image_url, category, shelf,
      buy_price, buy_date, sell_price, sell_date,
      shipping_cost, selling_platform, platform_fee_pct,
      ebay_avg_price, ebay_low_price, ebay_high_price,
      status, notes, quantity
    ) VALUES (
      @barcode, @name, @description, @image_url, @category, @shelf,
      @buy_price, @buy_date, @sell_price, @sell_date,
      @shipping_cost, @selling_platform, @platform_fee_pct,
      @ebay_avg_price, @ebay_low_price, @ebay_high_price,
      @status, @notes, @quantity
    )
  `).run({
    barcode: barcode || null, name,
    description: description || null, image_url: image_url || null,
    category: category || null, shelf: shelf || null,
    buy_price: buy_price || null,
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
    barcode, name, description, image_url, category, shelf,
    buy_price, buy_date, sell_price, sell_date,
    shipping_cost, selling_platform, platform_fee_pct,
    ebay_avg_price, ebay_low_price, ebay_high_price,
    status, notes, quantity
  } = req.body;

  db.prepare(`
    UPDATE items SET
      barcode = @barcode, name = @name, description = @description,
      image_url = @image_url, category = @category, shelf = @shelf,
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
    image_url: image_url || null, category: category || null, shelf: shelf || null,
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
  const totalExpenses = db.prepare('SELECT COALESCE(SUM(amount),0) as s FROM expenses').get().s;

  res.json({
    total, inventory, sold, inventoryValue, totalInvested, totalRevenue,
    netProfit: totalRevenue - costOfSold - totalShipping - totalFees - totalExpenses,
    totalShipping, totalFees, totalExpenses
  });
});

// ── Expenses ───────────────────────────────────────────────────────────────────

app.get('/api/expenses', (req, res) => {
  const rows = db.prepare('SELECT * FROM expenses ORDER BY date DESC, id DESC').all();
  const total = rows.reduce((s, r) => s + (r.amount || 0), 0);
  res.json({ expenses: rows, total });
});

app.post('/api/expenses', (req, res) => {
  const { date, description, category, amount } = req.body;
  const amt = Number(amount);
  if (!description || !String(description).trim()) return res.status(400).json({ error: 'description required' });
  if (amount == null || isNaN(amt)) return res.status(400).json({ error: 'valid amount required' });
  const r = db.prepare('INSERT INTO expenses (date, description, category, amount) VALUES (?, ?, ?, ?)')
    .run(date || new Date().toISOString().slice(0, 10), String(description).trim(), (category || '').trim(), amt);
  res.status(201).json({ id: r.lastInsertRowid });
});

app.delete('/api/expenses/:id', (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
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

// ── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  const token  = getSetting('TELEGRAM_BOT_TOKEN');
  const chatId = getSetting('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return { ok: false, error: 'not configured' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

app.post('/api/telegram/test', async (req, res) => {
  const result = await sendTelegram('✅ <b>Resell Tracker</b> — Telegram is connected! You\'ll get alerts here when scheduled scans find deals.');
  if (result.ok) res.json({ ok: true });
  else res.status(400).json({ ok: false, error: result.description || result.error || 'Failed' });
});

// Filter a pre-extracted product array from the "Grab Lowe's Deals" bookmarklet.
// Lowe's renders the deals grid in web components, so the bookmarklet builds the
// product list from JSON-LD (name/sku/price/image/url — always present) and
// best-effort harvests the discount from the DOM by SKU. Discount is therefore
// often unknown; items with unknown discount are always kept (best-effort filter).
function filterGrabbedProducts(rawProducts, maxPrice) {
  const products = (rawProducts || [])
    .map(p => {
      const now = p.now_price != null ? Number(p.now_price) : null;
      const was = p.was_price != null ? Number(p.was_price) : null;
      let pct = p.discount_pct != null ? Number(p.discount_pct) : null;
      if (pct == null && was && now && was > now) pct = Math.round((was - now) / was * 100);
      return {
        id:           p.sku || null,
        name:         p.name || '',
        image:        p.image || null,
        now_price:    now,
        was_price:    was,
        discount_pct: pct,
        model:        null,
        category:     p.brand || null,
        url:          p.url || null,
        store_avail:  null,
      };
    })
    .filter(p => p.name)
    // optional max-price ceiling (items with unknown price are always kept)
    .filter(p => maxPrice == null || p.now_price == null || p.now_price <= maxPrice)
    .sort((a, b) => {
      const da = a.discount_pct == null ? -1 : a.discount_pct;
      const db = b.discount_pct == null ? -1 : b.discount_pct;
      if (db !== da) return db - da;             // known discounts first, deepest first
      return (a.now_price ?? Infinity) - (b.now_price ?? Infinity); // then cheapest first
    });
  return { products, total: (rawProducts || []).length };
}

// Bookmarklet import — parse the deal data the "Grab Lowe's Deals" bookmarklet
// copied from the user's real (human, Akamai-passed) browser session.
app.post('/api/lowes/import', (req, res) => {
  const { nextData, minDiscount = 30, maxPrice = null } = req.body;
  if (!nextData) return res.status(400).json({ error: 'NO_DATA', message: 'No data pasted. Use the "Grab Lowe\'s Deals" bookmarklet on a Lowe\'s deals page, then paste here.' });
  let obj;
  try {
    obj = typeof nextData === 'string' ? JSON.parse(nextData) : nextData;
  } catch {
    return res.status(400).json({ error: 'BAD_JSON', message: 'That doesn\'t look like valid deal data. Re-grab with the "Grab Lowe\'s Deals" bookmarklet on a Lowe\'s deals page, then paste.' });
  }
  try {
    const maxP = (maxPrice != null && maxPrice !== '' && !isNaN(maxPrice)) ? Number(maxPrice) : null;
    // Grabber bookmarklet format: { source:'<retailer>-domgrab', retailer, products:[...] }
    const isGrab = obj && typeof obj.source === 'string' && obj.source.endsWith('-domgrab') && Array.isArray(obj.products);
    if (!isGrab) {
      return res.status(400).json({ error: 'BAD_FORMAT', message: 'Use the current "Grab Deals" bookmarklet on a deals page — it produces the expected format.' });
    }
    const retailer = obj.retailer || obj.source.replace(/-domgrab$/, '');
    const result = filterGrabbedProducts(obj.products, maxP);
    if (!result.products?.length && !result.total) {
      return res.json({ ...result, retailer, imported: true, message: 'No deals found in the pasted data. Make sure the page finished loading (scroll down once) before clicking the bookmarklet.' });
    }
    res.json({ ...result, retailer, imported: true });
  } catch (err) {
    res.status(500).json({ error: err.message, message: 'Could not read deals from the pasted data.' });
  }
});


app.listen(PORT, '0.0.0.0', () => {
  console.log(`Resell Tracker v${VERSION} running on port ${PORT}`);
});
