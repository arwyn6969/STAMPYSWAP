# Stampchain Handoff

Prepared for technical handoff on March 9, 2026.

## Purpose

This document is the transfer artifact for the current STAMPYSWAP frontend. It is intended to answer three questions quickly:

1. What exists?
2. What has been verified?
3. What is still risky or intentionally out of scope?

## Current Product Scope

STAMPYSWAP is a browser-based Counterparty DEX client. It is not a custody layer, matching engine, or backend service.

Current shipped surfaces:

- market selection through quick pairs, search, and watchlist
- trade composition through a primary trade form
- order-book-driven prefill with explicit `Fill`, `Sweep`, and `Copy` actions
- market depth chart
- portfolio-based asset selection
- batch sell planning through `Batch Listing Plan`
- sell-side and buy-side scanners
- order history
- QR signing and direct wallet signing
- transaction tracking drawer with explorer links
- testnet toggle

## Architecture

### Runtime Shape

- Vite + React 19 + TypeScript SPA
- Context-based state coordination rather than a global external state library
- Shared query cache for short-lived API reuse and request deduplication
- Browser-only runtime for the app itself

### Main State Boundaries

#### `WalletContext`

Owns:

- connected address
- whether the current connection can sign directly

Responsibilities:

- connect/disconnect lifecycle
- watch-only vs signing-capable mode

#### `MarketContext`

Owns:

- active pair
- order book state
- order prefill state
- composed transaction state
- portfolio selection state
- batch queue state
- batch failure state via `macroError`

Responsibilities:

- fetch orders for the active market
- prefill trade form from order book or scanners
- build sequential batch compose flow
- stop the queue cleanly on compose failure

#### `TransactionContext`

Owns:

- tracked transaction list
- transaction drawer visibility
- refresh / polling lifecycle

Responsibilities:

- track tx lifecycle after broadcast
- poll for status updates
- surface refresh failures inline
- notify market context after confirmations/broadcasts

### Directory-Level Overview

```text
src/
  App.tsx
  components/
    TradeForm.tsx
    OrderBook.tsx
    DepthChart.tsx
    PortfolioGrid.tsx
    ShoppingCartMacro.tsx
    OpportunityScanner.tsx
    BuyOpportunityScanner.tsx
    OrderHistory.tsx
    QRSigner.tsx
    TransactionDrawer.tsx
    PairSelector.tsx
    WatchlistToolbar.tsx
    WalletConnect.tsx
  contexts/
    WalletContext.tsx
    MarketContext.tsx
    TransactionContext.tsx
  lib/
    counterparty.ts
    explorer.ts
    queryCache.ts
    quantity.ts
    stamps.ts
    wallet.ts
tests/
  e2e/
  *.test.ts
scripts/
src/scripts/
```

## External Dependencies Actually Used

### Network / API Dependencies

- Counterparty Core API v2
  - orders
  - balances
  - compose endpoints
  - user order history
  - asset metadata
- Counterparty testnet API via the header toggle
- Stampchain API for stamp metadata
- XChain icon endpoint for asset icons
- mempool.space for tx status fallback and explorer links
- Blockstream for tx status fallback

### Wallet / Signing Dependencies

- Leather browser provider
- Xverse browser provider
- Freewallet QR signing URI flow for watch-only/manual signing

### Local Runtime Dependencies

- React 19
- TypeScript
- Vite
- Playwright
- ESLint

## Verified Flows

These are the flows currently covered by automated checks in the repo:

### Unit / Logic Coverage

- quantity conversion helpers
- counterparty parsing and compose handling
- order-book logic
- trade-form logic
- order-history counting logic
- explorer link behavior
- wallet validation
- transaction utility parsing
- opportunity matcher logic

### Browser Coverage

- watch-only connect and standard order composition flow
- portfolio selection and opening `Batch Listing Plan`
- mobile/touch order-book prefill flow
- testnet toggle behavior and network-aware explorer behavior
- batch compose failure path:
  - queue stops after the first failed compose
  - failure is shown inline and in-app
  - no browser alert is used
  - dismiss/reset clears the failure state

### Verification Command

Local acceptance command:

```bash
npm run check
```

This runs lint, unit tests, Playwright, and a production build.

## Handoff-Specific Changes In This Pass

- removed runtime browser `alert(...)` usage from batch compose failure handling
- added `macroError` and `clearMacroError()` to `MarketContext`
- surfaced batch compose failures inside the app UI
- preserved portfolio selection when a batch compose step fails so the plan can be reviewed and retried
- aligned README with the shipped interface and current terminology
- added this handoff document

## Known Limitations / Open Risks

### Product / UX

- The app is materially stronger on desktop than on very small screens, even after the mobile pass.
- The trading experience still assumes users understand Counterparty asset semantics and base-unit precision.
- Batch listings are sequential by design and remain operationally slower than a centralized order-entry system.

### Technical

- The app is API-dependent and does not provide an offline or self-hosted API mode.
- Query caching is in-memory only; it is designed for session responsiveness, not persistence.
- Explorer status is best-effort and depends on external public services when Counterparty status lookups fail.
- Stamp metadata and asset icon rendering depend on third-party endpoints that are outside this repo.

### Handoff Risk

- There is no analytics or production telemetry bundle in the repo, so priority decisions here are based on code inspection and test coverage rather than usage data.
- Wallet-extension behavior has automated coverage only for app-side flows; wallet popup approval UX still needs manual validation in a real browser profile.

## Manual QA Matrix

Recommended manual check before any public release by the receiving team:

| Area | Scenario | Expected Result | Status |
| --- | --- | --- | --- |
| Desktop signing | Connect with Leather | Direct-sign CTA appears and tx can be approved | Pending manual QA |
| Desktop signing | Connect with Xverse | Direct-sign CTA appears and tx can be approved | Pending manual QA |
| Watch-only | Manual address entry + QR signer | QR flow appears and manual txid tracking works | Pending manual QA |
| Portfolio | Select assets and open `Batch Listing Plan` | Selected assets remain visible and batch builder reflects holdings | Pending manual QA |
| Batch failure | Force compose error | Inline batch error appears, queue stops, no browser alert | Automated + pending manual QA |
| Mobile/touch | Fill from order book | Fill action works without hover and signer opens | Automated + pending manual QA |
| Testnet | Toggle testnet and compose/track tx | Requests and explorer links use testnet | Automated + pending manual QA |
| Transaction center | Refresh a tracked tx with a failing explorer/API response | Inline refresh error is visible | Pending manual QA |

## Market-Maker Script Notes

The market-maker and CSV-generation tools are not part of the browser app runtime.

Treat them as separate operational tooling:

- strategy/docs entry point: `scripts/README_Botless_Market_Making.md`
- broadcaster runtime: `src/scripts/market_maker.ts`

Important handoff distinction:

- browser app: safe to review as a frontend trading client
- market-maker tooling: operational scripts that can create and broadcast many orders and may rely on sensitive signing configuration outside the frontend flow

Do not describe the script tooling as part of the normal app UX or onboarding path.

## Suggested Next Steps For Stampchain Team

1. Run `npm install` and `npm run check` from a clean machine using the README alone.
2. Complete the manual QA matrix with real wallet extensions and a real mobile QR signing pass.
3. Decide whether the next iteration is product polish, operational hardening, or backend/API ownership.
4. Keep the market-maker scripts under explicit operational controls rather than folding them into the frontend release story.
