# StampySwap repair handoff after review of 621499e

Target reviewed: `621499e6c6ac2a1e4e2f2e1b3ea7489da187b66a`. This plan supplements the original F01–F10 plan. It is not approval to reopen custody. No repairs were implemented by this audit.

## Instructions to the implementing AI

Preserve the fixes that passed verification: excess-source-precision rejection, rejection before consuming an unsupported-chain deposit, real burner-signature checks on public redemption, normalized fresh-burn replay protection, and operator restrictions on Counterparty minting/moves/demo swaps. Work from current GitHub source; if it has advanced beyond the reviewed SHA, list and review those changes first.

Do not mark a finding fixed merely because its usual URL returns 503, an operator restriction hides it, or database-only proof-of-reserves reports solvent. Distinguish root-cause fixes, temporary restrictions, and operational evidence still missing. Prepare small reviewable commits/PRs. Do not enable custody or deploy a real-value canary as part of ordinary code changes.

The first task is **A: repair containment and remove legacy mutation**, followed by **B/C: durable recovery and historical migration**. F04 and F05 should remain restricted until their public protocols are implemented. No new mainnet funding is needed for the local repair work.

## A — Immediate containment and immutable deposits

Addresses R01 / F03. Highest priority.

1. Replace the separate URL-regex blacklist with route/router-level maintenance policy, or an explicit safe-route allowlist enforced consistently with Express dispatch. Apply it to all value/accounting paths and legacy GET/HEAD polling. Avoid a broad operator bypass into unsafe legacy code.
2. Remove or permanently disable legacy `/api/bridge/intent/:id/txid`, mutable intent polling/sweep, and accounting-only `/api/redeem`. Do not leave financial simulation paths connected to production collateral under a preview flag.
3. Make consumed deposit identity immutable. Use a dedicated source-event record and database constraints; a legacy ledger update must not be able to free a replay key.
4. Align rate limiting with the dispatched route, not raw path spelling. Keep public moves, Counterparty claims and protocol-funded operations restricted.
5. Have the deployment operator verify upstream access restrictions immediately if the deployed source matches this revision. The current app maintenance flag is insufficient by itself. Keep transaction history and database snapshots for reconciliation.

**Acceptance:** real HTTP tests through real Express middleware cover original paths, uppercase/mixed case, trailing slashes, HEAD/GET, prefixes and the actual proxy normalization. All blocked calls create zero database mutations and zero signer effects. A claimed deposit cannot be renamed/replayed under any configuration. Run tests with maintenance on/off, preview on/off and operator/non-operator roles; unsafe legacy routes remain unavailable regardless of those switches.

## B — Durable transaction execution and recovery

Addresses R02, R05 / F06, F07. Do not patch by deleting reservations on error.

1. Persist an operation identity containing action, authenticated owner, canonical asset, source network/event, exact quantity and authorized destination. Maintain states for verification, reservation, submission, confirmation, completion, definite pre-send failure and uncertain outcome.
2. Atomically reserve source entitlement and accounting effects in the database. Use durable cross-process coordination and uniqueness, not only in-memory locks. Validate recipient, source circulation, destination capabilities, precision and full/partial entitlement before reserving.
3. Before sending, persist the signed transaction and deterministic txid when possible. For a signer API that cannot provide this, require a recoverable operation ID or a reconciliation process before retrying an unknown result. If neither is available, keep the route disabled.
4. On a broadcast timeout, reset connection, malformed response or uncertain signing result, retain reservation and mark reconciliation-required. Never equate an exception or missing response txid with “nothing was sent.”
5. Resume legitimate claims after proven pre-send failures. Complete accounting after a confirmed external effect even if the prior database update failed. Rebroadcast the same known transaction when appropriate; do not construct a second payment blindly.
6. Apply this design to deposits, direct operator mints, moves, custody releases and stamp releases. Coordinate the single BTC vault's UTXOs across assets/protocols. A pending row alone does not implement recovery.

