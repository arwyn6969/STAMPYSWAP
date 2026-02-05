# Integration Plan: Agent Skills & Intuitive Matching

## Strategic Decision: Integrate into STAMPYSWAP
We should **keep this in the STAMPYSWAP project**. 
- **Reasoning**: STAMPYSWAP is the UI/Interface layer. These Gists represent *logic* (finding matches, creating orders) that enhances the user experience. Splitting them into a separate project divides our focus. By integrating them, we turn STAMPYSWAP from a passive "Viewer" into an active "Agentic Interface".

---

## 1. "Find Open Orders" (Gist 200c..) -> The "Opportunity Matcher"
This script scans for open orders that want assets *you* hold. This is the backend logic for **Intuitive Matching**.

### Integration Plan
1. **Create `src/lib/agent/OpportunityMatcher.ts`**
   - Port the scanning logic from the Gist.
   - **Frontend Adaptation**: Instead of a CLI script, this becomes a function `findMatches(walletAssets, marketOrders)` that runs reactively in the Browser.
2. **UI Feature: "Active Matches" Panel**
   - A new sidebar or notification area: *"You have 500 PEPE. There are 3 active bids waiting for you!"*
   - Clicking these matches auto-fills the **Trade Form** (linking to the `Intuitive Order Matching` plan).

---

## 2. "Bulk Order Creator" (Gist baf3..) -> The "Market Maker" Agent
This script handles bulk creation, UTXO management, and chaining (using unconfirmed outputs). This is powerful "Power User" functionality.

### Integration Plan
1. **Create `src/scripts/market_maker.js` (Server-Side/Local)**
   - Keep the original Node.js script structure for now in a `scripts/` folder.
   - This allows us to run "Agents" locally that work *on behalf* of the user while the UI is open.
2. **Future UI: "Bulk Trading Mode"**
   - Eventually, port the `UTXO chaining` logic to `src/lib/wallet.ts`.
   - **Benefit**: Allows the UI to submit 5 orders at once without waiting for block confirmations between each signature. (User experience upgrade: "Submit Strategy" vs "Submit Order").

---

## 3. The "Depth Sweeper" (User Goal)
This relates to visual matching.

### Integration Plan
1. **Enhance `OrderBook.tsx`**
   - **Logic**: When hovering an order, calculate the sum of all orders *above* it (for Buys) or *below* it (for Sells).
   - **Visual**: Highlight the "depth" bar to show how much of the book would be eaten.
   - **Action**: Clicking performs a "Sweep" calculation (Average Price) and fills the Trade Form.

## Roadmap
1. **Phase 1 (Immediate) [COMPLETED]**: Implement `OpportunityMatcher` logic in `src/lib`. Feature: "Highlight orders I can fill".
   - *Status*: Implemented `src/lib/agent/OpportunityMatcher.ts`, `src/components/OpportunityScanner.tsx`, and wired into `App.tsx`.
2. **Phase 2 (UI)**: Implement `OrderBook` interactivity (Depth Sweeper).
   - *Status*: Already present in `OrderBook.tsx`.
3. **Phase 3 (Advanced) [COMPLETED]**: Add `scripts/` folder for the Bulk Creator.
   - *Status*: Implemented `src/scripts/market_maker.js` (Node.js agent) with UTXO chaining logic.
   - *Action*: User must configure `.env` and run via command line.
