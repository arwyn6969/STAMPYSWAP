# StampySwap audit — 2345961

Reviewed 21 September 2026. Exact commit: `2345961119c001d8cd286ab0ca6a108258d7c200`.

**Result: not ready for public custody use.** Ten source-level findings were confirmed in eleven offline reproductions. No live exploit was attempted. This review does not establish whether the live deployment has been exploited or whether it currently exposes these paths.

The audit used a clean detached checkout in `/private/tmp/stampyswap-audit-2345961`. The original local checkout is at `77dea9b` with pre-existing edits and was not used as the audit baseline. Only audit artifacts were added to that workspace. No repair PRs or deployments were created.

## Confirmed findings

### F01 — Critical: custody release does not require token ownership or a burn

[server.js:1356–1377](https://github.com/arwyn6969/STAMPYSWAP/blob/2345961119c001d8cd286ab0ca6a108258d7c200/server.js#L1356-L1377)

When custody-live is enabled, an anonymous caller supplies a ticker, quantity, chain and arbitrary Bitcoin destination. The handler checks aggregate circulating supply, then calls the vault release signer. It never verifies a holder signature, balance, burn or escrow. The subsequent database decrement is not an on-chain burn. A caller can release assets backing other holders, whose tokens remain outstanding.

Reproduction: an unauthenticated request releases 50 of 100 circulating units to the test attacker. No burn proof is supplied. **Fix:** disable this path immediately, then require an authenticated, finalized and uniquely consumed burn/escrow authorization bound to the destination.

### F02 — Critical: legacy redemption fabricates withdrawals without any custody gate

[server.js:985–1004](https://github.com/arwyn6969/STAMPYSWAP/blob/2345961119c001d8cd286ab0ca6a108258d7c200/server.js#L985-L1004)

`POST /api/redeem` accepts anonymous requests, decreases circulation and inserts a released-redemption ledger row without burning tokens or releasing collateral. This works independently of custody-live. It corrupts accounting and, for Counterparty, reduces net credited backing so existing vault assets become claimable again through the balance-delta path.

Reproduction: fabricated redemption of 100 units followed by a Counterparty claim mints 100 replacement units while original tokens remain on-chain. **Fix:** remove the legacy route; record only verified on-chain effects through the new redemption state machine.

### F03 — Critical: public deposit-txid editing defeats replay protection

[server.js:662–669](https://github.com/arwyn6969/STAMPYSWAP/blob/2345961119c001d8cd286ab0ca6a108258d7c200/server.js#L662-L669)

`POST /api/bridge/intent/:id/txid` has no authorization or pending-state check. Its update matches any deposit ledger row, including one already credited and minted. Renaming that row's transaction key frees the original key for another claim. A database unique index on the mutable key does not prevent this.

Reproduction: credit and mint a 10-unit SRC-20 deposit; change its stored txid; submit the same deposit again. Circulation becomes 20 against one actual 10-unit deposit. **Fix:** make source event identity immutable and separate legacy intents from consumed events. Remove the public mutation path.

### F04 — High: a past Counterparty depositor can claim other users' deposits

[server.js:1303–1315](https://github.com/arwyn6969/STAMPYSWAP/blob/2345961119c001d8cd286ab0ca6a108258d7c200/server.js#L1303-L1315), [counterparty.js:51–58](https://github.com/arwyn6969/STAMPYSWAP/blob/2345961119c001d8cd286ab0ca6a108258d7c200/counterparty.js#L51-L58)

The signature authenticates the caller's source address, but `sentToVault` only checks whether that address ever made a matching send. It does not bind the requested amount to that send. Mint entitlement is then calculated from the whole vault's uncredited balance.

Reproduction: a source with one historical deposited unit claims all 101 uncredited units. **Fix:** verify and consume individual protocol sends, including their actual quantities and source addresses. Aggregate balance is a reconciliation signal, not user entitlement.

### F05 — High: anyone can redirect another holder's cross-chain burn

[server.js:947–978](https://github.com/arwyn6969/STAMPYSWAP/blob/2345961119c001d8cd286ab0ca6a108258d7c200/server.js#L947-L978), [evm-mint.js:62–74](https://github.com/arwyn6969/STAMPYSWAP/blob/2345961119c001d8cd286ab0ca6a108258d7c200/evm-mint.js#L62-L74)

The move endpoint accepts a public burn transaction and an arbitrary destination. Burn verification checks contract and quantity but neither returns nor authenticates the burner. The first claimant wins the transaction-level replay check. The Solana verifier similarly checks mint and quantity without binding the destination to the holder.

Reproduction: a fixture receipt contains a victim's burn; the actual EVM verifier accepts it and the server mints the replacement to an unauthenticated attacker address. **Fix:** require holder authorization bound to the exact burn event, amount, destination chain and recipient, with shared consumption across redemption and moves.

### F06 — High: failed destination mints permanently consume valid claims

[server.js:967–977](https://github.com/arwyn6969/STAMPYSWAP/blob/2345961119c001d8cd286ab0ca6a108258d7c200/server.js#L967-L977), [server.js:1342–1348](https://github.com/arwyn6969/STAMPYSWAP/blob/2345961119c001d8cd286ab0ca6a108258d7c200/server.js#L1342-L1348)

Deposits are marked credited before minting succeeds. Moves decrement source circulation and consume the burn before the destination succeeds. A definite signer failure leaves these records in place; the next attempt is rejected as already processed, including the move path that explicitly calls the failure retryable.

Reproductions: inject a signer failure, restore the signer, and retry the same deposit or move. Both retries return 409 and no destination mint occurs. **Fix:** durable resumable operation state, distinguishing consumed source entitlement from completed destination execution.

### F07 — High: a database failure after minting can produce unrecorded excess supply

[server.js:863–920](https://github.com/arwyn6969/STAMPYSWAP/blob/2345961119c001d8cd286ab0ca6a108258d7c200/server.js#L863-L920)

Minting happens on-chain before circulation is persisted, without a durable operation/transaction recovery record. If persistence fails, the next mint sees stale circulation. An ordinary operator retry can mint the same amount again. Similar broadcast-before-record sequences in release paths require recovery treatment.

Reproduction: inject a database failure immediately after a successful 10-unit mint; retry the authorized mint. Two signer effects occur, but circulation remains recorded as 10. **Fix:** durable reservation and submission records plus transaction reconciliation; never blindly retry an uncertain on-chain outcome.

### F08 — High: Base mainnet wrapping is advertised but cannot execute

[server.js:1184–1195](https://github.com/arwyn6969/STAMPYSWAP/blob/2345961119c001d8cd286ab0ca6a108258d7c200/server.js#L1184-L1195), [evm-mint.js:8–13](https://github.com/arwyn6969/STAMPYSWAP/blob/2345961119c001d8cd286ab0ca6a108258d7c200/evm-mint.js#L8-L13)

The server includes `base-mainnet` in destination metadata and advertises it in wrap routes. `evm-mint.CHAINS` supports only Base Sepolia and Ethereum Sepolia, and loads only the legacy artifact. The deposit endpoint records a valid claim before `mintCritical` returns unsupported destination. Pool creation also only supports testnet chains. The final commit's Uniswap link does not complete these backend paths.

Reproduction: a valid Base-mainnet deposit claim returns 400 after inserting its confirmed deposit record. **Fix:** validate capability before claim consumption; implement and test the chain path with the intended artifact before advertising it.

### F09 — High: fractional ACME requests can mint more than was deposited

[server.js:1323–1325](https://github.com/arwyn6969/STAMPYSWAP/blob/2345961119c001d8cd286ab0ca6a108258d7c200/server.js#L1323-L1325), [server.js:1345–1347](https://github.com/arwyn6969/STAMPYSWAP/blob/2345961119c001d8cd286ab0ca6a108258d7c200/server.js#L1345-L1347)

Deposit matching truncates the request to source decimals via `acme.toBase`, but crediting and minting use the original higher-precision amount. For a whitelisted indivisible asset, a one-unit deposit satisfies the check for 1.9 units. Divisible assets also accept extra precision beyond eight source decimals.

Reproduction: one indivisible ACME unit leads to 1.9 EVM representation units. **Fix:** derive credit from verified integer source quantity and reject excess precision; preserve residual entitlement explicitly.

### F10 — High: a small anonymous stamp claim consumes a victim's entire burn

[server.js:1444–1473](https://github.com/arwyn6969/STAMPYSWAP/blob/2345961119c001d8cd286ab0ca6a108258d7c200/server.js#L1444-L1473)

The stamp bridge correctly sends to the on-chain burn source, but allows a caller-selected amount less than the burn. The source address is public and needs no signature. The first partial request consumes the whole transaction ID, so an observer can cause a small release and block the rightful remaining claim. Requires an enabled bridge and live custody.

Reproduction: request one unit against a victim's 100-unit burn, using the victim's public address; one unit is released and the later full claim returns 409. **Fix:** derive the full release entitlement from the burn or authenticate and track partial claims without discarding the remainder.

## Additional repair work identified by inspection

These observations are not counted among the ten reproduced findings:

- ACME redemption hardcodes `dec: 8` in `custody.js:131`; its API caller supplies authoritative base units only for Counterparty. Carry exact source decimals and verify the composed quantity for every protocol.
- `getAssetByTick` strips `$` and accepts multiple protocol rows without disambiguation. The qualified resolver is not consistently used by public custody/move paths. This can make ACME and similarly named assets unreachable or misidentified.
- Burn finality, mutable Solana decimals, per-process-only locks, shared Bitcoin UTXO spending, and replacement of an existing SPL mint on a failed lookup need explicit tests and fixes before reopening.
- `uniswap.js:98` uses zero minimum output; liquidity calls use zero minimum amounts. Add enforceable slippage bounds. Pool displays assume reserve order matches database token order.
- Safe/Squads demo signers are held together on the server. This is not independent operational approval. Database-only reserve reports cannot establish actual backing after accounting divergence or manual changes.
- The mainnet contract build requires an undeclared OpenZeppelin installation; the repository has no checked-in database schema/migrations or application test command.

## Verification and limits

- Eleven offline reproductions completed successfully against the target source. A passing reproduction means the defect was demonstrated, not that the implementation is safe.
- Harness runs the actual server route handlers, actual Counterparty/ACME adapters and actual EVM burn verifier in isolated VMs. It replaces the external database with an in-memory SQLite schema, networking with fixed fixtures, signing with effect collectors, and BIP-322 with assumed-valid signatures belonging to the named test sources. It does not test cryptographic correctness or bypass signatures. It invokes handlers directly; global rate middleware is not exercised. Each scenario uses only a few requests, below configured limits.
- The production database schema, possible external proxy restrictions, runtime flags, deployed bytecode, balances and historical transactions were not verified. Findings describe the repository behavior under their stated prerequisites.
- Syntax checks passed for 19 JavaScript files. No full deployment, live integration test or Solidity rebuild was performed.
- The current npm lockfile audit reported 21 affected package entries: five high, eleven moderate, five low. Several are inherited dependency reports; application reachability has not been established. Raw evidence is saved in `dependency-audit.json`.

Run the offline reproductions with a Node build supporting `node:sqlite` (the verified local runtime was `/opt/homebrew/bin/node`, v23.4.0):

```sh
STAMPY_AUDIT_SOURCE=/private/tmp/stampyswap-audit-2345961 /opt/homebrew/bin/node --test /Users/arwynhughes/Documents/STAMPYSWAP/audits/2345961/reproduce.cjs
```

Use the [repair plan](./REPAIR-PLAN.md) to begin with containment and then replace each vulnerable path with tested behavior.
