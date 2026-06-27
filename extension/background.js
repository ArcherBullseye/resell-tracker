const DEFAULT_UMBREL_URL = 'http://umbrel.local:3000';

async function getUmbrelUrl() {
  const { umbrelUrl } = await chrome.storage.local.get('umbrelUrl');
  return (umbrelUrl || DEFAULT_UMBREL_URL).replace(/\/$/, '');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SEND_PRODUCTS') {
    handleSend(msg).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // async response
  }
});

async function handleSend({ products, retailer }) {
  const base = await getUmbrelUrl();
  const response = await fetch(`${base}/api/scan/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ retailer, products }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Server error ${response.status}: ${text.slice(0, 120)}`);
  }
  return response.json();
}
