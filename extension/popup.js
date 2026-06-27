const SUPPORTED = { lowes: "Lowe's", tractorsupply: 'TSC', homedepot: 'Home Depot', walmart: 'Walmart' };

const $ = id => document.getElementById(id);
const statusEl = $('status');
const scanBtn  = $('scan-btn');
const badge    = $('site-badge');
const urlInput = $('umbrel-url');

function setStatus(msg, type = 'info') {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
}

// Load saved Umbrel URL
chrome.storage.local.get('umbrelUrl', ({ umbrelUrl }) => {
  urlInput.value = umbrelUrl || 'http://umbrel.local:3000';
});

$('save-btn').addEventListener('click', () => {
  const val = urlInput.value.trim().replace(/\/$/, '');
  chrome.storage.local.set({ umbrelUrl: val }, () => setStatus('Umbrel URL saved.', 'ok'));
});

// Ping the active tab to see what retailer we're on
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) { setStatus('No active tab found.', 'err'); return; }
  chrome.tabs.sendMessage(tab.id, { type: 'PING' }, response => {
    if (chrome.runtime.lastError || !response?.ok) {
      badge.textContent = 'Not supported';
      badge.className = 'site-badge unsupported';
      setStatus('Navigate to a supported retailer clearance page.\nSupported: Lowe\'s, TSC, Home Depot, Walmart', 'info');
      return;
    }
    const name = SUPPORTED[response.retailer] || response.retailer;
    badge.textContent = name;
    badge.className = 'site-badge';
    scanBtn.disabled = false;
    setStatus(`Ready to scan ${name}.\nProducts will be sent to Resell Tracker.`, 'info');
    _tabId = tab.id;
    _retailer = response.retailer;
  });
});

let _tabId = null;
let _retailer = null;

scanBtn.addEventListener('click', async () => {
  if (!_tabId) return;
  scanBtn.disabled = true;
  setStatus('Scanning page…', 'info');

  chrome.tabs.sendMessage(_tabId, { type: 'EXTRACT_AND_SEND' }, result => {
    if (chrome.runtime.lastError) {
      setStatus('Content script error: ' + chrome.runtime.lastError.message, 'err');
      scanBtn.disabled = false;
      return;
    }
    if (!result?.ok) {
      setStatus('Error: ' + (result?.error || 'Unknown error'), 'err');
      scanBtn.disabled = false;
      return;
    }
    const added = result.added ?? result.count ?? '?';
    const total = result.total ?? added;
    setStatus(`✓ Sent ${added} products (${total} total buffered).\nSwitch to Resell Tracker to see them.`, 'ok');
    scanBtn.disabled = false;
  });
});
