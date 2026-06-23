# Resell Tracker

[![Version](https://img.shields.io/badge/version-1.0.0-blue)](https://github.com/ArcherBullseye/resell-tracker/releases)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Umbrel](https://img.shields.io/badge/Umbrel-Compatible-purple)](https://umbrel.com)

A self-hosted retail arbitrage tracker that runs on your **Umbrel home server**. Record every buy and sell, look up barcode data and eBay sold prices, and track your net profit — all stored locally with no cloud dependency.

![Resell Tracker Screenshot](screenshot.png)

---

## Features

- **Barcode lookup** — scan or enter a UPC to auto-fill product name, category, and image
- **eBay sold price data** — pulls recent completed/sold listings (low, avg, high) via the eBay Finding API
- **Buy tracking** — log purchase price and date
- **Sell tracking** — log sale price, date, shipping cost, and selling platform
- **Platform fee calculator** — automatically applies fees for eBay, Mercari, Poshmark, Facebook, and more
- **Live profit preview** — see net profit before you save
- **Dashboard** — total invested, total revenue, net profit across all items
- **Inventory / Sold filter** — separate views for what you still hold vs. what's been flipped
- **100% local** — SQLite database, no accounts, no subscriptions

---

## Running on Umbrel

### Option 1: Umbrel Community App Store (recommended)

Add this repo as a community app store source in your Umbrel dashboard:

1. Go to **App Store** → **Community App Stores**
2. Add: `https://github.com/ArcherBullseye/resell-tracker`
3. Install **Resell Tracker**
4. Set your API keys in the app settings (see [API Keys](#api-keys))

### Option 2: Manual install on Umbrel (SSH)

```bash
# SSH into your Umbrel
ssh umbrel@umbrel.local

# Clone the repo
git clone https://github.com/ArcherBullseye/resell-tracker ~/umbrel/app-data/resell-tracker
cd ~/umbrel/app-data/resell-tracker

# Create your env file
cp .env.example .env
nano .env   # add your API keys

# Build and start
docker compose up -d --build
```

Then visit `http://umbrel.local:3000`

---

## Running Locally (non-Umbrel)

```bash
git clone https://github.com/ArcherBullseye/resell-tracker
cd resell-tracker
cp .env.example .env
# Edit .env and add your API keys
docker compose up -d --build
```

Or with Node.js directly:

```bash
npm install
cp .env.example .env
node server.js
```

---

## API Keys

Both keys are **free**. The app works without them but with reduced functionality.

### eBay App ID (required for price lookups)

1. Go to [developer.ebay.com](https://developer.ebay.com)
2. Sign in with your eBay account
3. Create an application → copy the **App ID (Client ID)**
4. Add it to your `.env`:
   ```
   EBAY_APP_ID=YourApp-YourKey-here
   ```

### UPC Item DB (optional — barcode lookup)

- **Free tier**: 100 lookups/day, **no key needed**
- **Paid tier**: unlimited lookups with a key from [upcitemdb.com](https://www.upcitemdb.com)
- Add to `.env` if you have one:
  ```
  UPC_API_KEY=your_key_here
  ```

---

## Supported Selling Platforms

| Platform | Fee |
|---|---|
| eBay | 13.25% |
| Mercari | 10% |
| Facebook Marketplace | 5% |
| OfferUp | 12.9% |
| Poshmark | 20% |
| Depop | 10% |
| Etsy | 6.5% |
| Amazon | 15% |
| Craigslist | Free |
| Local Sale | Free |

---

## Data Storage

All data is stored in a SQLite database at `/app/data/resell.db` inside the container, mapped to `./data/resell.db` on your host. Back it up by copying that file.

---

## Adding an App Icon

The Umbrel community marketplace requires a **512×512 JPG** named `umbrel-app-icon.jpg` in the repo root. Add your icon and update the `icon:` field in `umbrel-app.yml` to point to it.

---

## License

MIT
