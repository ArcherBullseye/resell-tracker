let currentTab = 'all';
let deleteTargetId = null;
let modalDeleteId = null;
let allItemsCache = [];
let searchDebounce = null;
let lastSearchLookup = null;

const PLATFORM_FEES = {
  'eBay': 13.6, 'Mercari': 3, 'Facebook Marketplace': 0,
  'OfferUp': 12.9, 'Poshmark': 20, 'Depop': 3, 'Etsy': 6.5,
  'Amazon': 15, 'Craigslist': 0, 'Local Sale': 0, 'Other': 0
};

// ── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  loadItems();
  initSearch();

  // Recalculate profit preview when prices change
  ['sell-price', 'buy-price', 'shipping-cost'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateProfitPreview);
  });
  document.getElementById('item-quantity').addEventListener('input', updateProfitPreview);

  // Set today as default buy date
  document.getElementById('buy-date').value = today();
});

function today() {
  return new Date().toISOString().split('T')[0];
}

// ── Stats ─────────────────────────────────────────────────────────────────────

async function loadStats() {
  const stats = await api('/api/stats');
  document.getElementById('stat-total').textContent = stats.total;
  document.getElementById('stat-inventory').textContent = stats.inventory;
  document.getElementById('stat-sold').textContent = stats.sold;
  document.getElementById('stat-inv-value').textContent = fmt(stats.inventoryValue);
  document.getElementById('stat-invested').textContent = fmt(stats.totalInvested);
  document.getElementById('stat-revenue').textContent = fmt(stats.totalRevenue);
  document.getElementById('stat-expenses').textContent = fmt(stats.totalExpenses || 0);
  const profitEl = document.getElementById('stat-profit');
  profitEl.textContent = fmt(stats.netProfit);
  profitEl.className = 'stat-value ' + (stats.netProfit >= 0 ? 'profit-pos' : 'profit-neg');
}

// ── Items ─────────────────────────────────────────────────────────────────────

