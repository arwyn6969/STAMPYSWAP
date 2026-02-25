# STAMPYSWAP 🔄

A lightweight, non-custodial DEX interface for **Counterparty (XCP)** and **Bitcoin Stamps** assets.

![Dark Theme](https://img.shields.io/badge/Theme-Dark-black)
![React](https://img.shields.io/badge/React-19-61dafb)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)
![Version](https://img.shields.io/badge/Version-1.5-purple)

## Features

- 📊 **Live Order Book** — View open buy/sell orders from the Counterparty DEX
- 📈 **Depth Visualization** — Visual bid/ask walls with mid price and spread
- 🔎 **Market Discovery** — Smart dropdown showing 100+ active trading pairs
- 🖼️ **Asset Icons** — Visual identification with Stampchain integration
- 💼 **Balance Display** — See your Counterparty assets at a glance
- 🔐 **Non-Custodial** — Your keys never leave your wallet
- 🔷 **Leather/Xverse Support** — Browser wallet signing with PSBT
- 📱 **Freewallet QR** — Scan to sign with Freewallet mobile app
- ⏱️ **Transaction Tracking** — Auto-poll mempool/confirmation status after broadcast
- ⚡ **Real-time Data** — Direct connection to Counterparty & Stampchain APIs

## Quick Start

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Run lint + unit tests
npm run lint
npm run test

# Run all quality gates
npm run check
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

Pull requests and pushes are automatically validated in CI using `npm run check`.

## How to Trade

1. **Connect Wallet** — Click "Connect Wallet" and choose:
   - 🔷 **Leather** or 🟣 **Xverse** — Browser extensions with PSBT signing
   - 📝 **Manual Entry** — Watch-only mode (requires Freewallet to sign)
2. **Quick Select** — Click XCP, BTC, PEPECASH, or RAREPEPE buttons
3. **Pick Market** — Browse dropdown showing active pairs with order counts
4. **View Depth** — See visual bid/ask walls and order book
5. **Create Order** — Fill in amounts and click "Create Order"
6. **Sign Transaction**:
   - **With Wallet**: Click "Sign with Leather/Xverse" — wallet prompts for approval
   - **With Freewallet**: Scan QR code → Tools → Sign Transaction → Broadcast, then paste txid to track status
7. **Done!** — Transaction is broadcast to the network

## Signing Methods

### Browser Wallet (Leather/Xverse)
When connected via browser extension, you can sign directly:
- Wallet receives a **PSBT (Partially Signed Bitcoin Transaction)**
- You review and approve in the wallet popup
- Transaction is broadcast automatically

### Freewallet QR Code
For mobile or watch-only addresses:
- QR encodes: `counterparty:?action=signtx&tx=<HEX>`
- Freewallet parses the unsigned raw hex transaction
- Sign locally with your private keys, then Freewallet broadcasts

## Project Structure

```
src/
├── App.tsx                    # Main application
├── lib/
│   ├── counterparty.ts        # Counterparty API v2 client
│   ├── stamps.ts              # Stampchain API client
│   └── wallet.ts              # Wallet connector (Leather/Xverse)
└── components/
    ├── AssetIcon.tsx          # Asset icons with Stamp detection
    ├── BalanceDisplay.tsx     # User balance panel
    ├── DepthChart.tsx         # Visual bid/ask depth
    ├── OrderBook.tsx          # Order table with icons
    ├── PairSelector.tsx       # Smart pair selector
    ├── QRSigner.tsx           # Multi-method signing modal
    ├── TradeForm.tsx          # Create order form
    └── WalletConnect.tsx      # Wallet connection button
```

## APIs

### Counterparty Core API v2
Base: `https://api.counterparty.io:4000/v2`

| Endpoint | Purpose |
|:---------|:--------|
| `GET /orders/{asset1}/{asset2}` | Fetch order book |
| `GET /assets/{asset}/orders` | Get markets for asset |
| `GET /addresses/{addr}/balances` | Get user balances |
| `GET /addresses/{addr}/compose/order` | Compose order tx (returns `rawtransaction` + `psbt`) |

### Stampchain API
Base: `https://stampchain.io/api/v2`

| Endpoint | Purpose |
|:---------|:--------|
| `GET /stamps/{cpid}` | Get stamp metadata & image |

## Tech Stack

- **Vite** — Fast dev server and build (~74KB gzipped)
- **React 19** — UI framework
- **TypeScript** — Type safety
- **qrcode.react** — QR code generation
- **Leather/Xverse APIs** — Browser wallet integration

## Version History

| Version | Features |
|:--------|:---------|
| v1.0 | Order book, depth chart, trade form, QR signing |
| v1.1 | Balance display panel |
| v1.2 | Asset icons with Stampchain enrichment |
| v1.3 | Smart Pair Selector with market discovery |
| v1.4 | Leather/Xverse wallet support, PSBT signing |
| v1.5 | Fixed Freewallet QR (Counterparty URI scheme), session persistence |

## Future Enhancements

- [ ] UI end-to-end test coverage (wallet/sign/broadcast flow)
- [ ] Favorite/recent pairs
- [ ] Testnet toggle
- [ ] Dispenser support

## License

MIT

## Credits

- [Counterparty](https://counterparty.io) — DEX protocol
- [Stampchain](https://stampchain.io) — Bitcoin Stamps metadata
- [Freewallet](https://freewallet.io) — Mobile signing (Counterparty URI scheme)
- [Leather](https://leather.io) — Bitcoin browser wallet
- [Xverse](https://xverse.app) — Bitcoin browser wallet
