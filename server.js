require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const VERSION = '1.2.14';
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
  const lowesCookies = getSetting('LOWES_COOKIES');
  result.LOWES_COOKIES = lowesCookies
    ? { configured: true, count: lowesCookies.split(';').filter(Boolean).length }
    : { configured: false, count: 0 };
  result.VERSION = VERSION;
  res.json(result);
});

app.post('/api/settings', (req, res) => {
  const allowed = ['EBAY_APP_ID', 'UPC_API_KEY', 'LOWES_STORE_ID', 'LOWES_STORE_NAME', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'LOWES_COOKIES'];
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

// ── Scanner Filters ───────────────────────────────────────────────────────────

app.get('/api/scanner/filters', (req, res) => {
  res.json(db.prepare('SELECT * FROM scanner_filters ORDER BY created_at DESC').all());
});

app.post('/api/scanner/filters', (req, res) => {
  const { name, store_id, store_name, min_discount, category, interval_hours, notify_telegram } = req.body;
  if (!name || !store_id) return res.status(400).json({ error: 'name and store_id required' });
  const r = db.prepare(`
    INSERT INTO scanner_filters (name, store_id, store_name, min_discount, category, interval_hours, notify_telegram)
    VALUES (@name, @store_id, @store_name, @min_discount, @category, @interval_hours, @notify_telegram)
  `).run({ name, store_id, store_name: store_name || '', min_discount: min_discount || 40, category: category || '', interval_hours: interval_hours || 0, notify_telegram: notify_telegram ?? 1 });
  res.status(201).json({ id: r.lastInsertRowid });
});

app.put('/api/scanner/filters/:id', (req, res) => {
  const { name, store_id, store_name, min_discount, category, interval_hours, notify_telegram, enabled } = req.body;
  db.prepare(`
    UPDATE scanner_filters SET
      name=@name, store_id=@store_id, store_name=@store_name,
      min_discount=@min_discount, category=@category,
      interval_hours=@interval_hours, notify_telegram=@notify_telegram, enabled=@enabled
    WHERE id=@id
  `).run({ id: req.params.id, name, store_id, store_name: store_name || '', min_discount: min_discount || 40, category: category || '', interval_hours: interval_hours || 0, notify_telegram: notify_telegram ?? 1, enabled: enabled ?? 1 });
  res.json({ ok: true });
});

app.delete('/api/scanner/filters/:id', (req, res) => {
  db.prepare('DELETE FROM scanner_filters WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/scanner/filters/:id/run', async (req, res) => {
  const filter = db.prepare('SELECT * FROM scanner_filters WHERE id=?').get(req.params.id);
  if (!filter) return res.status(404).json({ error: 'Not found' });
  const result = await runFilterScan(filter, true);
  res.json(result);
});

// ── Lowe's Scraper (Puppeteer) ────────────────────────────────────────────────

const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

const LOWES_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CHROMIUM = process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser';

let _browser        = null;
let _lowesWarmedUp  = false;

async function getBrowser() {
  if (_browser) {
    try { await _browser.pages(); return _browser; } catch { _browser = null; _lowesWarmedUp = false; }
  }
  _browser = await puppeteerExtra.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,800',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });
  return _browser;
}

// Visit Lowe's homepage first so Akamai sets trust cookies before hitting product pages
async function warmUpLowes(browser, log = noop) {
  if (_lowesWarmedUp) return;
  log('Warming up session on lowes.com (Akamai trust cookies)…');
  const page = await browser.newPage();
  try {
    await page.setUserAgent(LOWES_UA);
    await page.goto('https://www.lowes.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Brief pause so Akamai fingerprinting scripts can run
    await new Promise(r => setTimeout(r, 3000));
    _lowesWarmedUp = true;
    log('Session ready — Akamai cookies set', 'success');
  } catch (e) {
    log(`Warm-up warning: ${e.message}`, 'warn');
  } finally {
    await page.close().catch(() => {});
  }
}

process.on('exit', () => { if (_browser) _browser.close().catch(() => {}); });

const noop = () => {};

function parseCookieString(str) {
  return str.split(';')
    .map(c => c.trim()).filter(Boolean)
    .map(c => {
      const idx = c.indexOf('=');
      if (idx < 0) return null;
      return { name: c.slice(0, idx).trim(), value: c.slice(idx + 1).trim(), domain: '.lowes.com', path: '/' };
    })
    .filter(Boolean);
}

async function scrapeLowesPage(url, storeId = '', log = noop) {
  const browser = await getBrowser();
  const savedCookies = getSetting('LOWES_COOKIES');

  // Only warm up when no real session cookies are available
  if (!savedCookies) {
    await warmUpLowes(browser, log);
  }

  const page = await browser.newPage();
  try {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await page.setUserAgent(LOWES_UA);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
    });

    // Inject real browser cookies if available (bypasses Akamai _abck validation)
    if (savedCookies) {
      const cookies = parseCookieString(savedCookies);
      if (cookies.length) {
        await page.setCookie(...cookies);
        log(`Injecting ${cookies.length} saved session cookies…`);
      }
    }

    if (storeId) {
      await page.setCookie({ name: 'sn', value: String(storeId), domain: '.lowes.com', path: '/' });
    }

    log(`Opening URL: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log('Page loaded — waiting for product data…');

    const found = await page.waitForFunction(
      () => !!document.getElementById('__NEXT_DATA__'),
      { timeout: 15000 }
    ).then(() => true).catch(() => false);

    const html    = await page.content();
    const byteLen = html.length;

    // Detect immediate Akamai block (tiny page, no __NEXT_DATA__)
    if (!found && byteLen < 2000) {
      const snippet = html.replace(/\s+/g, ' ').slice(0, 400);
      log(`Blocked — ${byteLen} bytes. Preview: ${snippet}`, 'warn');
      // Force re-warm on next attempt
      _lowesWarmedUp = false;
      throw new Error('AKAMAI_BLOCK');
    }

    log(`Page loaded — ${byteLen.toLocaleString()} bytes${found ? ', data found ✓' : ', no data'}`, found ? 'info' : 'warn');
    if (!found) log(`Preview: ${html.replace(/\s+/g, ' ').slice(0, 400)}`, 'detail');
    return html;
  } finally {
    await page.close().catch(() => {});
  }
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

function parseProducts(nextData, minDiscount, log = noop) {
  const products = dig(nextData,
    'props.pageProps.data.productResults.products',
    'props.pageProps.productResults.products',
    'props.pageProps.data.products',
    'props.pageProps.initialData.products',
    'props.pageProps.products'
  );
  if (!Array.isArray(products)) {
    const keys = Object.keys(nextData?.props?.pageProps || {});
    log(`No products array in page data. pageProps keys: [${keys.join(', ')}]`, 'warn');
    return { products: [], total: 0, raw_keys: keys };
  }

  log(`Parsing ${products.length} raw products from page…`);
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

  log(`${out.length} of ${products.length} items match ${minDiscount}%+ discount`, out.length > 0 ? 'success' : 'warn');
  return { products: out, total: products.length };
}

// Store search — use Puppeteer to bypass bot detection
app.get('/api/lowes/stores', async (req, res) => {
  const { zip } = req.query;
  if (!zip) return res.status(400).json({ error: 'zip required' });
  try {
    const html = await scrapeLowesPage(`https://www.lowes.com/store/search?searchString=${encodeURIComponent(zip)}`);
    const nextData = extractNextData(html);
    const raw = dig(nextData,
      'props.pageProps.stores',
      'props.pageProps.data.stores',
      'props.pageProps.initialData.stores'
    ) || [];
    if (!Array.isArray(raw) || !raw.length) {
      return res.status(502).json({ error: 'STORE_SEARCH_FAILED', message: 'No stores found. Enter your store number manually (find it on lowes.com → Store Details URL).' });
    }
    const stores = raw.map(s => ({
      id:       String(s.storeId ?? s.id ?? ''),
      name:     s.storeName ?? s.name ?? '',
      address:  s.address?.address1 ?? s.streetAddress ?? '',
      city:     s.address?.city ?? s.city ?? '',
      state:    s.address?.state ?? s.state ?? '',
      zip:      s.address?.zipCode ?? s.postalCode ?? '',
      distance: s.distance ?? null,
    })).filter(s => s.id);
    res.json({ stores });
  } catch (err) {
    res.status(500).json({ error: err.message, message: 'Store search failed. Enter your store number manually.' });
  }
});

// Core deals scan — log callback receives (msg, level) in real time
async function runLowesCleared(storeId, minDiscount, category, page, log = noop) {
  const offset = (page - 1) * 48;
  // Lowe's renamed "Clearance" to "Deals" — updated URL from live site
  const base = `https://www.lowes.com/pl/Deals/1611079983848?catalog=4294936478&storeId=${encodeURIComponent(storeId)}&Nrpp=48&Nao=${offset}`;
  const urls = [
    base,
    `https://www.lowes.com/pl/Deals/1611079983848?catalog=4294936478&storeId=${encodeURIComponent(storeId)}&Nrpp=48&Nao=${offset}&sortMethod=ageSort`,
  ];

  log(`Starting scan — store #${storeId}, min discount ${minDiscount}%, page ${page}`);
  log(`Will try ${urls.length} URL patterns`);

  let lastErr = null;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    log(`[${i + 1}/${urls.length}] Trying: ${url.replace(/\?.*/, '')}…`);
    try {
      const html     = await scrapeLowesPage(url, storeId, log);
      log('Extracting product data from page…');
      const nextData = extractNextData(html);
      const result   = parseProducts(nextData, minDiscount, log);
      return result;
    } catch (err) {
      const detail = err.message === 'AKAMAI_BLOCK'
        ? 'Akamai bot check blocked the request — re-warming session for next attempt'
        : err.message === 'NO_NEXT_DATA'
        ? 'Page loaded but no product data found (site layout may have changed)'
        : err.message;
      log(`URL ${i + 1} failed: ${detail}`, 'warn');
      lastErr = err;
      if (i < urls.length - 1) log('Trying next URL pattern…');
    }
  }

  log(`All ${urls.length} URL patterns failed`, 'error');
  throw lastErr;
}

// Streaming SSE endpoint — used by the UI for live console output
app.get('/api/lowes/clearance-stream', async (req, res) => {
  const { storeId, minDiscount = 30, page = 1, category = '' } = req.query;
  if (!storeId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'storeId required' }));
  }

  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };
  const log = (msg, level = 'info') => {
    send('log', { msg, level, ts: new Date().toLocaleTimeString() });
    console.log(`[scan] ${msg}`);
  };

  try {
    log('Launching headless browser…');
    const result = await runLowesCleared(storeId, parseFloat(minDiscount), category, parseInt(page), log);
    send('result', { ...result, page: parseInt(page), store_id: storeId });
  } catch (err) {
    const detail = err.message === 'AKAMAI_BLOCK'
      ? 'Lowe\'s (Akamai) blocked the headless browser. Session will re-warm automatically — try scanning again in a few seconds.'
      : err.message === 'NO_NEXT_DATA'
      ? 'Page loaded but no product data found. The Lowe\'s page structure may have changed.'
      : err.message;
    log(`Scan failed: ${detail}`, 'error');
    send('error', { message: detail, raw: err.message });
  } finally {
    res.end();
  }
});

