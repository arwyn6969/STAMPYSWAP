# Botless Market Making Strategy (DEX Seeding)

This directory contains utility scripts designed to safely construct automated Counterparty DEX market-making orders.

## Core Objective
The goal is to weaponize high-supply, liquid assets (like `FAUXCORNCASH` and `DANKROSECASH`) and historically issued assets (e.g. `WHITEYWOJAK`) to natively accumulate preferred reserve assets: **PEPECASH, XCP, and DANKMEMECASH**. 

Simultaneously, we aim to sweep the [FAUXbitcorn](https://fauxbitcorn.com) directory by providing continuous floor bids for all culturally significant Counterparty NFT cards.

## Scripts Overview

### 1. `fetch_high_supply.js`
**Purpose:** Analyzes the wallet to determine which assets represent the strongest liquidity pools.
**How it works:**
- It uses the standard `v2/addresses/{address}/balances` Counterparty endpoint algorithm.
- Supports pagination via `next_cursor` to fetch all 1000+ assets in a whale wallet.
- Sorts by normalized quantity and isolates the Top 10% highest-held supplies.
- **Usage:** Used primarily as an exploratory tool to identify which assets to dump into the `DEX` as Asks.

### 2. `generate_dynamic_orders.js`
**Purpose:** The central engine that algorithmically computes safe Bid/Ask orders to prevent instantaneous arbitrage losses. The generated `csv` file from this script is passed directly to the `market_maker.ts` broadcaster.
**How it works:**
- **Dynamic Valuation:** It relies on the true Counterparty DEX Execution history. It queries the `v2/orders/[A]/[B]?status=filled` endpoint to find the *last matched transaction* for a given trading pair. 
  - If a historical matched price is found, Bids are set slightly **below** the last price (to ensure a good deal), and Asks are set slightly **above** or at parity with the last matched price.
  - If NO trade history exists, the script relies on a hardcoded dictionary (`FALLBACK_PRICES`) based on estimated equivalent fiat evaluations (e.g., ~$10 value per asset). Currently set to 100 PEPECASH, 0.1 XCP, or 10 DANKMEMECASH per unit.
- **Batched API Limiter:** Because checking 500+ pairs sequentially triggers Cloudflare blocks and Counterparty API timeouts, it utilizes a chunked `Promise.all` rate limiter paired with an exponential backoff `fetchWithRetry` wrapper.
- **Phase 1: Issuance Listing ("The Shop Window")**
  - Identifies every asset in the wallet issued by `1AwS3wRFNCoymKs69BXjAA4VfgWvuKvx4j` with a balance > 10.
  - Composes Asks offering 1 unit of that asset in exchange for PEPECASH, XCP, and DANKMEMECASH.
- **Phase 2: FAUXBITCORN Sweeping**
  - Contains a hardcoded array scraped from the live `fauxbitcorn.com` frontend bundle (including `FAUXCORNKING`, `KERNELISLAND`, etc).
  - Composes Bids offering `DANKROSECASH` and `FAUXCORNCASH` in exchange for exactly 1 of the Faux cards.

## Execution Pattern
1. Run `node scripts/generate_dynamic_orders.js`
2. Review the resulting `fauxbitcorn_dynamic_orders.csv` to ensure sizes and prices align with overall portfolio risk.
3. Run `npx tsx src/scripts/market_maker.ts fauxbitcorn_dynamic_orders.csv` to loop through the generated orders, sign them, and broadcast them to the mempool.