async function loadItems(tab) {
  if (tab) currentTab = tab;
  const status = currentTab === 'all' ? '' : currentTab;
  const items = await api('/api/items' + (status ? `?status=${status}` : ''));

  if (!status) {
    allItemsCache = items;
  } else {
    // keep cache fresh even when viewing a filtered tab
    api('/api/items').then(all => { allItemsCache = all; });
  }

  const grid = document.getElementById('items-grid');
  const empty = document.getElementById('empty-state');

  if (items.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  grid.innerHTML = items.map(renderCard).join('');

  const inventoryItems = items.filter(i => i.status !== 'sold');
  if (inventoryItems.length) fetchEbayLivePrices(inventoryItems);
}

function renderCard(item) {
  const imgHtml = item.image_url
    ? `<img class="item-card-img" src="${esc(item.image_url)}" alt="${esc(item.name)}" onerror="this.parentNode.innerHTML='<div class=item-card-img-placeholder>📦</div>'" />`
    : `<div class="item-card-img-placeholder">📦</div>`;

  const badgeClass = item.status === 'sold' ? 'badge-sold' : 'badge-inventory';
  const qty = item.quantity || 1;
  const qtySold = item.quantity_sold || 0;
  const badgeText = item.status === 'sold'
    ? (qty > 1 ? `Sold (${qty})` : 'Sold')
    : (qty > 1 ? `${qty - qtySold} of ${qty} left` : 'Inventory');

  let profitHtml = '';
  if (item.sell_price && item.buy_price) {
    const fee = item.sell_price * (item.platform_fee_pct || 0) / 100;
    const profit = item.sell_price - item.buy_price - (item.shipping_cost || 0) - fee;
    const cls = profit >= 0 ? 'profit-pos' : 'profit-neg';
    const roi = item.buy_price > 0 ? ((profit / item.buy_price) * 100).toFixed(0) : 0;
    profitHtml = `
      <div class="item-profit">
        <div>
          <div class="profit-label">Net Profit</div>
        </div>
        <div class="profit-value ${cls}">${fmt(profit)} <small style="font-size:13px;opacity:0.7">(${roi}%)</small></div>
      </div>`;
  }

  const ebayHint = item.ebay_avg_price
    ? `<div class="ebay-hint">eBay avg: <span>${fmt(item.ebay_avg_price)}</span> · Low ${fmt(item.ebay_low_price)} · High ${fmt(item.ebay_high_price)}</div>`
    : '';

  const platformHtml = item.selling_platform
    ? `<div class="platform-chip">🏪 ${esc(item.selling_platform)}</div>`
    : '';

  let daysHtml = '';
  if (item.buy_date) {
    const start = new Date(item.buy_date);
    const end   = item.sell_date ? new Date(item.sell_date) : new Date();
    const days  = Math.round((end - start) / 86400000);
    const dayCls = days < 30 ? 'days-green' : days <= 90 ? 'days-yellow' : 'days-red';
    const label  = item.status === 'sold' ? `${days}d to sell` : `${days}d in stock`;
    daysHtml = `<span class="days-badge ${dayCls}">${label}</span>`;
  }

  const ebayLiveRow = item.status !== 'sold'
    ? `<div class="ebay-live-row" id="ebay-live-${item.id}">
        <span class="ebay-live-label">eBay Lowest</span>
        <span class="ebay-live-val" id="ebay-live-val-${item.id}">—</span>
       </div>`
    : '';

  return `
    <div class="item-card">
      ${imgHtml}
      <div class="item-card-body">
        <div class="item-card-header">
          <div>
            <div class="item-name">${esc(item.name)}</div>
            ${item.category ? `<div class="item-category">${esc(item.category)}</div>` : ''}
          </div>
          <span class="badge ${badgeClass}">${badgeText}</span>
        </div>
        <div class="item-prices">
          <div class="price-line">
            <span class="pl-label">Bought</span>
            <span class="pl-value">${item.buy_price ? fmt(item.buy_price) : '—'}</span>
            ${item.buy_date ? `<span class="pl-date">${fmtDate(item.buy_date)}</span>` : ''}
          </div>
          <div class="price-line">
            <span class="pl-label">Sold</span>
            <span class="pl-value">${item.sell_price ? fmt(item.sell_price) : '—'}</span>
            ${item.sell_date ? `<span class="pl-date">${fmtDate(item.sell_date)}</span>` : ''}
          </div>
        </div>
        ${ebayHint}
        ${profitHtml}
        <div class="platform-row">
          ${platformHtml}
          ${daysHtml}
          ${item.shelf && !item.sold_price ? `<span class="shelf-badge">&#128230; ${esc(item.shelf)}</span>` : ''}
        </div>
        ${ebayLiveRow}
        <div class="item-actions">
          <button class="btn btn-secondary" onclick="openModal('edit', ${item.id})">Edit</button>
          ${item.status !== 'sold' ? `<button class="btn btn-sell" onclick="openSellModal(${item.id}, '${esc(item.name)}', ${item.buy_price || 0})">Sell</button>` : ''}
        </div>
      </div>
    </div>`;
}

// ── eBay Live Price Fetch ─────────────────────────────────────────────────────

async function fetchEbayLivePrices(items) {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const el = document.getElementById(`ebay-live-val-${item.id}`);
    if (!el) continue;
    try {
      const q = item.name;
      const data = await api(`/api/lookup/ebay/lowest?q=${encodeURIComponent(q)}`);
      if (data.found) {
        const label = data.shipping > 0
          ? `${fmt(data.price)} <span class="ebay-live-ship">+${fmt(data.shipping)} ship</span>`
          : fmt(data.price);
        el.innerHTML = label;
        el.classList.add('ebay-live-found');
      } else {
        el.textContent = 'Not listed';
        el.classList.add('ebay-live-none');
      }
    } catch {
      el.textContent = '—';
    }
    // stagger requests so we don't hammer the API
    if (i < items.length - 1) await new Promise(r => setTimeout(r, 300));
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

function switchTab(el, tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  loadItems(tab);
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function openModal(mode, id) {
  clearForm();
  document.getElementById('modal-title').textContent = mode === 'edit' ? 'Edit Item' : 'Add Item';
  document.getElementById('lookup-section').style.display = mode === 'add' ? 'block' : 'none';

  const deleteBtn = document.getElementById('delete-btn');
  if (mode === 'edit' && id) {
    modalDeleteId = id;
    deleteBtn.style.display = 'inline-flex';
    loadItemIntoForm(id);
  } else {
    modalDeleteId = null;
    deleteBtn.style.display = 'none';
    document.getElementById('buy-date').value = today();
  }

  document.getElementById('item-modal').style.display = 'flex';
}

async function loadItemIntoForm(id) {
  const item = await api(`/api/items/${id}`);
  document.getElementById('edit-item-id').value = item.id;
  document.getElementById('lookup-query').value = item.barcode || '';
  document.getElementById('item-name').value = item.name || '';
  document.getElementById('item-category').value = item.category || '';
  document.getElementById('item-shelf').value = item.shelf || '';
  document.getElementById('item-image').value = item.image_url || '';
  document.getElementById('item-notes').value = item.notes || '';
  document.getElementById('buy-price').value = item.buy_price || '';
  document.getElementById('item-quantity').value = item.quantity || 1;
  document.getElementById('buy-date').value = item.buy_date || '';
  document.getElementById('sell-price').value = item.sell_price || '';
  document.getElementById('sell-date').value = item.sell_date || '';
  document.getElementById('shipping-cost').value = item.shipping_cost || '';
  document.getElementById('fee-pct').value = item.platform_fee_pct || 0;
  document.getElementById('item-status').value = item.status || 'inventory';

  if (item.selling_platform) {
    document.getElementById('selling-platform').value = item.selling_platform;
  }

  if (item.image_url) previewImage(item.image_url);

  if (item.ebay_avg_price) {
    document.getElementById('ebay-avg-val').value = item.ebay_avg_price;
    document.getElementById('ebay-low-val').value = item.ebay_low_price;
    document.getElementById('ebay-high-val').value = item.ebay_high_price;
    showEbayData({ avg: item.ebay_avg_price, low: item.ebay_low_price, high: item.ebay_high_price, count: '(cached)', recentSales: [] });
  }

  updateProfitPreview();
}

function closeModal() {
  document.getElementById('item-modal').style.display = 'none';
  clearForm();
}

function closeOnBackdrop(e) {
  if (e.target === e.currentTarget) {
    e.currentTarget.style.display = 'none';
    clearForm();
  }
}

function clearForm() {
  ['lookup-query','item-name','item-category','item-shelf','item-image','item-notes',
   'buy-price','buy-date','buy-store','sell-price','sell-date','shipping-cost',
   'edit-item-id','ebay-avg-val','ebay-low-val','ebay-high-val'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const fp = document.getElementById('fee-pct'); if (fp) fp.value = 0;
  const ist = document.getElementById('item-status'); if (ist) ist.value = 'inventory';
  const iqt = document.getElementById('item-quantity'); if (iqt) iqt.value = 1;
  const spf = document.getElementById('selling-platform'); if (spf) spf.value = '';
  const lr = document.getElementById('lookup-result'); if (lr) { lr.innerHTML = ''; lr.style.display = 'none'; }
  document.getElementById('profit-preview').style.display = 'none';
  document.getElementById('image-preview').innerHTML = '';
}

// ── Lookup ────────────────────────────────────────────────────────────────────

async function lookupProduct() {
  const query = document.getElementById('lookup-query').value.trim();
  if (!query) return toast('Enter a barcode or search term first', 'error');
  if (/^\d{8,14}$/.test(query)) {
    await lookupBarcode();
  } else {
    await lookupEbayByQuery(query);
  }
}

function deleteItem() { modalDelete(); }

async function lookupBarcode() {
  const upc = document.getElementById('lookup-query').value.trim();
  if (!upc) return toast('Enter a barcode first', 'error');

  toast('Looking up barcode…');
  const data = await api(`/api/lookup/barcode?upc=${encodeURIComponent(upc)}`);

  if (!data.found) return toast('Product not found for that barcode', 'error');

  document.getElementById('item-name').value = data.name || '';
  document.getElementById('item-category').value = data.category || '';
  if (data.image_url) {
    document.getElementById('item-image').value = data.image_url;
    previewImage(data.image_url);
  }

  toast('Product found! Fetching eBay prices…', 'success');

  // Auto-trigger eBay lookup
  if (data.name) lookupEbayByQuery(data.name);
}

async function lookupEbayByName() {
  const name = document.getElementById('lookup-query').value.trim()
    || document.getElementById('item-name').value.trim();
  if (!name) return toast('Enter a product name first', 'error');
  lookupEbayByQuery(name);
}

async function lookupEbayByQuery(query) {
  toast('Fetching eBay sold prices…');
  const data = await api(`/api/lookup/ebay?q=${encodeURIComponent(query)}`);

  if (data.error) return toast('eBay: ' + data.error, 'error');
  if (!data.found) return toast('No eBay sold listings found', 'error');

  document.getElementById('ebay-avg-val').value = data.avg;
  document.getElementById('ebay-low-val').value = data.low;
  document.getElementById('ebay-high-val').value = data.high;
  showEbayData(data);
  toast(`Found ${data.count} sold listings on eBay`, 'success');
}

function showEbayData(data) {
  const rows = (data.recentSales || []).slice(0, 5).map(s => `
    <div class="recent-sale-row">
      <span class="sale-title" title="${esc(s.title)}">${esc(s.title)}</span>
      <span class="sale-price">${fmt(s.price)}</span>
      ${s.itemUrl ? `<a href="${esc(s.itemUrl)}" target="_blank" rel="noopener">View ↗</a>` : ''}
    </div>`).join('');

  const countLine = data.count && data.count !== '(cached)'
    ? `<div class="ebay-count">Based on ${data.count} recent sold listings</div>`
    : data.count === '(cached)' ? `<div class="ebay-count">(cached eBay data)</div>` : '';

  const lr = document.getElementById('lookup-result');
  lr.innerHTML = `
    <div class="ebay-prices">
      <div class="price-badge low">Low <span>${fmt(data.low)}</span></div>
      <div class="price-badge avg">Avg <span>${fmt(data.avg)}</span></div>
      <div class="price-badge high">High <span>${fmt(data.high)}</span></div>
    </div>
    ${countLine}
    <div class="recent-sales">${rows}</div>`;
  lr.style.display = 'block';
}

// ── Platform fee / profit preview ─────────────────────────────────────────────

function updatePlatformFee() {
  const sel = document.getElementById('selling-platform');
  const platform = sel.value;
  const fee = PLATFORM_FEES[platform] || 0;
  document.getElementById('fee-pct').value = fee;
  updateProfitPreview();
}

function updateProfitPreview() {
  const sell = parseFloat(document.getElementById('sell-price').value) || 0;
  const buy = parseFloat(document.getElementById('buy-price').value) || 0;
  const ship = parseFloat(document.getElementById('shipping-cost').value) || 0;
  const feePct = parseFloat(document.getElementById('fee-pct').value) || 0;
  const fee = sell * feePct / 100;
  const profit = sell - buy - ship - fee;

  const preview = document.getElementById('profit-preview');
  if (sell > 0 || buy > 0) {
    preview.style.display = 'flex';
    document.getElementById('calc-revenue').textContent = fmt(sell);
    document.getElementById('calc-cost').textContent = '−' + fmt(buy);
    document.getElementById('calc-shipping').textContent = '−' + fmt(ship);
    document.getElementById('calc-fee').textContent = '−' + fmt(fee);
    const profitEl = document.getElementById('calc-profit');
    profitEl.textContent = fmt(profit);
    profitEl.className = profit >= 0 ? 'profit-pos' : 'profit-neg';
  } else {
    preview.style.display = 'none';
  }
}

function previewImage(url) {
  const preview = document.getElementById('image-preview');
  if (url) {
    preview.innerHTML = `<img src="${esc(url)}" onerror="this.parentNode.innerHTML='<span>No image</span>'" />`;
  } else {
    preview.innerHTML = '<span>No image</span>';
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────

async function saveItem() {
  const name = document.getElementById('item-name').value.trim();
  if (!name) return toast('Product name is required', 'error');

  const id = document.getElementById('edit-item-id').value;
  const sellPrice = parseFloat(document.getElementById('sell-price').value) || null;
  const statusEl = document.getElementById('item-status');
  if (sellPrice && statusEl.value === 'inventory') {
    statusEl.value = 'sold';
  }

  const qty = parseInt(document.getElementById('item-quantity').value) || 1;
  const body = {
    barcode: document.getElementById('lookup-query').value.trim() || null,
    name,
    category: document.getElementById('item-category').value.trim() || null,
    shelf: document.getElementById('item-shelf').value.trim() || null,
    image_url: document.getElementById('item-image').value.trim() || null,
    notes: document.getElementById('item-notes').value.trim() || null,
    buy_price: parseFloat(document.getElementById('buy-price').value) || null,
    buy_date: document.getElementById('buy-date').value || null,
    sell_price: sellPrice,
    sell_date: document.getElementById('sell-date').value || null,
    shipping_cost: parseFloat(document.getElementById('shipping-cost').value) || 0,
    selling_platform: document.getElementById('selling-platform').value || null,
    platform_fee_pct: parseFloat(document.getElementById('fee-pct').value) || 0,
    ebay_avg_price: parseFloat(document.getElementById('ebay-avg-val').value) || null,
    ebay_low_price: parseFloat(document.getElementById('ebay-low-val').value) || null,
    ebay_high_price: parseFloat(document.getElementById('ebay-high-val').value) || null,
    status: statusEl.value,
    quantity: 1
  };

  if (id) {
    await api(`/api/items/${id}`, 'PUT', { ...body, quantity: qty });
    toast('Item updated', 'success');
  } else {
    for (let i = 0; i < qty; i++) await api('/api/items', 'POST', body);
    toast(qty > 1 ? `${qty} items added` : 'Item added', 'success');
  }

  closeModal();
  loadStats();
  loadItems();
}

// ── Quick Sell ────────────────────────────────────────────────────────────────

function openSellModal(id, name, buyPrice) {
  document.getElementById('qs-item-id').value = id;
  document.getElementById('qs-buy-price').value = buyPrice;
  document.getElementById('qs-fee-pct').value = 0;
  document.getElementById('qs-sell-price').value = '';
  document.getElementById('qs-sell-date').value = today();
  document.getElementById('qs-shipping').value = '';
  document.getElementById('qs-platform').value = '';
  document.getElementById('qs-profit-preview').style.display = 'none';
  document.getElementById('sell-modal-subtitle').textContent = name;
  document.getElementById('sell-modal').style.display = 'flex';
}

function updateQsPlatformFee() {
  const sel = document.getElementById('qs-platform');
  const opt = sel.options[sel.selectedIndex];
  document.getElementById('qs-fee-pct').value = opt.dataset.fee || 0;
  updateQsPreview();
}

function updateQsPreview() {
  const sell = parseFloat(document.getElementById('qs-sell-price').value) || 0;
  const buy  = parseFloat(document.getElementById('qs-buy-price').value) || 0;
  const ship = parseFloat(document.getElementById('qs-shipping').value) || 0;
  const feePct = parseFloat(document.getElementById('qs-fee-pct').value) || 0;
  const fee  = sell * feePct / 100;
  const profit = sell - buy - ship - fee;

  const preview = document.getElementById('qs-profit-preview');
  if (sell > 0 || buy > 0) {
    preview.style.display = 'flex';
    document.getElementById('qs-calc-revenue').textContent = fmt(sell);
    document.getElementById('qs-calc-cost').textContent = '−' + fmt(buy);
    document.getElementById('qs-calc-shipping').textContent = '−' + fmt(ship);
    document.getElementById('qs-calc-fee').textContent = '−' + fmt(fee);
    const profitEl = document.getElementById('qs-calc-profit');
    profitEl.textContent = fmt(profit);
    profitEl.className = profit >= 0 ? 'profit-pos' : 'profit-neg';
  } else {
    preview.style.display = 'none';
  }
}

async function confirmQuickSell() {
  const id = document.getElementById('qs-item-id').value;
  if (!id) return;

  const body = {
    sell_price:       parseFloat(document.getElementById('qs-sell-price').value) || null,
    sell_date:        document.getElementById('qs-sell-date').value || null,
    selling_platform: document.getElementById('qs-platform').value || null,
    platform_fee_pct: parseFloat(document.getElementById('qs-fee-pct').value) || 0,
    shipping_cost:    parseFloat(document.getElementById('qs-shipping').value) || 0
  };

  const result = await api(`/api/items/${id}/sell`, 'POST', body);
  document.getElementById('sell-modal').style.display = 'none';
  toast(result.fully_sold ? 'Item fully sold!' : 'Sale recorded — units remaining', 'success');
  loadStats();
  loadItems();
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function modalDelete() {
  if (!modalDeleteId) return;
  const item = await api(`/api/items/${modalDeleteId}`);
  deleteTargetId = modalDeleteId;
  document.getElementById('delete-item-name').textContent = item.name;
  closeModal();
  document.getElementById('delete-modal').style.display = 'flex';
}

async function confirmDelete() {
  if (!deleteTargetId) return;
  await api(`/api/items/${deleteTargetId}`, 'DELETE');
  document.getElementById('delete-modal').style.display = 'none';
  deleteTargetId = null;
  toast('Item deleted', 'success');
  loadStats();
  loadItems();
}

// ── Deals Scanner ─────────────────────────────────────────────────────────────

async function openScanner() {
  document.getElementById('scanner-panel').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  startBrowserImportPolling();
}

function closeScanner() {
  document.getElementById('scanner-panel').style.display = 'none';
  document.body.style.overflow = '';
  if (_scanPollInterval) { clearInterval(_scanPollInterval); _scanPollInterval = null; }
  stopBrowserImportPolling();
}

function scannerCloseOnBackdrop(e) {
  if (e.target === document.getElementById('scanner-panel')) closeScanner();
}

let _currentRetailer = 'lowes';
let _scanPollInterval = null;
let _importedDeals = [];

// ── Browser-extension import polling ─────────────────────────────────────────

let _browserImportInterval = null;
let _browserPendingProducts = null;

async function checkBrowserImport() {
  try {
    const data = await api('/api/scan/pending');
    if (data && Array.isArray(data.products) && data.products.length > 0) {
      _browserPendingProducts = data.products;
      const countEl = document.getElementById('browser-import-count');
      if (countEl) countEl.textContent = `${data.products.length} product${data.products.length === 1 ? '' : 's'}`;
      document.getElementById('browser-import-waiting').style.display = 'none';
      document.getElementById('browser-import-ready').style.display = 'block';
    }
  } catch { /* network glitch */ }
}

function loadBrowserImport() {
  if (!_browserPendingProducts || _browserPendingProducts.length === 0) return;
  _importedDeals = _browserPendingProducts;
  _browserPendingProducts = null;
  document.getElementById('browser-import-ready').style.display = 'none';
  document.getElementById('browser-import-waiting').style.display = 'block';
  const statusEl = document.getElementById('scanner-status');
  const emptyEl  = document.getElementById('scanner-empty-state');
  if (emptyEl) emptyEl.style.display = 'none';
  const count = _importedDeals.length;
  statusEl.innerHTML = `<div class="scanner-count"><strong>${count}</strong> product${count === 1 ? '' : 's'} from browser. <button class="btn btn-primary btn-xs" id="ebay-compare-btn" onclick="compareAllToEbay()">&#128176; Compare all to eBay</button></div>`;
  renderDealGrid();
}

function dismissBrowserImport() {
  _browserPendingProducts = null;
  document.getElementById('browser-import-ready').style.display = 'none';
  document.getElementById('browser-import-waiting').style.display = 'block';
}

function startBrowserImportPolling() {
  document.getElementById('browser-import-waiting').style.display = 'block';
  document.getElementById('browser-import-ready').style.display = 'none';
  checkBrowserImport();
  _browserImportInterval = setInterval(checkBrowserImport, 8000);
  document.addEventListener('visibilitychange', onVisibilityChange);
}

function stopBrowserImportPolling() {
  if (_browserImportInterval) { clearInterval(_browserImportInterval); _browserImportInterval = null; }
  document.removeEventListener('visibilitychange', onVisibilityChange);
  document.getElementById('browser-import-waiting').style.display = 'none';
  document.getElementById('browser-import-ready').style.display = 'none';
}

function onVisibilityChange() {
  if (!document.hidden) checkBrowserImport();
}

function selectApifyRetailer(retailer) {
  _currentRetailer = retailer;
  document.querySelectorAll('#apify-retailer-tabs .rtab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.retailer === retailer);
  });
  const kwEl    = document.getElementById('apify-keyword');
  const storeEl = document.getElementById('apify-store-num-group');
  const labelEl = document.getElementById('apify-keyword-label');
  if (retailer === 'tractorsupply') {
    if (kwEl) { kwEl.value = kwEl.value || 'power tools,outdoor tools,chainsaws'; kwEl.placeholder = 'power tools, chainsaws, generators (comma-separated)'; }
    if (labelEl) labelEl.textContent = 'Search keywords (comma-separated)';
    if (storeEl) storeEl.style.display = 'block';
  } else {
    if (kwEl) { kwEl.value = kwEl.value || 'clearance'; kwEl.placeholder = 'clearance, clearance tools, outdoor clearance…'; }
    if (labelEl) labelEl.textContent = 'Search keyword';
    if (storeEl) storeEl.style.display = 'none';
  }
}