// Non-streaming endpoint — kept for the scheduler (no SSE needed)
app.get('/api/lowes/clearance', async (req, res) => {
  const { storeId, minDiscount = 30, page = 1, category = '' } = req.query;
  if (!storeId) return res.status(400).json({ error: 'storeId required' });
  try {
    const result = await runLowesCleared(storeId, parseFloat(minDiscount), category, parseInt(page));
    res.json({ ...result, page: parseInt(page), store_id: storeId });
  } catch (err) {
    const isNoData = err.message === 'NO_NEXT_DATA';
    res.status(500).json({
      error: err.message,
      message: isNoData
        ? 'Lowe\'s page loaded but no product data found. Check server logs.'
        : err.message,
    });
  }
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
    // New format from the grabber bookmarklet: { source:'lowes-domgrab', products:[...] }
    const result = (obj && obj.source === 'lowes-domgrab' && Array.isArray(obj.products))
      ? filterGrabbedProducts(obj.products, maxP)
      : parseProducts(obj, parseFloat(minDiscount)); // legacy __NEXT_DATA__ fallback
    if (!result.products?.length && !result.total) {
      return res.json({ ...result, imported: true, message: 'No deals found in the pasted data. Make sure the Lowe\'s deals page finished loading (scroll down once) before clicking the bookmarklet.' });
    }
    res.json({ ...result, imported: true });
  } catch (err) {
    res.status(500).json({ error: err.message, message: 'Could not read deals from the pasted data.' });
  }
});