**Acceptance:** inject failures before signing, during signing, after broadcast acceptance but before response, after confirmation, between reservation writes, and during final accounting. Restart the process and retry each case. Two concurrent workers must produce one external effect per entitlement. Tests must reconcile actual mock-chain supply/releases against the ledger, not only compare response codes.

## C — Ship and verify schema/history migrations

Addresses R03 and prerequisite deployment correctness.

1. Commit the schema/migrations for the new burn registry, legacy burn column, operation records and uniqueness/immutability constraints. Add a schema version and fail startup or disable writes when required migrations are missing.
2. Backfill consumed events from historical `move-out` records whose burn hash is in `btc_txid`, prior redemption `burn_txid` records, and any other actual consumption history. Map identity consistently by network and event, and resolve ambiguous rows conservatively. Do not reinitialize the registry as empty beside an existing ledger.
3. Preserve pending/uncertain operations and audit their transaction outcomes. Supply redacted pre/post migration counts and evidence that old burns cannot be reused. If a backfill already happened outside Git, codify it and provide verification evidence; do not assume this audit proved it absent from production.
4. Catch unique conflicts separately from unavailable database/schema errors. Report a retry/reconciliation condition accurately instead of returning “already consumed” for every exception.

**Acceptance:** migrate an old database fixture with completed moves, completed redemptions, pending/failed releases, case variants and overlapping histories. Historical claims cannot release/mint again. Migration is idempotent, recoverable and preserves every existing obligation. Test both fresh installation and upgrade, including missing-column/table failure.

## D — Complete entitlement, burn authorization and finality rules

Addresses R04, R06 / F05, F10 and partial deposit handling.

1. Use event-level identity, including chain and event/message index where applicable. A transaction may contain multiple burns; do not discard unrelated legitimate entitlements under one txid.
2. Choose an explicit policy: exact full-event claims or tracked partial entitlement. Verify and persist exact integer amounts. A one-unit request against a ten-unit burn must either reject before reservation or leave an authenticated nine-unit remainder.
3. Derive stamp-bridge entitlement from the verified burn, or require authenticated partial claims with tracked remaining quantity. An observer must not be able to consume a victim's full transaction by requesting a small release to their public address.
4. Keep moves operator-only until the holder authorization is actually verified. The current `moveBindingMsg` is unused. Bind signatures to action/domain, source chain/event, canonical asset, exact amount, destination chain/address and appropriate replay controls. Decide supported contract-wallet/Solana authority cases explicitly; fail safely for unsupported ones.
5. Define and enforce per-chain finality. Persist event block hash and revalidate canonicality before release. Include appropriate L2 settlement assurance and Solana finalized state in the documented policy.
6. Use the actual source token's decimals. Correct SPL verification's fixed-nine-decimal assumption, reject unrepresentable BTC-native releases, and preserve any rounding remainder.

**Acceptance:** wrong owner/destination/action/chain fails; a consumed event cannot serve both move and redeem; partial and batched events conserve entitlement; shallow/reorged burns cannot authorize release; exact 0/8/18-decimal and actual SPL mint-decimal cases conserve units across the full lifecycle.

## E — Finish source attribution and canonical identity

Completes the restricted F04 workflow and remaining identity issues.

1. Replace Counterparty vault-balance entitlement with a verified individual send: exact protocol asset, source, destination, integer quantity, status and finality. Retain the operator restriction until this works.
2. Use canonical asset IDs/source protocol throughout deposit, redemption, move and AMM paths. Preserve `$` as part of identity; reject ambiguous bare tickers. The partial adoption of `resolveAsset` is not sufficient.
3. Bind deposit authorization to the exact source event and destination chain as well as recipient/quantity. Validate address and chain capabilities before consuming it.
4. Verify the actual serialized PSBT/envelope contents, allowed outputs, change, amounts and fees before signing. Do not trust adjacent JSON echoes as the security check.

