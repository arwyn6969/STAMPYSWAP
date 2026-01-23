# STAMPYSWAP 🔄

A lightweight, non-custodial DEX interface for **Counterparty (XCP)** and **Bitcoin Stamps** assets.

![Dark Theme](https://img.shields.io/badge/Theme-Dark-black)
![React](https://img.shields.io/badge/React-18-61dafb)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)
![Version](https://img.shields.io/badge/Version-1.3-purple)

## Features

- 📊 **Live Order Book** — View open buy/sell orders from the Counterparty DEX
- 📈 **Depth Visualization** — Visual bid/ask walls with mid price and spread
- 🔎 **Market Discovery** — Smart dropdown showing 100+ active trading pairs
- 🖼️ **Asset Icons** — Visual identification with Stampchain integration
- 💼 **Balance Display** — See your Counterparty assets at a glance
- 🔐 **Non-Custodial** — Your keys never leave your wallet
- 📱 **Freewallet QR** — Scan to sign with Freewallet mobile app
- ⚡ **Real-time Data** — Direct connection to Counterparty & Stampchain APIs

## Quick Start

```bash
# Install dependencies
npm install

# Run development server
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

## How to Trade

1. **Quick Select** — Click XCP, BTC, PEPECASH, or RAREPEPE buttons
2. **Pick Market** — Browse dropdown showing active pairs with order counts
3. **View Depth** — See visual bid/ask walls and order book
4. **Create Order** — Fill in amounts and click "Create Order"
5. **Sign with Freewallet** — Scan the QR code with Freewallet app
6. **Done!** — Freewallet broadcasts the transaction

## Project Structure

```
src/
├── App.tsx                    # Main application
├── lib/
│   ├── counterparty.ts        # Counterparty API v2 client
│   └── stamps.ts              # Stampchain API client
└── components/
    ├── AssetIcon.tsx          # Asset icons with Stamp detection
    ├── BalanceDisplay.tsx     # User balance panel
    ├── DepthChart.tsx         # Visual bid/ask depth
    ├── OrderBook.tsx          # Order table with icons
    ├── PairSelector.tsx       # Smart pair selector
    ├── QRSigner.tsx           # Freewallet QR modal
    └── TradeForm.tsx          # Create order form
```

## APIs

### Counterparty Core API v2
Base: `https://api.counterparty.io:4000/v2`

| Endpoint | Purpose |
|:---------|:--------|
| `GET /orders/{asset1}/{asset2}` | Fetch order book |
| `GET /assets/{asset}/orders` | Get markets for asset |
| `GET /addresses/{addr}/balances` | Get user balances |
| `GET /addresses/{addr}/compose/order` | Compose order tx |

### Stampchain API
Base: `https://stampchain.io/api/v2`

| Endpoint | Purpose |
|:---------|:--------|
| `GET /stamps/{cpid}` | Get stamp metadata & image |

## Tech Stack

- **Vite** — Fast dev server and build (~72KB gzipped)
- **React 18** — UI framework
- **TypeScript** — Type safety
- **qrcode.react** — QR code generation

## Version History

| Version | Features |
|:--------|:---------|
| v1.0 | Order book, depth chart, trade form, QR signing |
| v1.1 | Balance display panel |
| v1.2 | Asset icons with Stampchain enrichment |
| v1.3 | Smart Pair Selector with market discovery |

## Future Enhancements

- [ ] Leather wallet extension support
- [ ] Transaction status polling
- [ ] Favorite/recent pairs
- [ ] Testnet toggle

## License

MIT

## Credits

- [Counterparty](https://counterparty.io) — DEX protocol
- [Stampchain](https://stampchain.io) — Bitcoin Stamps metadata
- [Freewallet](https://freewallet.io) — Mobile signing
