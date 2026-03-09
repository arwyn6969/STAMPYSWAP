# STAMPYSWAP

Non-custodial Counterparty DEX workspace for Bitcoin Stamps, XCP, and other Counterparty assets.

The current app is organized around one workflow: choose a market, understand the book, shape an order, sign it, and track it. It also includes a portfolio-driven batch listing flow for listing multiple held assets one by one.

## Quick Start

```bash
npm install
npm run dev
npm run check
```

Open [http://localhost:5173](http://localhost:5173).

`npm run check` runs the full local quality gate:

- `npm run lint`
- `npm run test`
- `npm run test:e2e`
- `npm run build`

CI runs the same `npm run check` command on pushes and pull requests.

## Product Surface

### Trading Workspace

- `Pair Selector` and `Watchlist Toolbar` choose the active market.
- `Trade Form` is the primary action surface for composing an order.
- `Order Book` supports explicit `Fill`, `Sweep`, and `Copy` actions.
- `Market Depth` provides chart context and collapses on smaller screens.

### Portfolio And Batch Listings

- `Your Portfolio` loads Counterparty balances for the connected address.
- Holdings can be searched, sorted, and filtered.
- Selected assets stay visible in a sticky action area.
- `Batch Listing Plan` turns the current selection into sequential sell orders that are signed individually.

### Utility Panels

- `Sell Matches` scans open orders for actionable sell-side opportunities from the selected portfolio asset.
- `Buy Watchlist` tracks wanted assets and scans for attractive asks.
- `Order History` shows account-level activity and can jump back into a previously traded pair.

### Signing And Tracking

- `Leather` and `Xverse` can sign directly when a PSBT is available.
- `Watch-only` mode supports manual address entry and QR signing through Freewallet.
- `Transaction Center` tracks broadcasted transactions, exposes refresh errors inline, and links to the correct explorer for mainnet or testnet.

### Network Support

- Mainnet and testnet are switchable from the header.
- Explorer links and API requests follow the active network.

## Trading Flow

1. Connect a wallet with Leather, Xverse, or watch-only manual entry.
2. Pick a market from quick pairs, the search selector, or the watchlist.
3. Use the order book, scanners, or portfolio selector to prefill intent.
4. Review the order in the trade form and submit it for composition.
5. Sign directly in-wallet or scan the Freewallet QR flow.
6. Track the resulting tx in `Transaction Center`.

For portfolio-driven selling:

1. Connect a wallet.
2. Select one or more assets in `Your Portfolio`.
3. Open `Batch Listing Plan`.
4. Build the batch and approve each composed order sequentially.

## Architecture

The frontend is a Vite + React 19 + TypeScript single-page app.

```text
src/
  App.tsx                    # Workspace composition and cross-context wiring
  components/                # UI sections (order book, trade form, portfolio, scanners, drawers)
  contexts/
    WalletContext.tsx        # Connected address and signing capability
    MarketContext.tsx        # Active market, order state, batch queue state
    TransactionContext.tsx   # Tracked tx lifecycle state and refresh polling
  hooks/                     # Watchlist and wishlist persistence
  lib/
    counterparty.ts          # Counterparty API client, retries, parsing, testnet switch
    explorer.ts              # Network-aware explorer URLs
    queryCache.ts            # Shared in-memory query cache
    quantity.ts              # Base-unit and display-unit conversions
    stamps.ts                # Stampchain metadata and icon helpers
    wallet.ts                # Leather/Xverse/manual wallet integration
  scripts/                   # Order-broadcast utility runtime used outside the browser app
tests/
  e2e/                       # Playwright flows
  *.test.ts                  # Node-based logic and parsing tests
```

## External Services

- Counterparty Core API v2 for orders, balances, compose, and account history
- Counterparty testnet API when the header toggle is enabled
- Stampchain API for stamp metadata
- XChain icon endpoints for asset thumbnails
- mempool.space and Blockstream as transaction-status explorer fallbacks
- Leather and Xverse browser wallet providers
- Freewallet via Counterparty QR signing URI

## Scripts And Operational Tooling

The browser app does not depend on the market-maker scripts at runtime.

- App runtime: `src/`, `tests/`, `public/`
- Operational tooling: `scripts/` plus `src/scripts/market_maker.ts`

If you are looking for the separate market-making workflow, start with [scripts/README_Botless_Market_Making.md](./scripts/README_Botless_Market_Making.md).

## Handoff Docs

For the Stampchain handoff packet, see [docs/stampchain-handoff.md](./docs/stampchain-handoff.md).