async function runApifyScan() {
  const keyword     = (document.getElementById('apify-keyword').value || '').trim() || 'clearance';
  const maxPriceRaw = document.getElementById('apify-max-price').value.trim();
  const storeNumRaw = (document.getElementById('apify-store-number')?.value || '').trim();
  const opts        = storeNumRaw ? { storeNumber: storeNumRaw } : {};
  const maxPrice   = maxPriceRaw ? parseFloat(maxPriceRaw) : null;
  const statusEl   = document.getElementById('scanner-status');
  const gridEl     = document.getElementById('scanner-grid');
  const emptyEl    = document.getElementById('scanner-empty-state');
  const runBtn     = document.getElementById('apify-run-btn');

  gridEl.innerHTML = '';
  statusEl.innerHTML = '';
  if (emptyEl) emptyEl.style.display = 'none';
  if (_scanPollInterval) { clearInterval(_scanPollInterval); _scanPollInterval = null; }
  runBtn.disabled = true;
  statusEl.innerHTML = '<div class="scanner-count">Starting Apify scan…</div>';

  try {
    const data = await api('/api/scan/run', 'POST', { retailer: _currentRetailer, keyword, opts });
    if (data.error) {
      runBtn.disabled = false;
      statusEl.innerHTML = `<div class="scanner-error"><strong>&#9888; Error</strong><br>${esc(data.error)}</div>`;
      return;
    }

    const runId     = data.runId;
    const startTime = Date.now();
    statusEl.innerHTML = `<div class="scanner-count">Scan running… (typically 1–3 min) <span id="scan-elapsed">0s</span></div>`;

    _scanPollInterval = setInterval(async () => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const el = document.getElementById('scan-elapsed');
      if (el) el.textContent = `${elapsed}s`;
      try {
        const status = await api(`/api/scan/status/${runId}?retailer=${_currentRetailer}`);
        if (status.status === 'SUCCEEDED') {
          clearInterval(_scanPollInterval); _scanPollInterval = null;
          runBtn.disabled = false;
          let products = status.products || [];
          if (maxPrice != null) products = products.filter(p => p.now_price == null || p.now_price <= maxPrice);
          products.sort((a, b) => (b.discount_pct ?? -1) - (a.discount_pct ?? -1));
          _importedDeals = products;
          const priceNote = maxPrice ? ` under $${maxPrice}` : '';
          statusEl.innerHTML = `<div class="scanner-count">Found <strong>${products.length}</strong> results${priceNote} (${status.total} total scraped). <button class="btn btn-primary btn-xs" id="ebay-compare-btn" onclick="compareAllToEbay()">&#128176; Compare all to eBay</button></div>`;
          renderDealGrid();
        } else if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status.status)) {
          clearInterval(_scanPollInterval); _scanPollInterval = null;
          runBtn.disabled = false;
          statusEl.innerHTML = `<div class="scanner-error"><strong>&#9888; ${status.status}</strong><br>${esc(status.error || 'Scan ended unexpectedly. Check your Apify console.')}</div>`;
        }
      } catch { /* network glitch — keep polling */ }
    }, 5000);

  } catch (err) {
    runBtn.disabled = false;
    statusEl.innerHTML = `<div class="scanner-error"><strong>&#9888; Error</strong><br>${esc(err.message || 'Scan failed')}</div>`;
  }
}