// Get saved Lowe's store settings
app.get('/api/lowes/settings', (req, res) => {
  res.json({
    storeId:   getSetting('LOWES_STORE_ID')   || '',
    storeName: getSetting('LOWES_STORE_NAME') || '',
  });
});

// ── Filter Runner + Scheduler ─────────────────────────────────────────────────

async function runFilterScan(filter, sendAlert = false) {
  try {
    const result = await runLowesCleared(filter.store_id, filter.min_discount, filter.category || '', 1);
    const count  = result.products?.length || 0;

    db.prepare(`UPDATE scanner_filters SET last_run=CURRENT_TIMESTAMP, last_count=? WHERE id=?`)
      .run(count, filter.id);

    if (sendAlert && count > 0 && filter.notify_telegram) {
      const top = (result.products || []).slice(0, 5)
        .map(p => `• ${p.name} — <b>${p.discount_pct}% OFF</b> → ${p.now_price ? '$' + p.now_price.toFixed(2) : '?'} (was ${p.was_price ? '$' + p.was_price.toFixed(2) : '?'})`)
        .join('\n');
      const msg = `🏪 <b>Lowe's Clearance Alert</b>\nFilter: ${filter.name}\nStore: ${filter.store_name || filter.store_id}\nFound <b>${count}</b> items at ${filter.min_discount}%+ off\n\n${top}\n\nOpen Resell Tracker to add items to your inventory.`;
      await sendTelegram(msg);
    }

    return { ok: true, count, products: result.products };
  } catch (err) {
    console.error(`Filter scan failed [${filter.name}]:`, err.message);
    return { ok: false, error: err.message };
  }
}

async function runScheduledScans() {
  const now     = Date.now();
  const filters = db.prepare("SELECT * FROM scanner_filters WHERE enabled=1 AND interval_hours > 0").all();
  for (const f of filters) {
    const lastRun    = f.last_run ? new Date(f.last_run).getTime() : 0;
    const hoursSince = (now - lastRun) / 3600000;
    if (hoursSince >= f.interval_hours) {
      console.log(`Running scheduled scan: ${f.name}`);
      await runFilterScan(f, true);
    }
  }
}

// Start scheduler — first check 2 minutes after boot, then every 15 minutes
setTimeout(() => {
  runScheduledScans();
  setInterval(runScheduledScans, 15 * 60 * 1000);
}, 2 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Resell Tracker v${VERSION} running on port ${PORT}`);
});
