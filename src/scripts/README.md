# Market Maker Agent

This script allows for **high-speed bulk order creation** by chaining transactions in the mempool (using unconfirmed change outputs).

## Setup
1. Create a `.env` file in the project root:
   ```
   PRIVATE_KEY=your_wif_private_key_here
   ```
   *Note: This wallet must have some BTC for fees.*

2. Prepare your orders CSV (see `orders.example.csv`).
   - `give_asset`: Asset you are selling (e.g. XCP)
   - `give_quantity`: Amount
   - `get_asset`: Asset you want
   - `get_quantity`: Amount
   - `expiration`: Block duration

## Usage
Run the script from the project root using `tsx` (TypeScript Executor):

```bash
npx tsx src/scripts/market_maker.ts src/scripts/orders.example.csv
```

## How It Works
1. Reads your CSV.
2. Fetches UTXOs from mempool.space.
3. For each order:
   - Gets the order payload from Counterparty API.
   - Constructs a raw Bitcoin TX with `OP_RETURN` data.
   - Spends your active UTXO and creates a new Change Output.
   - **Chaining**: Immediately uses that new Change Output as the input for the *next* order, without waiting for a block confirmation.
   - Broadcasts to network.

## Risks
- **Mempool Chaining Limit**: Bitcoin nodes typically accept chains up to ~25 transactions deep. If you process >25 orders, the later ones might get rejected until a block is mined.
- **Fees**: Hardcoded to ~3000 sats/tx currently.
