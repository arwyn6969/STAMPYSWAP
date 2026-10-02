# StampySwap repair plan

Status: ready to begin implementation. No repair PRs, source fixes, deployments, or live transactions have been made.

Audit target: `2345961119c001d8cd286ab0ca6a108258d7c200` of `arwyn6969/STAMPYSWAP`.

The audit confirmed 10 findings using 11 offline reproductions. This commit should not be opened to public custody use. This is evidence of defects in the source, not evidence that someone has exploited the live deployment.

## What you need to do

1. If the app currently accepts public deposits, mint requests, moves, or withdrawals, have the deployment operator put those workflows into maintenance mode. If they are already disabled, leave them disabled. The custody-live flag alone is insufficient: several vulnerable routes do not check it.
2. Preserve the current database, deployment configuration, transaction records, and securely held signer state for reconciliation. Do not reset balances, delete representations, or retire tokens by editing database rows.
3. Start with the containment change below. The remaining work can proceed as small, separately reviewed changes. No wallet funding or mainnet transaction is needed to develop these fixes.

Maintenance of the app does not stop trading in an already deployed Uniswap pool. Existing holders and pending claims need reconciliation before normal service resumes.

## Proposed PR 1 — Contain unsafe operations

Suggested branch: `codex/audit-containment`. Base it on a fresh checkout of the audited commit, or explicitly review any newer commits first. The existing local workspace is an older, unrelated checkout with uncommitted changes; do not reset it or use it as the repair baseline.

Changes:

- Introduce an explicit maintenance policy for all value-moving and accounting-changing routes, enforced before database writes or signer calls. Keep maintenance enabled while repair work proceeds.
- Disable legacy `POST /api/redeem`, which fabricates burns and withdrawals. Disable legacy intent mutation and polling paths, including `POST /api/bridge/intent/:id/txid`, `GET /api/bridge/intent/:id`, and the intent sweep until replaced or audited. A GET method does not make the current intent poll read-only.
- Close public access to protocol-funded mint, pool, demo-swap, and authority-management operations. Remove or disable public preview hooks in production; do not allow them to fabricate backing for live assets.
- Hide deposit instructions and unsafe actions in maintenance mode; show a clear service-status message. UI hiding must accompany server enforcement.
- Keep only an explicitly reviewed list of read-only discovery/status endpoints available. Do not assume every GET route is safe.

Acceptance: anonymous requests to every blocked route produce zero ledger changes and zero signer calls. Test custody-live both on and off, preview mode both ways, route variants, and background tasks. Existing records remain intact.

## Proposed PR 2 — Make deposits attributable and immutable

Addresses F03, F04, F09 and the asset-identity follow-up.

- Identify an asset by canonical ID and source protocol; preserve exact ticker identity, including `$`. Apply this consistently to all deposit, redemption, move, and pool paths.
- Store immutable source events keyed by network, protocol, transaction ID and event/message index as appropriate. Enforce uniqueness in the database. Normalize transaction IDs before comparison.
- Replace Counterparty's aggregate balance-delta claim with verification of the exact send: source, destination, asset, amount, successful protocol status, and required confirmations. A historical deposit must not authorize claims on later deposits.
- Calculate credited quantities from the verified event in integer source units. Reject unrepresentable fractions; never compare a rounded source quantity and then credit the larger original request.
- Bind authorization to the source event, asset, amount, destination chain, recipient, action and replay controls. Validate the chain, recipient and capability before consuming a claim.
- Define how partial deposits and destination rounding are handled: either claim the full event once and retain explicit residual credit, or track remaining entitlement. Never silently discard the remainder.

Acceptance: a one-unit depositor cannot claim 101 units; a consumed deposit cannot be renamed and replayed; one indivisible ACME unit cannot mint 1.9 units; protocol/ticker collisions resolve deterministically; concurrent requests consume one event once.

## Proposed PR 3 — Require authorized burns for releases and moves

Addresses F01, F02, F05, F10.

- Replace accounting-only redemption with a verified on-chain burn or escrow protocol. Authenticate the holder's authorization and bind it to the destination Bitcoin address or destination-chain recipient.
- Have burn verification return the actual owner/authority, token, quantity, event index, network and finality evidence. Merely finding a transfer-to-zero event is insufficient authorization.
- Use the same durable burn-consumption registry for redemption and cross-chain moves, so one burn cannot authorize both.
- For the stamp bridge, derive the full entitlement from the verified burn or track an authenticated remaining entitlement. An anonymous one-unit request must not consume a 100-unit burn.
- Release only after required source finality and claim validation. Store exact quantities and reconcile destination protocol acceptance, not merely Bitcoin broadcast success.