function renderDealGrid() {
  document.getElementById('scanner-grid').innerHTML = _importedDeals.map(renderScanCard).join('');
}

// Build an eBay search query from a product: brand + name, parentheticals and odd
// punctuation stripped (retailer names are noisy, e.g. "( 5.0 Ah 5.0 Ah )").
function ebayQuery(p) {
  return `${p.category ? p.category + ' ' : ''}${p.name || ''}`
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\w\s.\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

// Compare every imported deal to its eBay sold-price average, estimate profit
// (net of ~13% eBay fee), then re-sort best-first. Sequential to respect eBay rate limits.
async function compareAllToEbay() {
  if (!_importedDeals.length) return;
  const btn      = document.getElementById('ebay-compare-btn');
  const statusEl = document.getElementById('scanner-status');
  if (btn) btn.disabled = true;
  const total = _importedDeals.length;

  for (let i = 0; i < total; i++) {
    const p = _importedDeals[i];
    statusEl.innerHTML = `<div class="scanner-count">Checking eBay sold prices… ${i + 1}/${total}</div>`;
    try {
      const r = await api('/api/lookup/ebay?q=' + encodeURIComponent(ebayQuery(p)));
      if (r && r.found) {
        p.ebay = { found: true, avg: r.avg, low: r.low, high: r.high, count: r.count };
        if (p.now_price != null) p.est_profit = +(r.avg * 0.87 - p.now_price).toFixed(2);
      } else {
        p.ebay = { found: false };
      }
    } catch { p.ebay = { found: false }; }
  }

  // Best margins first; items with no eBay match sink to the bottom.
  _importedDeals.sort((a, b) => (b.est_profit ?? -1e9) - (a.est_profit ?? -1e9));
  const winners = _importedDeals.filter(p => p.est_profit != null && p.est_profit > 0).length;
  statusEl.innerHTML = `<div class="scanner-count">eBay check done — <strong>${winners}</strong> of ${total} look profitable (sorted best-first). Green = eBay sold avg beats the buy price after ~13% fee.</div>`;
  renderDealGrid();
}

function renderScanCard(item) {
  const hasDisc = item.discount_pct != null && item.discount_pct > 0;
  const discountCls = item.discount_pct >= 70 ? 'scan-badge-red' : item.discount_pct >= 50 ? 'scan-badge-orange' : 'scan-badge-yellow';
  const badge = hasDisc
    ? `<div class="scan-badge ${discountCls}">${item.discount_pct}% OFF</div>`
    : `<div class="scan-badge scan-badge-neutral">DEAL</div>`;
  const imgHtml = item.image
    ? `<img class="scan-card-img" src="${esc(item.image)}" onerror="this.style.display='none'" />`
    : '<div class="scan-card-img-ph">&#127968;</div>';
  let ebayHtml = '';
  if (item.ebay) {
    if (item.ebay.found) {
      const profit = item.now_price != null ? +(item.ebay.avg * 0.87 - item.now_price).toFixed(2) : null;
      const cls = profit == null ? '' : (profit > 0 ? 'profit-pos' : 'profit-neg');
      const profitTxt = profit == null ? '' : ` · <strong class="${cls}">${profit > 0 ? '+' : ''}${fmt(profit)} est</strong>`;
      ebayHtml = `<div class="scan-ebay">eBay sold ~${fmt(item.ebay.avg)} (${item.ebay.count})${profitTxt}</div>`;
    } else {
      ebayHtml = `<div class="scan-ebay scan-ebay-none">No eBay sales found</div>`;
    }
  }
  return `
    <div class="scan-card">
      ${imgHtml}
      <div class="scan-card-body">
        ${badge}
        <div class="scan-card-name">${esc(item.name || '—')}</div>
        ${item.model ? `<div class="scan-card-model">Model: ${esc(item.model)}</div>` : ''}
        ${item.category ? `<div class="scan-card-cat">${esc(item.category)}</div>` : ''}
        <div class="scan-card-prices">
          ${item.was_price ? `<span class="scan-was">${fmt(item.was_price)}</span>` : ''}
          <span class="scan-now">${item.now_price ? fmt(item.now_price) : '—'}</span>
        </div>
        ${ebayHtml}
        <div class="scan-card-actions">
          ${item.url ? `<a class="btn btn-ghost btn-xs" href="${esc(item.url)}" target="_blank">View &#8599;</a>` : ''}
          <button class="btn btn-primary btn-xs" onclick='addScanItem(${JSON.stringify({ name: item.name, image: item.image, category: item.category, now_price: item.now_price, model: item.model }).replace(/'/g, "&#39;")})'>+ Add to Tracker</button>
        </div>
      </div>
    </div>`;
}

function addScanItem(item) {
  closeScanner();
  openModal('add');
  if (item.name)     document.getElementById('item-name').value     = item.name;
  if (item.image)    document.getElementById('item-image').value    = item.image;
  if (item.category) document.getElementById('item-category').value = item.category;
  if (item.now_price) document.getElementById('buy-price').value    = item.now_price;
  if (item.image)    previewImage(item.image);
  updateProfitPreview();
}

// ── Expenses ──────────────────────────────────────────────────────────────────

async function openExpenses() {
  document.getElementById('expenses-modal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  document.getElementById('expense-date').value = today();
  document.getElementById('expense-desc').value = '';
  document.getElementById('expense-amount').value = '';
  document.getElementById('expense-category').value = '';
  await loadExpenses();
}

function closeExpenses() {
  document.getElementById('expenses-modal').style.display = 'none';
  document.body.style.overflow = '';
}

function expensesCloseOnBackdrop(e) {
  if (e.target === e.currentTarget) closeExpenses();
}

async function loadExpenses() {
  const data = await api('/api/expenses');
  const list = document.getElementById('expenses-list');
  const expenses = data.expenses || [];

  document.getElementById('expenses-total-badge').textContent =
    expenses.length ? `${expenses.length} logged · ${fmt(data.total)} total` : '';
  document.getElementById('expenses-grand-total').innerHTML =
    expenses.length ? `Total expenses: <strong class="profit-neg">${fmt(data.total)}</strong>` : '';

  if (!expenses.length) {
    list.innerHTML = '<div class="expenses-empty">No expenses logged yet.</div>';
    return;
  }
  list.innerHTML = expenses.map(renderExpenseRow).join('');
}

function renderExpenseRow(e) {
  return `
    <div class="expense-row">
      <div class="expense-row-main">
        <div class="expense-row-desc">${esc(e.description)}${e.category ? ` <span class="expense-row-cat">${esc(e.category)}</span>` : ''}</div>
        <div class="expense-row-date">${esc(fmtDate(e.date) || e.date || '')}</div>
      </div>
      <div class="expense-row-amount profit-neg">${fmt(e.amount)}</div>
      <button class="btn-icon-tiny" onclick="deleteExpense(${e.id})" title="Delete">&#128465;</button>
    </div>`;
}

async function addExpense() {
  const description = document.getElementById('expense-desc').value.trim();
  const amount = document.getElementById('expense-amount').value.trim();
  const date = document.getElementById('expense-date').value;
  const category = document.getElementById('expense-category').value.trim();

  if (!description) return toast('Enter a description', 'error');
  if (amount === '' || isNaN(parseFloat(amount))) return toast('Enter a valid amount', 'error');

  const r = await api('/api/expenses', 'POST', { description, amount: parseFloat(amount), date, category });
  if (r.error) return toast(r.error, 'error');

  document.getElementById('expense-desc').value = '';
  document.getElementById('expense-amount').value = '';
  document.getElementById('expense-category').value = '';
  toast('Expense added', 'success');
  await loadExpenses();
  loadStats();
}

async function deleteExpense(id) {
  if (!confirm('Delete this expense?')) return;
  await api(`/api/expenses/${id}`, 'DELETE');
  await loadExpenses();
  loadStats();
}

// ── Global Search ─────────────────────────────────────────────────────────────

function initSearch() {
  const input = document.getElementById('global-search');
  const wrap  = document.getElementById('search-wrap');

  input.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    const q = input.value.trim();
    if (!q) { closeSearch(); return; }
    searchDebounce = setTimeout(() => performSearch(q), 160);
  });

  input.addEventListener('focus', () => {
    const q = input.value.trim();
    if (q) performSearch(q);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeSearch(); input.blur(); }
  });

  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) closeSearch();
  });
}

async function performSearch(q) {
  const lower = q.toLowerCase();

  if (!allItemsCache.length) {
    allItemsCache = await api('/api/items');
  }

  const matches = allItemsCache.filter(item =>
    (item.name        && item.name.toLowerCase().includes(lower)) ||
    (item.barcode     && item.barcode.toLowerCase().includes(lower)) ||
    (item.description && item.description.toLowerCase().includes(lower)) ||
    (item.category    && item.category.toLowerCase().includes(lower)) ||
    (item.notes       && item.notes.toLowerCase().includes(lower))
  );

  const inventory = matches.filter(i => i.status !== 'sold');
  const sold      = matches.filter(i => i.status === 'sold');

  const dd = document.getElementById('search-dropdown');
  let html = `
    <div class="sr-lookup" onclick="openSearchLookup('${esc(q)}')">
      <span class="sr-lookup-icon">&#128269;</span>
      <div class="sr-lookup-text">
        <div class="sr-lookup-title">Look up "<strong>${esc(q)}</strong>"</div>
        <div class="sr-lookup-sub">UPC database &middot; eBay sold prices</div>
      </div>
      <span class="sr-arrow">&#8250;</span>
    </div>`;

  if (inventory.length) {
    html += `<div class="sr-label">In Inventory (${inventory.length})</div>`;
    html += inventory.slice(0, 6).map(renderSearchRow).join('');
  }
  if (sold.length) {
    html += `<div class="sr-label">Sold (${sold.length})</div>`;
    html += sold.slice(0, 4).map(renderSearchRow).join('');
  }
  if (!inventory.length && !sold.length) {
    html += `<div class="sr-empty">No tracked items match</div>`;
  }

  dd.innerHTML = html;
  dd.style.display = 'block';
}

function renderSearchRow(item) {
  const thumb = item.image_url
    ? `<img class="sr-thumb" src="${esc(item.image_url)}" onerror="this.style.display='none'" />`
    : `<div class="sr-thumb-ph">&#128230;</div>`;
  const price = item.sell_price ? fmt(item.sell_price) : (item.buy_price ? fmt(item.buy_price) : '—');
  const date  = item.buy_date ? fmtDate(item.buy_date) : '';
  const badgeCls = item.status === 'sold' ? 'sr-badge-sold' : 'sr-badge-inv';
  const badgeTxt = item.status === 'sold' ? 'Sold' : 'Inventory';
  return `
    <div class="sr-item" onclick="closeSearch(); openModal('edit', ${item.id})">
      ${thumb}
      <div class="sr-item-body">
        <div class="sr-item-name">${esc(item.name)}</div>
        <div class="sr-item-meta">${price}${date ? ' &middot; ' + date : ''}</div>
      </div>
      <span class="sr-badge ${badgeCls}">${badgeTxt}</span>
    </div>`;
}

