# Plan: Intuitive Order Matching

## Problem
The current STAMPYSWAP UI requires users to manually copy-paste or calculate prices to match existing orders. This is error-prone and slow.

## Solution
Make the Order Book interactive. Clicking an order auto-populates the Trade Form with the "Counter Order".

## Technical Implementation

### 1. `OrderBook.tsx`
- Add `onOrderSelect` prop: `(order: Order) => void`.
- Add a "Fill" action button to each row.
- Visual update: Hover effects to indicate interactivity.

### 2. `TradeForm.tsx`
- Add props to control the form state from the parent:
    - `selectedOrder?: Order`
    - `fillMode?: boolean`
- When `selectedOrder` changes:
    - **Logic**: Calculate the inverse.
        - If Order is SELL (Giving PEPE, Getting XCP):
            - Form `GiveAsset` = XCP
            - Form `GetAsset` = PEPE
            - Form `GiveQuantity` = Order `GetQuantity` (The amount they want)
            - Form `GetQuantity` = Order `GiveQuantity` (The amount they are selling)
    - **Price Protection**: Add a lock hint? "Matching Order #12344 at 0.5 XCP/PEPE".

### 3. `App.tsx` (The Controller)
- Link `OrderBook` to `TradeForm`.
- Handle the state transformation.

## Agent Skills (Proposed)
1. **"The Market Matcher" (Auto-Fill)**: 
   - A logic module that handles the math of partial fills.
   - Example: "I want to buy 500 PEPE". The skill scans the order book and says "You need to fill Order A (100), Order B (200), and part of Order C (200). Total Cost: 55 XCP."
   - This could be a UI feature or a standalone "Agent" that prepares the transaction.

2. **"Spread Hunter"**:
   - An analysis skill that notifies the user when the spread (difference between highest Buy and lowest Sell) is favorable for market making.

## Next Steps
1. Refactor `OrderBook` to be clickable.
2. Wire up `TradeForm`.
3. Test with local data.
