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

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barcode TEXT,
    name TEXT NOT NULL,
    description TEXT,
    image_url TEXT,
    category TEXT,
    buy_price REAL,
    buy_date TEXT,
    sell_price REAL,
    sell_date TEXT,
    shipping_cost REAL DEFAULT 0,
    selling_platform TEXT,
    platform_fee_pct REAL DEFAULT 0,
    ebay_avg_price REAL,
    ebay_low_price REAL,
    ebay_high_price REAL,
    status TEXT DEFAULT 'inventory',
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Items CRUD ──────────────────────────────────────────────────────────────

app.get('/api/items', (req, res) => {
  const { status } = req.query;
  const rows = status
    ? db.prepare('SELECT * FROM items WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM items ORDER BY created_at DESC').all();
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
    status, notes
  } = req.body;

  if (!name) return res.status(400).json({ error: 'Name is required' });

  const stmt = db.prepare(`
    INSERT INTO items (
      barcode, name, description, image_url, category,
      buy_price, buy_date, sell_price, sell_date,
      shipping_cost, selling_platform, platform_fee_pct,
      ebay_avg_price, ebay_low_price, ebay_high_price,
      status, notes
    ) VALUES (
      @barcode, @name, @description, @image_url, @category,
      @buy_price, @buy_date, @sell_price, @sell_date,
      @shipping_cost, @selling_platform, @platform_fee_pct,
      @ebay_avg_price, @ebay_low_price, @ebay_high_price,
      @status, @notes
    )
  `);

  const result = stmt.run({
    barcode: barcode || null,
    name, description: description || null, image_url: image_url || null,
    category: category || null, buy_price: buy_price || null,
    buy_date: buy_date || null, sell_price: sell_price || null,
    sell_date: sell_date || null, shipping_cost: shipping_cost || 0,
    selling_platform: selling_platform || null,
    platform_fee_pct: platform_fee_pct || 0,
    ebay_avg_price: ebay_avg_price || null, ebay_low_price: ebay_low_price || null,
    ebay_high_price: ebay_high_price || null,
    status: status || 'inventory', notes: notes || null
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
    status, notes
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
      status = @status, notes = @notes,
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
    status: status || 'inventory', notes: notes || null
  });

  res.json({ success: true });
});

app.delete('/api/items/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Dashboard stats ──────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as count FROM items').get().count;
  const inventory = db.prepare("SELECT COUNT(*) as count FROM items WHERE status = 'inventory'").get().count;
  const sold = db.prepare("SELECT COUNT(*) as count FROM items WHERE status = 'sold'").get().count;
  const totalInvested = db.prepare('SELECT COALESCE(SUM(buy_price),0) as sum FROM items').get().sum;
  const totalRevenue = db.prepare("SELECT COALESCE(SUM(sell_price),0) as sum FROM items WHERE status='sold'").get().sum;
  const totalShipping = db.prepare("SELECT COALESCE(SUM(shipping_cost),0) as sum FROM items WHERE status='sold'").get().sum;
  const totalFees = db.prepare(`
    SELECT COALESCE(SUM(sell_price * platform_fee_pct / 100), 0) as sum
    FROM items WHERE status='sold'
  `).get().sum;

  const soldItems = db.prepare("SELECT buy_price FROM items WHERE status='sold'").all();
  const costOfSoldItems = soldItems.reduce((a, i) => a + (i.buy_price || 0), 0);
  const netProfit = totalRevenue - costOfSoldItems - totalShipping - totalFees;

  res.json({ total, inventory, sold, totalInvested, totalRevenue, netProfit, totalShipping, totalFees });
});

// ── External API proxies ─────────────────────────────────────────────────────

app.get('/api/lookup/barcode', async (req, res) => {
  const { upc } = req.query;
  if (!upc) return res.status(400).json({ error: 'upc required' });

  try {
    const apiKey = process.env.UPC_API_KEY;
    const base = apiKey
      ? 'https://api.upcitemdb.com/prod/v1/lookup'
      : 'https://api.upcitemdb.com/prod/trial/lookup';
    const url = `${base}?upc=${encodeURIComponent(upc)}`;
    const headers = apiKey ? { 'user_key': apiKey } : {};

    const response = await fetch(url, { headers });
    const data = await response.json();

    if (!data.items || data.items.length === 0) {
      return res.json({ found: false });
    }

    const item = data.items[0];
    res.json({
      found: true,
      name: item.title,
      description: item.description,
      brand: item.brand,
      category: item.category,
      image_url: item.images?.[0] || null,
      images: item.images || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lookup/ebay', async (req, res) => {
  const { q } = req.query;
  const appId = process.env.EBAY_APP_ID;

  if (!appId) return res.status(400).json({ error: 'EBAY_APP_ID not configured' });
  if (!q) return res.status(400).json({ error: 'q required' });

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

    const url = `https://svcs.ebay.com/services/search/FindingService/v1?${params}`;
    const response = await fetch(url);
    const data = await response.json();

    const searchResult = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0];
    const items = searchResult?.item || [];

    if (items.length === 0) return res.json({ found: false, count: 0 });

    const prices = items
      .map(i => parseFloat(i.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] || 0))
      .filter(p => p > 0);

    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const low = Math.min(...prices);
    const high = Math.max(...prices);

    res.json({
      found: true,
      count: prices.length,
      avg: +avg.toFixed(2),
      low: +low.toFixed(2),
      high: +high.toFixed(2),
      recentSales: items.slice(0, 5).map(i => ({
        title: i.title?.[0],
        price: parseFloat(i.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] || 0),
        endTime: i.listingInfo?.[0]?.endTime?.[0],
        itemUrl: i.viewItemURL?.[0]
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Resell Tracker running on port ${PORT}`);
});
