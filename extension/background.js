async function getBuffer() {
  const { scanBuffer = [] } = await chrome.storage.local.get('scanBuffer');
  return scanBuffer;
}

async function addToBuffer(products, retailer) {
  const current = await getBuffer();
  const seen = new Set(current.map(p => p.url).filter(Boolean));
  const tagged = products.map(p => ({ ...p, _retailer: retailer }));
  const fresh = tagged.filter(p => !p.url || !seen.has(p.url));
  const buffer = [...current, ...fresh];
  await chrome.storage.local.set({ scanBuffer: buffer });
  return { ok: true, added: fresh.length, total: buffer.length };
}

async function downloadAndClear() {
  const buffer = await getBuffer();
  if (!buffer.length) return { ok: false, error: 'Nothing buffered yet' };
  const payload = JSON.stringify({ products: buffer, scanned_at: new Date().toISOString() }, null, 2);
  const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(payload);
  const filename = `resell-scan-${new Date().toISOString().slice(0, 10)}.json`;
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
  await chrome.storage.local.set({ scanBuffer: [] });
  return { ok: true, count: buffer.length };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SEND_PRODUCTS') {
    addToBuffer(msg.products, msg.retailer).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'GET_COUNT') {
    getBuffer().then(buf => sendResponse({ count: buf.length })).catch(() => sendResponse({ count: 0 }));
    return true;
  }
  if (msg.type === 'DOWNLOAD_AND_CLEAR') {
    downloadAndClear().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'CLEAR_BUFFER') {
    chrome.storage.local.set({ scanBuffer: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }
});
