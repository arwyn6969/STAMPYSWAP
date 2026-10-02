# StampySwap follow-up audit — 621499e

Reviewed: 21 September 2026. Repository: `arwyn6969/STAMPYSWAP`.

**Exact revision:** `621499e6c6ac2a1e4e2f2e1b3ea7489da187b66a`, verified against GitHub main at the start and end of this review. Compared with the original audit at `2345961119c001d8cd286ab0ca6a108258d7c200`.

**Decision: do not reopen public custody workflows.** Several targeted fixes are correct, but maintenance containment is bypassable and important accounting/recovery defects remain. This is a source review with local reproductions, not a claim that the deployed service has been exploited.

The review exercised **26 local checks** using real Express routing/middleware, real BIP-322 deposit signatures and real EIP-191 redemption signatures. All evidence checks completed successfully. A test labeled OPEN or NEW passes when it reproduces a defect; a green test run is therefore not a release approval.

## Disposition of the original findings

| Original finding | Current disposition | Evidence / remaining work |
|---|---|---|
| F01 — public custody release without burn | Original no-burn attack blocked; redemption still not cleared | Missing burn and wrong-owner signatures are rejected. Correct signatures and new-burn replay protection work. R02–R06 below still affect release safety. Operator bypass deliberately remains. |
| F02 — fabricated legacy redemption | Public live-mode restriction verified; legacy operation retained | Live-mode anonymous requests return 403 even through a maintenance URL bypass. Preview/operator paths can still fabricate accounting. Retire this route instead of treating its remaining write path as a verified withdrawal. |
| F03 — deposit txid rewrite/double credit | **Still exploitable in local default-maintenance configuration** | Legacy mutation is unchanged. Case/trailing-slash routing bypasses allow a deposit to be credited twice; see R01. |
| F04 — Counterparty claim on other users' balances | Contained by an effective operator check, not repaired | Public requests return 403 after maintenance bypass. Operator path still uses aggregate balance delta; transaction-level entitlement is not implemented. |
| F05 — stealing another holder's move | Public move contained, not implemented as a user-authorized flow | Anonymous move returns 403. Operator move still accepts an arbitrary destination without a holder signature; `moveBindingMsg` is defined but unused. Redemption now does verify the owner's signature. |
| F06 — failed mint consumes claim | **Still open** | Definite pre-send failures on deposits/moves still cause 409 on retry. Move now reserves the shared burn even before all remaining validations. |
| F07 — mint succeeds but database write fails | **Still open** | A failed circulation update followed by operator retry produces two mint effects while recording one. |
| F08 — advertised mainnet mint fails after credit | Claim-loss guard fixed; feature remains unavailable | Unsupported Base-mainnet claims now return 400 before crediting. Base mainnet is still advertised in wrap routes and is not in `evm-mint.CHAINS`. |
| F09 — excess ACME precision over-mints | **Original defect fixed in tested cases** | 1.9 units against an indivisible asset is rejected before credit; valid 1.0 remains accepted. This does not solve partial-claim remainder accounting. |
| F10 — partial stamp claim consumes full burn | **Still open** | With bridge/custody enabled, a maintenance URL variant lets an observer claim 1 against a victim's 100-unit burn; the remaining claim is blocked. |

Also improved by source inspection: ACME redemption now receives source decimals and expected base units; Uniswap sends have nonzero slippage limits; key loaders refuse implicit regeneration unless opted in; the legacy background sweep returns during maintenance. These improvements do not close the remaining release blockers.

## R01 — Critical: maintenance route matching differs from Express, exposing F03

**Type:** regression in containment, plus an unfixed original critical defect.

