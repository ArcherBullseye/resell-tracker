const SUPPORTED = { lowes: "Lowe's", tractorsupply: 'TSC', homedepot: 'Home Depot', walmart: 'Walmart' };

const $ = id => document.getElementById(id);
const statusEl = $('status');
const scanBtn  = $('scan-btn');
const autoBtn  = $('auto-btn');
const dlBtn    = $('download-btn');
const clearBtn = $('clear-btn');
const badge    = $('site-badge');
const countEl  = $('buffer-count');

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

// Load buffer count on open; also check if an auto-scan is running
chrome.runtime.sendMessage({ type: 'GET_COUNT' }, r => updateCount(r?.count || 0));
chrome.storage.local.get('autoScanning', ({ autoScanning }) => {
  if (autoScanning) showScanning();
});

function showScanning() {
  autoBtn.textContent = '⏹ Stop Scanning';
  autoBtn.classList.add('scanning');
  autoBtn.disabled = false;
  scanBtn.disabled = true;
  setStatus('Scanning all pages… Badge shows running count.\nClick Stop to abort.', 'info');
}

function clearScanningState() {
  autoBtn.textContent = '⚡ All Pages';
  autoBtn.classList.remove('scanning');
  if (_tabId) { scanBtn.disabled = false; autoBtn.disabled = false; }
}

let _tabId = null;
let _isScanning = false;

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) { setStatus('No active tab.', 'err'); return; }
  chrome.tabs.sendMessage(tab.id, { type: 'PING' }, response => {
    if (chrome.runtime.lastError || !response?.ok) {
      badge.textContent = 'Not supported';
      badge.className = 'site-badge unsupported';
      setStatus("Go to a retailer clearance page.\nSupported: Lowe's, TSC, Home Depot, Walmart", 'info');
      return;
    }
    const name = SUPPORTED[response.retailer] || response.retailer;
    badge.textContent = name;
    badge.className = 'site-badge';
    scanBtn.disabled = false;
    autoBtn.disabled = false;
    setStatus(`On ${name} — choose scan mode.`, 'info');
    _tabId = tab.id;
  });
});

// Single-page manual scan
scanBtn.addEventListener('click', () => {
  if (!_tabId) return;
  scanBtn.disabled = true;
  setStatus('Scanning this page…', 'info');
  chrome.tabs.sendMessage(_tabId, { type: 'EXTRACT_AND_SEND' }, result => {
    scanBtn.disabled = false;
    if (chrome.runtime.lastError || !result?.ok) {
      setStatus('Error: ' + (chrome.runtime.lastError?.message || result?.error || 'Unknown'), 'err');
      return;
    }
    updateCount(result.total);
    setStatus(`✓ Added ${result.added} (${result.total} total).\nScan more or download when done.`, 'ok');
  });
});

// Auto-scan all pages (or stop if already scanning)
autoBtn.addEventListener('click', () => {
  if (_isScanning) {
    // Stop
    _isScanning = false;
    chrome.storage.local.set({ autoScanning: false }, () => {
      clearScanningState();
      setStatus('Scan stopped.', 'info');
    });
    return;
  }
  if (!_tabId) return;

  _isScanning = true;
  chrome.storage.local.set({ autoScanning: true }, () => {
    showScanning();
    chrome.tabs.sendMessage(_tabId, { type: 'START_AUTO_SCAN' }, result => {
      // Response comes quickly (before page navigates); errors handled here
      if (chrome.runtime.lastError || !result?.ok) {
        _isScanning = false;
        chrome.storage.local.set({ autoScanning: false });
        clearScanningState();
        setStatus('Error: ' + (chrome.runtime.lastError?.message || result?.error || 'Failed to start'), 'err');
      }
      // On success the page will navigate and content script takes over;
      // auto-scan continues across page loads via storage flag.
    });
  });
});

// Poll buffer count while popup is open (to reflect scanning progress)
const poller = setInterval(() => {
  chrome.runtime.sendMessage({ type: 'GET_COUNT' }, r => {
    if (r) updateCount(r.count);
  });
  chrome.storage.local.get('autoScanning', ({ autoScanning }) => {
    if (!autoScanning && _isScanning) {
      // Auto-scan finished
      _isScanning = false;
      clearScanningState();
      chrome.runtime.sendMessage({ type: 'GET_COUNT' }, r => {
        updateCount(r?.count || 0);
        setStatus(`✓ Scan complete — ${r?.count || 0} products buffered.\nClick Download when ready.`, 'ok');
      });
    }
  });
}, 1500);

window.addEventListener('unload', () => clearInterval(poller));

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
  _isScanning = false;
  chrome.runtime.sendMessage({ type: 'CLEAR_BUFFER' }, () => {
    clearScanningState();
    updateCount(0);
    setStatus('Buffer cleared.', 'info');
  });
});
