let currentTab = 'all';
let deleteTargetId = null;
let modalDeleteId = null;
let allItemsCache = [];
let searchDebounce = null;
let lastSearchLookup = null;

const PLATFORM_FEES = {
  'eBay': 13.25, 'Mercari': 3, 'Facebook Marketplace': 0,
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

  const deleteBtn = document.getElementById('modal-delete-btn');
  if (mode === 'edit' && id) {
    modalDeleteId = id;
    deleteBtn.style.display = 'inline-flex';
    loadItemIntoForm(id);
  } else {
    modalDeleteId = null;
    deleteBtn.style.display = 'none';
    document.getElementById('buy-date').value = today();
    document.getElementById('modal-upc-badge').style.display = 'none';
  }

  document.getElementById('item-modal').style.display = 'flex';
}

async function loadItemIntoForm(id) {
  const item = await api(`/api/items/${id}`);
  document.getElementById('item-id').value = item.id;
  document.getElementById('barcode').value = item.barcode || '';

  const upcBadge = document.getElementById('modal-upc-badge');
  if (item.barcode) {
    document.getElementById('modal-upc-text').textContent = item.barcode;
    upcBadge.style.display = 'inline-flex';
  } else {
    upcBadge.style.display = 'none';
  }
  document.getElementById('item-name').value = item.name || '';
  document.getElementById('item-category').value = item.category || '';
  document.getElementById('item-image').value = item.image_url || '';
  document.getElementById('item-notes').value = item.notes || '';
  document.getElementById('buy-price').value = item.buy_price || '';
  document.getElementById('item-quantity').value = item.quantity || 1;
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
   'item-id','ebay-avg-val','ebay-low-val','ebay-high-val','search-name',
   'item-quantity'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('platform-fee-pct').value = 0;
  document.getElementById('item-status').value = 'inventory';
  document.getElementById('status-select').value = 'inventory';
  document.getElementById('item-quantity').value = 1;
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
    status: document.getElementById('item-status').value,
    quantity: parseInt(document.getElementById('item-quantity').value) || 1
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