**Acceptance:** a prior one-unit Counterparty depositor cannot claim another user's 100-unit send; protocol/name collisions never select the wrong backing; forged or mismatched transaction bytes cannot be signed; a valid deposit with invalid destination leaves recoverable entitlement.

## F — Make capabilities and the UI truthful, then complete mainnet support

Addresses R07 and the remaining portion of F08.

1. Centralize read-only status for maintenance, deposits, minting, burns, redemption and liquidity, by asset/chain. Make `/api/status`, custody status, wrap routes, integrations and UI use it. Distinguish existing trading availability from availability to create new wrapped assets.
2. During maintenance, do not return a generic `enabled:true` wrap route or advertise `deposits_live:true`; include a machine-readable reason. Do not solicit new deposits into a route that cannot finish. Keep existing claim tracking and factual custody information available.
3. Implement the redemption client's required burn proof and owner-signature flow with the selected source chain, exact amount and recipient. It currently sends neither proof nor signature and always chooses Solana. Add an end-to-end test for the new API contract before enabling the UI.
4. Either finish Base-mainnet minting with the intended artifact/signer and liquidity implementation, or remove it from new-wrap capabilities until ready. Keep the early rejection guard that prevents claim consumption.
5. Preserve slippage protections; map reserves by actual token order. Pin the OpenZeppelin/compiler build inputs and declare directly imported dependencies. Verify the artifact against the intended/deployed bytecode before making deployment claims.

**Acceptance:** paused integrations do not solicit new deposits; the client completes a supported authorized redemption against a local mocked/forked chain; unsupported chain/address changes no ledger state; pool quantities and symbols match token order; mainnet capabilities are advertised only after tested end-to-end implementation.

## G — Evidence required for closure and reopening

1. Add ordinary prevention tests and CI in the repository, including tests derived from this audit. The supplied audit suite asserts vulnerable behavior for OPEN/NEW cases; reverse those expectations in the repaired application's regression tests. Do not celebrate a passing reproduction suite as evidence of safety.
2. Provide a finding-by-finding response: ID, status (fixed/restricted/open), commit, code location, test command/result, deployment/migration prerequisite and remaining limitation.
3. Reconcile actual historical deposits, mints, burns, releases, outstanding token supplies and LP-held balances. Include manually removed/retired representation rows. Database-only solvency and a small successful transaction are not sufficient evidence.
4. Triage the fresh dependency advisory report without forced major downgrades. Provide reachability analysis and reviewed resolutions. Add the missing schema/build/test reproducibility artifacts.
5. Document production signer policy, independent devices/approvals, backup/recovery and operator override scope. The implementing AI should not receive production private keys. Review deployment/proxy settings against the audited release SHA.
6. Submit the repaired revision, tests and redacted migration/reconciliation evidence for another independent review. Enable no public custody writes until the release blockers are closed. Any real-value canary or public reopening is a separate operational decision after verification.

## Reproduce this review locally

Use an isolated checkout of the exact reviewed SHA with its locked dependencies installed using `npm ci --ignore-scripts`. Set the source path and run a Node version with `node:sqlite` support and permission to listen on localhost:

```sh
STAMPY_AUDIT_SOURCE=/path/to/STAMPYSWAP-at-621499e node --test /path/to/review-tests.cjs
```

Verified local runtime: Node v23.4.0, Express 4.22.2. The suite loads no production keys, makes no RPC/indexer requests and submits no live transactions. It runs localhost HTTP requests through real Express with mocked chain effects and an in-memory database. The only fixed private keys in the harness are publicly known test fixtures and must never be funded.

Evidence accompanying this plan: `AUDIT.md`, `review-tests.cjs`, `test-results.txt`, `dependency-audit.json`, `source-sha256.json`. Transfer `AI-HANDOFF.md` for a single combined audit/plan file, or the full handoff ZIP to include runnable evidence.
