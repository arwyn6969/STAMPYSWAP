# STAMPYSWAP 🔄

A lightweight, non-custodial DEX interface for **Counterparty (XCP)** assets on Bitcoin.

![Dark Theme](https://img.shields.io/badge/Theme-Dark-black)
![React](https://img.shields.io/badge/React-18-61dafb)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)

## Features

- 📊 **Live Order Book** — View open buy/sell orders from the Counterparty DEX
- 📈 **Depth Visualization** — Visual bid/ask walls with mid price and spread
- 🔐 **Non-Custodial** — Your keys never leave your wallet
- 📱 **Freewallet QR** — Scan to sign with Freewallet mobile app
- ⚡ **Real-time Data** — Direct connection to Counterparty API

## Quick Start

```bash
# Install dependencies
npm install

# Run development server
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

## How to Trade

1. **Select Pair** — Enter base and quote assets (e.g., `XCP` / `PEPECASH`)
2. **View Market** — See depth chart and order book
3. **Create Order** — Fill in amounts and click "Create Order"
4. **Sign with Freewallet** — Scan the QR code with Freewallet app
5. **Done!** — Freewallet broadcasts the transaction

## Project Structure

```
src/
├── App.tsx                    # Main application
├── lib/
│   └── counterparty.ts        # API client for Counterparty v2
└── components/
    ├── DepthChart.tsx         # Visual bid/ask depth
    ├── OrderBook.tsx          # Order table
    ├── TradeForm.tsx          # Create order form
    └── QRSigner.tsx           # QR code modal for Freewallet
```

## API

Uses **Counterparty Core API v2** at `api.counterparty.io:4000`:

| Endpoint | Purpose |
|:---------|:--------|
| `GET /v2/orders/{asset1}/{asset2}` | Fetch order book |
| `GET /v2/addresses/{addr}/compose/order` | Compose order transaction |
| `GET /v2/mempool/events` | Check pending transactions |

## Tech Stack

- **Vite** — Fast dev server and build
- **React 18** — UI framework
- **TypeScript** — Type safety
- **qrcode.react** — QR code generation

## Future Enhancements

- [ ] Leather wallet extension support
- [ ] Transaction status polling
- [ ] Favorite/recent pairs

## License

MIT

## Credits

- [Counterparty](https://counterparty.io) — DEX protocol
- [Freewallet](https://freewallet.io) — Mobile signing