Acceptance: another person's burn cannot mint to an attacker's address; no burn means no release; one burn cannot be spent twice across endpoints; partial-claim front-running cannot strand the remaining entitlement; reverted/unfinalized burns fail closed.

## Proposed PR 4 — Make operations recoverable without double execution

Addresses F06 and F07; apply the same design to withdrawals and stamp releases.

- Add durable operation records with states such as verified, reserved, submitted, confirmed, completed, retryable and reconciliation-required. Store the immutable authorization, expected effect and transaction identity.
- Commit reservation and accounting changes atomically within the database; enforce coordination across processes. In-memory asset locks alone are insufficient after restart or across instances.
- Persist transaction identity before broadcasting where the signer supports it. Recover by inspecting that transaction. If a signing API times out without a recoverable transaction ID, mark the outcome uncertain and reconcile before another send.
- Do not roll back the claim blindly or send a second transaction after an ambiguous response. Database and blockchain execution cannot be made atomic by a database transaction alone.
- Allow the same legitimate claim to resume after a definite pre-broadcast failure. Record on-chain success even when a subsequent database write fails.
- Serialize spending of the shared Bitcoin vault's UTXOs across assets and protocols.

Acceptance: fault-injection tests cover crashes and outages before signing, after signing, after broadcast, after confirmation, and during database writes. Restart/retry never duplicates a mint or release and never permanently blocks a valid failed claim.

## Proposed PR 5 — Complete chain integration and quantity handling

Addresses F08 and related implementation gaps.

- Centralize chain capabilities: chain ID, RPC, signer, token artifact, explorer, decimals, finality, mint, burn, redemption and liquidity support. Advertise only implemented capabilities.
- Wire Base mainnet minting to the intended OpenZeppelin artifact and supported signer path. Wire mainnet liquidity to Uniswap, including nonzero minimum outputs and liquidity limits. Add explicit gas handling where required by the signer.
- Pass source decimals through ACME redemption and verify the exact composed quantity. It currently hardcodes eight decimals and the caller omits authoritative ACME base units.
- Use each existing SPL mint's actual decimals for verification and minting. Do not replace an existing mint merely because an RPC lookup temporarily fails.
- Map Uniswap reserves using on-chain token order instead of assuming database A/B order. Update stale testnet labels and remove unsupported controls.
- Pin build inputs, explicitly declare directly imported dependencies, and make the mainnet contract build reproducible. OpenZeppelin is required by the build script but absent from the package manifest/lockfile.

Acceptance: a supported Base mainnet request reaches the correct implementation in a local fork; an unsupported request changes no state; 0/8/18-decimal cases and large SPL supplies behave correctly; quoted reserves match token order; adverse price movement trips slippage limits.

## Proposed PR 6 — Reconcile existing state and establish release gates

- Inventory every historical deposit, mint, burn and withdrawal, including manual operations. Compare the ledger with actual protocol balances and token supplies; account for tokens held in LP pools.
- Investigate differences before adjusting anything. Deleting a representation from the database does not destroy its on-chain tokens. The repository notes describe retiring Sepolia rows; assess whether those surviving tokens still carry any redemption entitlement.
- Replace database-only proof-of-reserves assertions with independently reconciled backing and supply evidence, explicit freshness, and an unavailable/uncertain state when evidence is missing.
- Review finality/reorg handling, PSBT contents and fee limits, and the external signing/indexer trust boundary. Never sign an unchecked third-party transaction solely because accompanying JSON repeats the requested parameters.
- Triage the saved dependency audit: 21 affected package entries, including five high-severity entries. These include transitive/inherited reports and are not 21 confirmed exploitable application bugs. Avoid `npm audit fix --force`; some suggested fixes are major downgrades.
- Establish independent production signers. The current Safe/Squads demo code stores multiple signer keys on the same server and cannot provide independent approval.
- Add CI for regression, failure-recovery, contract-build and dependency checks. The audited package has no test script or checked-in database migrations/schema.

Acceptance: no unexplained reconciliation differences; every confirmed finding has a prevention test; recovery tests pass after restart and concurrent calls; deployed code/config matches the reviewed revision. Complete independent review before public reopening. Any real-value canary is a separate, explicitly approved operational step after these gates pass.

## Evidence and first implementation task

- [Audit findings](./AUDIT.md)
- [Offline reproductions](./reproduce.cjs)
- [Recorded results](./reproduction-results.txt)
- [Dependency advisory snapshot](./dependency-audit.json)

The next engineering task is **PR 1: containment**, with prevention tests. The remaining fixes build on that safe baseline. Keep the reproduction harness as evidence for this commit; new regression tests must assert that the repaired behavior rejects the exploit, rather than preserving the current vulnerable behavior.
