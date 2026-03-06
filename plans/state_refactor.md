# State Management Refactor Plan

> **Status:** Documented for future session  
> **Blocked by:** Component test coverage (needed to protect against regressions)

## Current Problem

`App.tsx` has **17 `useState` calls** and **10+ handler functions**. All props are drilled down through 11+ child components.

## Proposed Contexts

### WalletContext (`src/contexts/WalletContext.tsx`)
| State | Handler |
|:------|:--------|
| `userAddress` | `handleWalletConnect` |
| `walletCanSign` | `handleWalletDisconnect` |

### MarketContext (`src/contexts/MarketContext.tsx`)
| State | Handler |
|:------|:--------|
| `asset1`, `asset2` | `setAsset1`, `setAsset2` |
| `orders` | `fetchOrders` |
| `loading`, `error` | — |
| `lastRefresh` | — |
| `prefillOrder` | `handleOrderSweep`, `handleOrderCompete`, `handleOpportunitySelect` |
| `composeResult` | `setComposeResult` |

### TransactionContext (`src/contexts/TransactionContext.tsx`)
| State | Handler |
|:------|:--------|
| `trackedTxs` | `handleTransactionBroadcast`, `refreshTrackedTx` |
| `isDrawerOpen` | `setIsDrawerOpen` |
| `pendingCount` | derived |
| `handleDismissTx` | — |
| `handleClearCompleted` | — |

### Stays in App.tsx
| State | Reason |
|:------|:-------|
| `selectedPortfolioAssets` | Local to portfolio/cart UI |
| `isCartOpen` | Local UI toggle |
| `macroQueue` | Cross-cutting (touches compose + tx) — move to MarketContext |

## Migration Strategy

1. Create contexts with current logic lifted verbatim
2. Wrap `<App>` in providers in `main.tsx`
3. Replace prop drilling with `useWallet()`, `useMarket()`, `useTransactions()` hooks
4. Verify lint + build + tests at each step
