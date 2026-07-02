const SUPPORTED = { lowes: "Lowe's", tractorsupply: 'TSC', homedepot: 'Home Depot', walmart: 'Walmart' };

const $ = id => document.getElementById(id);
const statusEl  = $('status');
const scanBtn   = $('scan-btn');
const dlBtn     = $('download-btn');
const clearBtn  = $('clear-btn');
const badge     = $('site-badge');
const countEl   = $('buffer-count');

function setStatus(msg, type = 'info') {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
}

function updateCount(n) {
  countEl.textContent = n > 0 ? `${n} product${n === 1 ? '' : 's'} buffered` : 'Buffer empty';
  dlBtn.disabled = n === 0;
  dlBtn.textContent = n > 0 ? `⬇ Download File (${n} products)` : '⬇ Download File';
  clearBtn.style.display = n > 0 ? 'inline' : 'none';
}

// Load current buffer count on open
chrome.runtime.sendMessage({ type: 'GET_COUNT' }, r => updateCount(r?.count || 0));

// Detect retailer on active tab
let _tabId = null;

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) { setStatus('No active tab.', 'err'); return; }
  chrome.tabs.sendMessage(tab.id, { type: 'PING' }, response => {
    if (chrome.runtime.lastError || !response?.ok) {
      badge.textContent = 'Not supported';
      badge.className = 'site-badge unsupported';
      setStatus("Go to a retailer clearance page to scan.\nSupported: Lowe's, TSC, Home Depot, Walmart", 'info');
      return;
    }
    const name = SUPPORTED[response.retailer] || response.retailer;
    badge.textContent = name;
    badge.className = 'site-badge';
    scanBtn.disabled = false;
    setStatus(`Ready to scan ${name}.\nProducts add to the buffer — download when done.`, 'info');
    _tabId = tab.id;
  });
});

scanBtn.addEventListener('click', () => {
  if (!_tabId) return;
  scanBtn.disabled = true;
  setStatus('Scanning page…', 'info');
  chrome.tabs.sendMessage(_tabId, { type: 'EXTRACT_AND_SEND' }, result => {
    scanBtn.disabled = false;
    if (chrome.runtime.lastError) {
      setStatus('Error: ' + chrome.runtime.lastError.message, 'err');
      return;
    }
    if (!result?.ok) {
      setStatus('Error: ' + (result?.error || 'Unknown error'), 'err');
      return;
    }
    updateCount(result.total);
    setStatus(`✓ Added ${result.added} products (${result.total} total).\nScan more pages or download when done.`, 'ok');
  });
});

dlBtn.addEventListener('click', () => {
  dlBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_AND_CLEAR' }, result => {
    if (!result?.ok) {
      setStatus('Download failed: ' + (result?.error || 'Unknown'), 'err');
      dlBtn.disabled = false;
      return;
    }
    updateCount(0);
    setStatus(`✓ Saved ${result.count} products to file.\nUpload it in Resell Tracker → Scanner.`, 'ok');
  });
});

clearBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_BUFFER' }, () => {
    updateCount(0);
    setStatus('Buffer cleared.', 'info');
  });
});
