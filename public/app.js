let currentTab = 'all';
let deleteTargetId = null;

const PLATFORM_FEES = {
  'eBay': 13.25, 'Mercari': 3, 'Facebook Marketplace': 0,
  'OfferUp': 12.9, 'Poshmark': 20, 'Depop': 3, 'Etsy': 6.5,
  'Amazon': 15, 'Craigslist': 0, 'Local Sale': 0, 'Other': 0
};

// ── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  loadItems();

  // Recalculate profit preview when prices change
  ['sell-price', 'buy-price', 'shipping-cost'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateProfitPreview);
  });

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
  document.getElementById('stat-invested').textContent = fmt(stats.totalInvested);
  document.getElementById('stat-revenue').textContent = fmt(stats.totalRevenue);
  const profitEl = document.getElementById('stat-profit');
  profitEl.textContent = fmt(stats.netProfit);
  profitEl.className = 'stat-value ' + (stats.netProfit >= 0 ? 'profit-pos' : 'profit-neg');
}

// ── Items ─────────────────────────────────────────────────────────────────────

async function loadItems(tab) {
  if (tab) currentTab = tab;
  const status = currentTab === 'all' ? '' : currentTab;
  const items = await api('/api/items' + (status ? `?status=${status}` : ''));

  const grid = document.getElementById('items-grid');
  const empty = document.getElementById('empty-state');

  if (items.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  grid.innerHTML = items.map(renderCard).join('');
}

function renderCard(item) {
  const imgHtml = item.image_url
    ? `<img class="item-card-img" src="${esc(item.image_url)}" alt="${esc(item.name)}" onerror="this.parentNode.innerHTML='<div class=item-card-img-placeholder>📦</div>'" />`
    : `<div class="item-card-img-placeholder">📦</div>`;

  const badgeClass = item.status === 'sold' ? 'badge-sold' : 'badge-inventory';
  const badgeText = item.status === 'sold' ? 'Sold' : 'Inventory';

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
        ${platformHtml}
        <div class="item-actions">
          <button class="btn btn-secondary" onclick="openModal('edit', ${item.id})">Edit</button>
          <button class="btn btn-ghost" onclick="openDeleteModal(${item.id}, '${esc(item.name)}')">Delete</button>
        </div>
      </div>
    </div>`;
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

  if (mode === 'edit' && id) {
    loadItemIntoForm(id);
  } else {
    document.getElementById('buy-date').value = today();
  }

  document.getElementById('item-modal').style.display = 'flex';
}

async function loadItemIntoForm(id) {
  const item = await api(`/api/items/${id}`);
  document.getElementById('item-id').value = item.id;
  document.getElementById('barcode').value = item.barcode || '';
  document.getElementById('item-name').value = item.name || '';
  document.getElementById('item-category').value = item.category || '';
  document.getElementById('item-image').value = item.image_url || '';
  document.getElementById('item-notes').value = item.notes || '';
  document.getElementById('buy-price').value = item.buy_price || '';
  document.getElementById('buy-date').value = item.buy_date || '';
  document.getElementById('sell-price').value = item.sell_price || '';
  document.getElementById('sell-date').value = item.sell_date || '';
  document.getElementById('shipping-cost').value = item.shipping_cost || '';
  document.getElementById('platform-fee-pct').value = item.platform_fee_pct || 0;
  document.getElementById('item-status').value = item.status || 'inventory';
  document.getElementById('status-select').value = item.status || 'inventory';

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
  ['barcode','item-name','item-category','item-image','item-notes',
   'buy-price','buy-date','sell-price','sell-date','shipping-cost',
   'item-id','ebay-avg-val','ebay-low-val','ebay-high-val','search-name'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('platform-fee-pct').value = 0;
  document.getElementById('item-status').value = 'inventory';
  document.getElementById('status-select').value = 'inventory';
  document.getElementById('selling-platform').value = '';
  document.getElementById('ebay-section').style.display = 'none';
  document.getElementById('profit-preview').style.display = 'none';
  document.getElementById('image-preview').innerHTML = '<span>No image</span>';
}

// ── Lookup ────────────────────────────────────────────────────────────────────

async function lookupBarcode() {
  const upc = document.getElementById('barcode').value.trim();
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

  toast('Product found! Check eBay prices below.', 'success');

  // Auto-trigger eBay lookup
  if (data.name) lookupEbayByQuery(data.name);
}

async function lookupEbayByName() {
  const name = document.getElementById('search-name').value.trim()
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
  document.getElementById('ebay-low').textContent = fmt(data.low);
  document.getElementById('ebay-avg').textContent = fmt(data.avg);
  document.getElementById('ebay-high').textContent = fmt(data.high);
  document.getElementById('ebay-count').textContent = `Based on ${data.count} recent sold listings`;
  document.getElementById('ebay-section').style.display = 'block';

  if (data.recentSales && data.recentSales.length > 0) {
    document.getElementById('recent-sales').innerHTML = data.recentSales.map(s => `
      <div class="recent-sale-row">
        <span class="sale-title" title="${esc(s.title)}">${esc(s.title)}</span>
        <span class="sale-price">${fmt(s.price)}</span>
        ${s.itemUrl ? `<a href="${esc(s.itemUrl)}" target="_blank">View ↗</a>` : ''}
      </div>`).join('');
  }
}

// ── Platform fee / profit preview ─────────────────────────────────────────────

function updatePlatformFee() {
  const sel = document.getElementById('selling-platform');
  const platform = sel.value;
  const fee = PLATFORM_FEES[platform] || 0;
  document.getElementById('platform-fee-pct').value = fee;
  updateProfitPreview();
}

function updateProfitPreview() {
  const sell = parseFloat(document.getElementById('sell-price').value) || 0;
  const buy = parseFloat(document.getElementById('buy-price').value) || 0;
  const ship = parseFloat(document.getElementById('shipping-cost').value) || 0;
  const feePct = parseFloat(document.getElementById('platform-fee-pct').value) || 0;
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

  const id = document.getElementById('item-id').value;
  const sellPrice = parseFloat(document.getElementById('sell-price').value) || null;
  const statusEl = document.getElementById('item-status');
  if (sellPrice && statusEl.value === 'inventory') {
    statusEl.value = 'sold';
    document.getElementById('status-select').value = 'sold';
  }

  const body = {
    barcode: document.getElementById('barcode').value.trim() || null,
    name,
    category: document.getElementById('item-category').value.trim() || null,
    image_url: document.getElementById('item-image').value.trim() || null,
    notes: document.getElementById('item-notes').value.trim() || null,
    buy_price: parseFloat(document.getElementById('buy-price').value) || null,
    buy_date: document.getElementById('buy-date').value || null,
    sell_price: sellPrice,
    sell_date: document.getElementById('sell-date').value || null,
    shipping_cost: parseFloat(document.getElementById('shipping-cost').value) || 0,
    selling_platform: document.getElementById('selling-platform').value || null,
    platform_fee_pct: parseFloat(document.getElementById('platform-fee-pct').value) || 0,
    ebay_avg_price: parseFloat(document.getElementById('ebay-avg-val').value) || null,
    ebay_low_price: parseFloat(document.getElementById('ebay-low-val').value) || null,
    ebay_high_price: parseFloat(document.getElementById('ebay-high-val').value) || null,
    status: document.getElementById('item-status').value
  };

  if (id) {
    await api(`/api/items/${id}`, 'PUT', body);
    toast('Item updated', 'success');
  } else {
    await api('/api/items', 'POST', body);
    toast('Item added', 'success');
  }

  closeModal();
  loadStats();
  loadItems();
}

// ── Delete ────────────────────────────────────────────────────────────────────

function openDeleteModal(id, name) {
  deleteTargetId = id;
  document.getElementById('delete-item-name').textContent = name;
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

async function openSettings() {
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

  document.getElementById('settings-modal').style.display = 'flex';
}

function closeSettings() {
  document.getElementById('settings-modal').style.display = 'none';
}

async function saveSettings() {
  const ebayVal = document.getElementById('setting-ebay-app-id').value.trim();
  const upcVal  = document.getElementById('setting-upc-key').value.trim();

  const body = {};
  // Only send a key if the user typed something — blank means "leave unchanged"
  // unless they explicitly want to clear it (which they can do by typing a space, then saving)
  if (ebayVal !== '') body.EBAY_APP_ID = ebayVal;
  if (upcVal  !== '') body.UPC_API_KEY  = upcVal;

  if (Object.keys(body).length === 0) {
    closeSettings();
    return;
  }

  await api('/api/settings', 'POST', body);
  closeSettings();
  toast('Settings saved', 'success');
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