function closeSearch() {
  document.getElementById('search-dropdown').style.display = 'none';
}

function copyUpc(el) {
  const upc = document.getElementById('modal-upc-text').textContent;
  navigator.clipboard.writeText(upc).then(() => toast('UPC copied', 'success'));
}

async function openSearchLookup(q) {
  closeSearch();
  document.getElementById('global-search').value = '';

  document.getElementById('sm-query').textContent = q;
  document.getElementById('sm-upc-body').innerHTML  = '<div class="sm-loading">Looking up product…</div>';
  document.getElementById('sm-ebay-body').innerHTML = '<div class="sm-loading">Fetching eBay prices…</div>';
  document.getElementById('search-modal').style.display = 'flex';
  lastSearchLookup = null;

  const [upcRes, ebayRes] = await Promise.all([
    api(`/api/lookup/barcode?upc=${encodeURIComponent(q)}`).catch(() => null),
    api(`/api/lookup/ebay?q=${encodeURIComponent(q)}`).catch(() => null)
  ]);

  // UPC / product info
  if (upcRes && upcRes.found) {
    lastSearchLookup = upcRes;
    document.getElementById('sm-upc-body').innerHTML = `
      ${upcRes.image_url ? `<img class="sm-product-img" src="${esc(upcRes.image_url)}" />` : ''}
      <div class="sm-product-name">${esc(upcRes.name || q)}</div>
      ${upcRes.brand    ? `<div class="sm-product-meta"><span>Brand</span> ${esc(upcRes.brand)}</div>` : ''}
      ${upcRes.category ? `<div class="sm-product-meta"><span>Category</span> ${esc(upcRes.category)}</div>` : ''}
      ${upcRes.description ? `<div class="sm-product-desc">${esc(upcRes.description)}</div>` : ''}
      <button class="btn btn-primary" style="margin-top:14px;width:100%" onclick="prefillFromSearchLookup()">+ Add to Inventory</button>`;
  } else {
    document.getElementById('sm-upc-body').innerHTML = '<div class="sm-none">No product found in UPC database</div>';
  }

  // eBay pricing
  if (ebayRes && ebayRes.found) {
    const rows = (ebayRes.recentSales || []).map(s => `
      <div class="sm-sale-row">
        <span class="sm-sale-title">${esc(s.title || '')}</span>
        <span class="sm-sale-price">${fmt(s.price)}</span>
      </div>`).join('');
    document.getElementById('sm-ebay-body').innerHTML = `
      <div class="sm-price-boxes">
        <div class="sm-price-box"><div class="sm-px-label">Avg</div><div class="sm-px-val">${fmt(ebayRes.avg)}</div></div>
        <div class="sm-price-box sm-px-low"><div class="sm-px-label">Low</div><div class="sm-px-val">${fmt(ebayRes.low)}</div></div>
        <div class="sm-price-box sm-px-high"><div class="sm-px-label">High</div><div class="sm-px-val">${fmt(ebayRes.high)}</div></div>
      </div>
      <div class="sm-sales-head">Recent sold listings (${ebayRes.count})</div>
      <div class="sm-sales-list">${rows}</div>`;
  } else {
    const msg = ebayRes?.error || 'No eBay results found';
    document.getElementById('sm-ebay-body').innerHTML = `<div class="sm-none">${esc(msg)}</div>`;
  }
}