**Locations:** [server.js:31–44](https://github.com/arwyn6969/STAMPYSWAP/blob/621499e6c6ac2a1e4e2f2e1b3ea7489da187b66a/server.js#L31-L44), [server.js:690–696](https://github.com/arwyn6969/STAMPYSWAP/blob/621499e6c6ac2a1e4e2f2e1b3ea7489da187b66a/server.js#L690-L696).

The maintenance regexes match literal lowercase paths and, for most endpoints, no trailing slash. The installed Express 4.22.2 router accepts case variants and optional trailing slashes with this application's settings. The maintenance and rate-limit middleware inspect the original path while Express still dispatches these requests to the same handler.

**Local reproduction, maintenance ON, no operator token:** canonical `POST /api/custody/verify-deposit` returns 503. A valid signed request to `/api/custody/verify-deposit/` mints 10 units. `POST /API/BRIDGE/INTENT/<id>/TXID` renames its credited transaction key. The same real deposit submitted to `/API/CUSTODY/VERIFY-DEPOSIT` then mints another 10. A separate uppercase legacy GET poll also changes a pending record to confirmed during maintenance.

**Impact:** one deposit backs two representation mints despite the stated containment policy. This path does not require custody redemption to be live. Sender signatures work correctly but cannot compensate for a mutable consumed-deposit key. Actual exposure also depends on any deployed proxy controls, which were not inspected.

**Required fix:** enforce maintenance and authorization on the actual route/router, including legacy GET handlers, rather than a separately maintained string blacklist. Remove legacy deposit-key mutation and make consumed events immutable at the database level. Ensure rate limiting follows the same routing semantics. Test casing, trailing slashes, HEAD/GET, prefixes and proxy normalization.

## R02 — High: a broadcast exception incorrectly releases the burn reservation

**Type:** new unsafe retry behavior.

**Locations:** [server.js:1479–1487](https://github.com/arwyn6969/STAMPYSWAP/blob/621499e6c6ac2a1e4e2f2e1b3ea7489da187b66a/server.js#L1479-L1487), [custody.js:165–170](https://github.com/arwyn6969/STAMPYSWAP/blob/621499e6c6ac2a1e4e2f2e1b3ea7489da187b66a/custody.js#L165-L170). All custody adapters have a broadcast/response boundary.

The catch block assumes every thrown error means nothing was released. It marks the pending row failed and deletes the shared consumed-burn record. A node can accept a transaction and then the HTTP connection can fail before its response reaches the server. This is an unknown outcome, not proof of a pre-broadcast failure.

**Reproduction:** a mock broadcast records the external release then throws a response-connection error. The server deletes the burn reservation. With a nonunique legacy `collateral_ledger.burn_txid` column, retrying the identical valid authorization causes a second release effect. With a unique column, the second pending insert fails instead: no duplicate release in that schema, but recovery remains broken and the shared consumption marker was still removed after an uncertain send. Both schema cases are tested; the deployed constraints were not supplied.

**Required fix:** preserve the consumed event on any unknown signing/broadcast outcome. Persist the signed transaction/transaction ID or an equivalent durable signer operation identity, reconcile it, and rebroadcast the same transaction only when appropriate. Only explicitly proven pre-send failures may become retryable. Do not classify errors based merely on “no txid returned.”

## R03 — High, conditional migration risk: old burns are absent from the new replay check

**Type:** migration/replay gap; actual historical exposure requires reconciliation.

**Locations:** [server.js:982–987](https://github.com/arwyn6969/STAMPYSWAP/blob/621499e6c6ac2a1e4e2f2e1b3ea7489da187b66a/server.js#L982-L987), [server.js:1023–1033](https://github.com/arwyn6969/STAMPYSWAP/blob/621499e6c6ac2a1e4e2f2e1b3ea7489da187b66a/server.js#L1023-L1033), [server.js:1458–1469](https://github.com/arwyn6969/STAMPYSWAP/blob/621499e6c6ac2a1e4e2f2e1b3ea7489da187b66a/server.js#L1458-L1469).

The old move path consumed burns through `collateral_ledger.btc_txid`. The new paths consult only `consumed_burns`. No schema migration or historical backfill is committed. A production backfill may have been done outside this repository, but this audit cannot verify it.

**Reproduction:** place a previously completed move burn in the old ledger, leave the new table empty, then redeem that burn with a valid owner signature. The server releases collateral again. This succeeds even if the newer ledger burn column is unique, because the old move stored the source hash in `btc_txid`.

If the new table is missing entirely, `consumeBurn` catches the schema error and misleadingly reports “already consumed.” The repository likewise does not provide the new `collateral_ledger.burn_txid` migration.

**Required fix:** ship versioned DDL, startup schema checks and a reviewed migration of all previous consumption evidence. Preserve ambiguous pending/released operations for reconciliation. Distinguish unique conflicts from database/schema failures. Prove the production migration with counts and redacted reconciliation results before reopening.

## R04 — High: transaction-level consumption discards unclaimed burn entitlement

**Type:** new redemption regression and unchanged F10.

**Locations:** [evm-mint.js:67–73](https://github.com/arwyn6969/STAMPYSWAP/blob/621499e6c6ac2a1e4e2f2e1b3ea7489da187b66a/evm-mint.js#L67-L73), [server.js:1460–1472](https://github.com/arwyn6969/STAMPYSWAP/blob/621499e6c6ac2a1e4e2f2e1b3ea7489da187b66a/server.js#L1460-L1472), [server.js:1558–1587](https://github.com/arwyn6969/STAMPYSWAP/blob/621499e6c6ac2a1e4e2f2e1b3ea7489da187b66a/server.js#L1558-L1587).

Burn verification accepts an event amount greater than the requested amount, but the shared registry consumes the entire transaction. An owner who requests 1 from a 10-unit burn receives 1 and cannot later claim the other 9. The stamp bridge still permits an unauthenticated observer to perform the analogous partial claim to the victim's public address, stranding the rest of a 100-unit burn. Multiple burn events in one transaction also need distinct event identities.

**Required fix:** either require an exact full-event claim with representable output, or store and authenticate remaining entitlement. Key the event by network, transaction, token/protocol and event index as needed; share that entitlement across redemption and move. Reject invalid amounts before reserving anything. Do not silently floor a release and consume the higher amount.

## R05 — High: durable mint/move/release recovery remains unimplemented

**Type:** original F06/F07 remain open; newly added reservation alone is insufficient.

**Locations:** [server.js:893–950](https://github.com/arwyn6969/STAMPYSWAP/blob/621499e6c6ac2a1e4e2f2e1b3ea7489da187b66a/server.js#L893-L950), [server.js:1023–1035](https://github.com/arwyn6969/STAMPYSWAP/blob/621499e6c6ac2a1e4e2f2e1b3ea7489da187b66a/server.js#L1023-L1035), [server.js:1421–1427](https://github.com/arwyn6969/STAMPYSWAP/blob/621499e6c6ac2a1e4e2f2e1b3ea7489da187b66a/server.js#L1421-L1427).

Tests still reproduce a failed deposit mint that cannot be retried, a failed operator move that cannot be retried, and a mint whose failed database update permits duplicate issuance on operator retry. Move reserves a burn before checking source circulation and before destination validation, creating additional ways to consume an unusable claim. Release inserts the consumed event and pending accounting row in separate database operations; a failure between them strands a reservation. Finalization is likewise split.

**Required fix:** durable operation states and transactional database reservations, transaction reconciliation, and restart-safe recovery. Apply the same design to stamp release, which still broadcasts before recording consumption. Include multiple worker processes and shared Bitcoin UTXO coordination in tests. Never delete reservations merely to make a retry succeed.

## R06 — High: verified burns have no required finality before Bitcoin release

**Type:** outstanding earlier review observation, now explicitly reproduced.

**Locations:** [evm-mint.js:62–76](https://github.com/arwyn6969/STAMPYSWAP/blob/621499e6c6ac2a1e4e2f2e1b3ea7489da187b66a/evm-mint.js#L62-L76), [sol-mint.js:86–104](https://github.com/arwyn6969/STAMPYSWAP/blob/621499e6c6ac2a1e4e2f2e1b3ea7489da187b66a/sol-mint.js#L86-L104).

The EVM verifier requires a successful receipt but never checks confirmation depth or finalized status. A one-block fixture burn authorizes custody release. Solana is queried at `confirmed`, not a separately enforced release-finality policy. Raising ACME deposit confirmations does not harden these representation-burn paths.

**Impact:** release can occur before a burn is sufficiently final; a reorg can restore representations after underlying assets have been released. This is a protocol-policy gap, not a demonstrated live reorg exploit.

**Required fix:** explicit per-chain finality policies, stored block hashes/event identities, and revalidation before execution. For L2s, distinguish local receipt inclusion from the chosen settlement/finality assurance. Test pending, shallow, reverted, reorged and finalized events.

## R07 — Medium: API/UI capability state contradicts maintenance and the new authorization flow

**Type:** regression plus unfinished integration.

**Locations:** [server.js:1296–1317](https://github.com/arwyn6969/STAMPYSWAP/blob/621499e6c6ac2a1e4e2f2e1b3ea7489da187b66a/server.js#L1296-L1317), [public/index.html:711–721](https://github.com/arwyn6969/STAMPYSWAP/blob/621499e6c6ac2a1e4e2f2e1b3ea7489da187b66a/public/index.html#L711-L721), [custody.js:31–43](https://github.com/arwyn6969/STAMPYSWAP/blob/621499e6c6ac2a1e4e2f2e1b3ea7489da187b66a/custody.js#L31-L43).

The status endpoint reports maintenance, but wrap routes still return `enabled:true` for whitelisted assets, advertise unsupported Base-mainnet minting and provide deposit instructions. Custody status still hardcodes `deposits_live:true`. Integrations can continue directing users to deposit even after the main UI displays its banner.

The existing redemption form sends neither `burn_txid` nor `auth_sig` and hardcodes `chain:'solana'`. Running that actual UI function against the updated handler with maintenance off returns 401. Removing maintenance will not restore the user redemption flow.

**Required fix:** one shared capability/status model for the UI and all integration APIs. Suppress new deposit solicitation when unsupported/paused while preserving read-only tracking of existing claims. Implement the required burn-and-sign workflow or explicitly mark redemption unavailable until ready. Do not claim assets are safe or fully backed solely from database balances.

## Other unfinished work before public reopening

- Counterparty per-send attribution is still deferred. Keep its operator restriction until implemented and tested.
- Consistent canonical asset identity is still incomplete: some handlers use the new resolver, while redemption/move still use ambiguous ticker lookup that strips `$`.
- SPL burn verification still assumes nine decimals; existing mint lookup failures can trigger replacement mint creation. Use the actual mint and its decimals; fail on uncertain identity.
- Shared Bitcoin UTXO selection and independently validated PSBT/envelope contents remain unfinished. Echoed API parameters are not validation of signed transaction bytes.
- Mainnet mint/pool integration, correct on-chain token-order reserve mapping, and reproducible contract builds remain incomplete. The OpenZeppelin build dependency is still absent from the manifest/lockfile.
- The package still provides only a start script; no checked-in security regression suite, schema migrations or CI pipeline was added in the five reviewed commits.
- Dependency manifests/lockfile are unchanged. Fresh npm audit reports 21 affected package entries: five high, eleven moderate, five low. These include inherited transitive reports, not 21 demonstrated application exploits. Do not apply suggested major downgrades blindly.
- Production custody authority, historical reconciliation, deployed bytecode/config and multisignature operational controls were not inspected. Same-server demo signer keys do not provide independent approval; a reviewed user-controlled multi-device policy could be an alternative operational design.

## Scope, evidence and interpretation

All five commits between the original and new HEAD were reviewed. Testing used an isolated archive of the target and a locked `npm ci --ignore-scripts` install. Nineteen JavaScript files passed syntax checks. No live transaction, mainnet exploit attempt, production database change, PR or deployment was performed.

The local test suite runs the real Express router/middleware and actual updated handlers. It uses the actual EVM burn verifier and Counterparty/ACME adapters, with fixed RPC/indexer fixtures. EIP-191 and BIP-322 verification use real generated/test signatures. Mint/release effects are mocked and recorded; the database is an in-memory SQLite schema that models required columns and constraints. The production schema is unknown; R02 explicitly tests both possible uniqueness configurations. R03 assumes a historical burn was not backfilled and must be verified against production migration evidence.

The current local workspace remains at an older commit with unrelated edits, while the other AI's checkout may correctly be current. This audit makes no claim about that other checkout: GitHub HEAD is the authoritative review target.

Evidence files: `review-tests.cjs`, `test-results.txt`, `dependency-audit.json`, `source-sha256.json`. See `REPAIR-PLAN.md` for implementation order and acceptance criteria. The combined `AI-HANDOFF.md` contains both documents for transfer to the other AI.