function closeSearchModal() {
  document.getElementById('search-modal').style.display = 'none';
}

function prefillFromSearchLookup() {
  if (!lastSearchLookup) return;
  closeSearchModal();
  openModal('add');
  document.getElementById('item-name').value     = lastSearchLookup.name        || '';
  document.getElementById('item-image').value    = lastSearchLookup.image_url   || '';
  document.getElementById('item-category').value = lastSearchLookup.category    || '';
  if (lastSearchLookup.image_url) previewImage(lastSearchLookup.image_url);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

async function api(url, method = 'GET', body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json();
}

function fmt(n) {
  if (n == null || isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${m}/${day}/${y.slice(2)}`;
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let toastTimer;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3000);
}

// ── Settings ──────────────────────────────────────────────────────────────────

function switchSettingsTab(tab) {
  ['api', 'telegram', 'apify'].forEach(t => {
    document.getElementById(`stab-${t}`).style.display      = t === tab ? 'block' : 'none';
    document.getElementById(`stab-btn-${t}`).classList.toggle('active', t === tab);
  });
}

async function openSettings(tab = 'api') {
  switchSettingsTab(tab);
  const data = await api('/api/settings');

  const ebayInput = document.getElementById('setting-ebay-app-id');
  const upcInput  = document.getElementById('setting-upc-key');

  // Show masked preview if already configured, clear placeholder so user
  // knows to retype if they want to change it
  if (data.EBAY_APP_ID.configured) {
    ebayInput.placeholder = data.EBAY_APP_ID.preview;
    ebayInput.value = '';
    document.getElementById('ebay-status').innerHTML =
      '<span class="key-ok">&#10003; Configured</span>';
  } else {
    ebayInput.placeholder = 'YourApp-YourKey-here…';
    ebayInput.value = '';
    document.getElementById('ebay-status').innerHTML =
      '<span class="key-missing">&#9675; Not set &mdash; eBay price lookup disabled</span>';
  }

  if (data.UPC_API_KEY.configured) {
    upcInput.placeholder = data.UPC_API_KEY.preview;
    upcInput.value = '';
    document.getElementById('upc-status').innerHTML =
      '<span class="key-ok">&#10003; Configured (paid tier)</span>';
  } else {
    upcInput.placeholder = 'Leave blank to use free tier';
    upcInput.value = '';
    document.getElementById('upc-status').innerHTML =
      '<span class="key-ok">&#10003; Using free tier (100 lookups/day)</span>';
  }

  // Telegram tab
  if (data.TELEGRAM_BOT_TOKEN?.configured) {
    document.getElementById('setting-tg-token').placeholder = data.TELEGRAM_BOT_TOKEN.preview;
    document.getElementById('setting-tg-token').value = '';
    document.getElementById('tg-token-status').innerHTML = '<span class="key-ok">&#10003; Configured</span>';
  } else {
    document.getElementById('setting-tg-token').placeholder = '1234567890:ABCdef…';
    document.getElementById('setting-tg-token').value = '';
    document.getElementById('tg-token-status').innerHTML = '<span class="key-missing">&#9675; Not set</span>';
  }
  document.getElementById('setting-tg-chat-id').value = data.TELEGRAM_CHAT_ID || '';
  document.getElementById('tg-chat-status').innerHTML = data.TELEGRAM_CHAT_ID
    ? `<span class="key-ok">&#10003; Chat ID: ${data.TELEGRAM_CHAT_ID}</span>`
    : '<span class="key-missing">&#9675; Not set</span>';
  document.getElementById('tg-test-result').innerHTML = '';

  // Apify tab
  if (data.APIFY_TOKEN?.configured) {
    document.getElementById('setting-apify-token').placeholder = data.APIFY_TOKEN.preview;
    document.getElementById('setting-apify-token').value = '';
    document.getElementById('apify-token-status').innerHTML = '<span class="key-ok">&#10003; Configured — scanner enabled</span>';
  } else {
    document.getElementById('setting-apify-token').placeholder = 'apify_api_…';
    document.getElementById('setting-apify-token').value = '';
    document.getElementById('apify-token-status').innerHTML = '<span class="key-missing">&#9675; Not set — scanner disabled</span>';
  }
  const tscStore = data.TSC_STORE_NUMBER || '';
  document.getElementById('setting-tsc-store').value = tscStore;
  document.getElementById('tsc-store-status').innerHTML = tscStore
    ? `<span class="key-ok">&#10003; Store ${tscStore}</span>`
    : '<span class="key-missing">&#9675; Not set — using default 10151</span>';

  if (data.VERSION) document.getElementById('settings-version').textContent = `v${data.VERSION}`;

  document.getElementById('settings-modal').style.display = 'flex';
}

function closeSettings() {
  document.getElementById('settings-modal').style.display = 'none';
}

async function saveSettings() {
  const body = {};
  const ebayVal    = document.getElementById('setting-ebay-app-id').value.trim();
  const upcVal     = document.getElementById('setting-upc-key').value.trim();
  const tgToken    = document.getElementById('setting-tg-token').value.trim();
  const tgChatId   = document.getElementById('setting-tg-chat-id').value.trim();
  const apifyToken = document.getElementById('setting-apify-token').value.trim();
  const tscStore   = document.getElementById('setting-tsc-store').value.trim();

  if (ebayVal)    body.EBAY_APP_ID        = ebayVal;
  if (upcVal)     body.UPC_API_KEY        = upcVal;
  if (tgToken)    body.TELEGRAM_BOT_TOKEN = tgToken;
  if (tgChatId)   body.TELEGRAM_CHAT_ID   = tgChatId;
  if (apifyToken) body.APIFY_TOKEN        = apifyToken;
  if (tscStore)   body.TSC_STORE_NUMBER   = tscStore;

  if (Object.keys(body).length === 0) { closeSettings(); return; }
  await api('/api/settings', 'POST', body);
  closeSettings();
  toast('Settings saved', 'success');
}

async function testTelegram() {
  const btn = document.getElementById('tg-test-btn');
  const res = document.getElementById('tg-test-result');
  btn.disabled = true;
  res.innerHTML = '<span style="color:var(--text-dim)">Sending…</span>';
  const data = await api('/api/telegram/test', 'POST');
  btn.disabled = false;
  if (data.ok) {
    res.innerHTML = '<span class="key-ok">&#10003; Message sent! Check Telegram.</span>';
  } else {
    res.innerHTML = `<span class="key-missing">&#10007; Failed: ${esc(data.error || 'Unknown error')}</span>`;
  }
}

function toggleKeyVis(inputId, btn) {
  const el = document.getElementById(inputId);
  if (el.type === 'password') {
    el.type = 'text';
    btn.textContent = '\u{1F648}'; // eyes covered
  } else {
    el.type = 'password';
    btn.textContent = '\u{1F441}'; // eye
  }
}
