# STAMPYSWAP consolidated remediation plan

Current baseline: **`9689964dac19f4b45c5532a744bd3fd8dfe0daea`**, independently reviewed on 30 September 2026. The [latest release audit](2026-09-30-9689964/AUDIT.md) and [Emblem handoff](2026-09-30-9689964/EMBLEM-HANDOFF.md) supersede earlier current-status and sequencing statements below. Public custody remains no-go.

The current order is: (1) durable backing reservations and once-only accounting/recovery, B01–B05; (2) schema/history/disposition correctness, B06–B07; (3) complete Bitcoin signing validation, B09; (4) supported UI/network flows, reproducible builds/CI and deployment evidence, including B08; then an independent frozen-release-candidate review. Production containment and scope must be confirmed by the operator. Working installation/lint/tests are now verified; they do not close the newly reproduced runtime failures.

## Preserved planning context from 21 September 2026


Latest completed review: **`457dc9ad52bbe3aa9b1a36dd646fa6080c602e39`** on 21 September 2026. Use the [new audit](457dc9a/AUDIT.md) and [next repair batch](457dc9a/REPAIR-HANDOFF.md) for current findings and ordering. Custody remains no-go. The new batch prioritizes transactional reconciliation, historical operation-key migration, deposit/move recovery across workers, mandatory operation identities, durable stamp release, and a reproducible schema/test gate.

The remaining sections preserve the broader earlier remediation obligations. Their references to a *next verification of b09fa31* are historical: the current revision has now been tested, with improvements and remaining failures recorded above. They do not override the newer evidence.

Historical planning baseline: `b09fa31545e0e900ffa86ccb9ce1b20474ebe954`, verified against GitHub main at 16:18 UTC on 21 September 2026. That consolidation inspected the mint-regression patch without an independent runtime pass. Use the [audit register](AUDIT-REGISTER.md) for provenance. Earlier evidence remains preserved.

Recommended arrangement: Emblem implements the next batch; the local reviewer verifies the exact resulting revision. Keep public custody paused. The actual production maintenance state remains unverified by this planning task. No wallet funding or production keys are required for ordinary local repair/testing.

## Working rules

1. One implementation owner per batch. Work from a named commit, preferably on a reviewable branch, and include all test/migration/build inputs in version control. Existing records and source-event identities must be preserved.
2. For each finding, record: status, exact commit, code location, prevention test, command/result, operational prerequisite, and residual limitation. Use “fixed,” “restricted,” “open,” “regressed,” or “awaiting independent verification” precisely.
3. Keep the old reproduction suites as historical evidence. New prevention tests must fail on the defective behavior and pass on the corrected behavior. A green reproduction of an OPEN case is not clearance.
4. Treat each delivered commit as immutable review input. If main advances, identify the new commits and adjust review scope explicitly. Publish progress as completed/tested/blocked/next, rather than “still working” when execution has stopped.
5. A code change and a production release are separate milestones. Configuration, migration, historical reconciliation and signer controls require operational evidence.

## 0 — Establish the shared baseline and protect progress

Owner: builder and local reviewer, each for their own workspace.

- Pin `b09fa31` for the next verification pass; its appearance shows a response to the reported blocker. Record any subsequent commits explicitly without assuming they are verified.
- Preserve the older edited local project and the existing audit artifacts. Establish a permanent clean checkout for sustained local verification when work resumes; do not merge the current server into the older dirty React tree by accident.
- Agree the intended release scope per asset, chain and action. Unsupported workflows may remain disabled, but this must be explicit in both API and UI. Restricted features stay on the backlog and are not counted as fixed.
- Record deployed SHA and maintenance/custody settings through the operator, with secrets redacted. Confirm the scope of the operator override, including schema-readiness behavior.

Completion evidence: pinned source, named implementation owner, one findings register, explicit release scope, and operator-provided deployment/containment status.

## 1 — Verify the new mint patch and commit its tests

Owners: local reviewer verifies `b09fa31`; Emblem supplies missing tests and further fixes. First batch. Findings: R05, F06, F07. The new commit changes only source and project notes; it does not include a prevention suite.

- Verify the newly added `opKey = null` binding and review every caller, including `performMint` and pool/operator paths. The default fixes the ReferenceError but allows callers without a key to skip durable protection; define and test the intended guarantee for every enabled value-moving entry point.
- Make operation identity bind the immutable entitlement and validated action. Repeated requests with altered recipient, amount, asset or chain must not acquire a fresh entitlement accidentally.
- Verify the new uncertainty flags and deposit catch, then give execution outcomes an explicit durable contract: definitely not sent, submitted/unknown, confirmed effect, and accounting complete. An HTTP reconciliation flag without persisted recovery state is insufficient. Thrown errors and missing response fields must not imply “safe to delete the claim.”
- Preserve the real deposit and entitlement while making failed issuance resumable. If reservation is safely released after a proven pre-send failure, record that transition without erasing source evidence. Unknown external outcomes retain a reconciliation state.
- Add static undefined-name checks and tests that run the actual mint/deposit handlers with mocked signing/RPC and disposable database fixtures. This baseline code-quality check should run in CI.

Acceptance:

- A valid mint reaches the intended mocked signer without a ReferenceError.
- Repeating the same legitimate operation cannot mint twice; conflicting payloads are rejected.
- A definite pre-send failure is recoverable; an unknown outcome does not free entitlement.
- An exception after deposit recording leaves either a recoverable pending operation or a correctly completed one, never an unexplained “already credited” dead end.
- Return the exact commit plus runnable tests and outputs. Passing this batch restores a testable path; it does not close all of R05 or permit reopening.

## 2 — Finish durable recovery and schema/history migration together

Owner: Emblem implements; operator supplies migration evidence; local reviewer tests. Findings: R02, R03, R05, F06, F07.

- Commit versioned schema definitions, constraints and migration steps even if the production dashboard must apply DDL separately. Supply both fresh-install and upgrade fixtures.
- Mark readiness only after required schema, constraints and historical backfill have succeeded. Failure must keep affected operations unavailable; define how operator repair actions are constrained during incomplete migration.
- Reserve entitlement/accounting atomically in the database and coordinate across processes. In-memory locks and a unique operation key alone do not serialize all distinct claims against shared backing.
- Persist a recoverable transaction/signing-operation identity before irreversible execution where supported. If the signer cannot provide one, document a safe reconciliation mechanism and keep automatic retry disabled for uncertain outcomes.
- Separate confirmed external effect from completed accounting. Resume missing ledger/circulation writes exactly once after an on-chain success; cached success must not hide unfinished accounting. Do not swallow persistence failures.
- Apply the same design to deposit mints, operator mints, moves, custody releases and stamp releases. Coordinate shared Bitcoin UTXOs across assets and workers.
- Build an authenticated reconciliation workflow that checks transaction status and updates durable state with an audit trail. Do not unblock users by manually deleting reservations.
- Migration must carry forward historical burn consumption and unresolved operations without inventing circulation or discarding outstanding claims.

Acceptance: injected failures before/after signing, accepted broadcast with lost response, failed operation persistence, failed final accounting, process restart and two concurrent workers all conserve entitlement and external effects. Test missing schema, wrong constraints, failed/partial backfill, and idempotent upgrade. Supply redacted pre/post migration counts for the intended deployment.

## 3 — Complete entitlement, identity and finality

Owner: Emblem. Findings: F01, F03, F04, F05, F09, F10, R04, R06.

- Use canonical asset IDs, source protocol/network and exact integer amounts throughout; preserve tickers including `$`.
- Identify and consume immutable source events with appropriate transaction/event index and network identity. Counterparty claims must be based on a specific verified send, not a vault balance delta.
- Authenticate holder intent for moves and releases, binding owner, event, amount, action, destination chain and recipient. Share consumption across every route that can use the entitlement.
- Choose exact-full-event claims or authenticated residual entitlements. Partial or batched events must never strand the remainder.
- Use actual existing SPL mint decimals and stable token identity; an RPC lookup failure must not create a replacement mint. Define rounding/residual treatment explicitly.
- Define per-chain finality policy, including the desired L2 settlement assurance. Store block/event evidence and revalidate before release; confirmation-depth counters alone must not silently substitute for that policy.

Acceptance: wrong owner/destination/action/chain, partial/batched claims, identity collisions, 0/8/18-decimal cases, existing SPL decimals, shallow/reorged events, and concurrent consumption are covered by prevention tests. Every enabled public workflow has attributable entitlement. Any deferred workflow remains explicitly disabled.

## 4 — Validate what the signers actually authorize

Owner: Emblem and deployment operator; independent review required.

- Decode and validate the Bitcoin PSBT or envelope bytes before signing: network, expected protocol action/asset/quantity, inputs, recipient, change destination, outputs and fee bounds. Adjacent echoed JSON does not establish the contents of the transaction.
- Verify ACME envelope behavior and fee assumptions with deterministic fixtures and the intended protocol implementation. Keep failed/unknown signing results within the recovery design from step 2.
- Document actual authority for Bitcoin, Solana, EVM minting and contract deployment, plus operator overrides, credential scope, independent approval, backup and recovery. Demo multisig keys on one host are not independent authorization.

Acceptance: altered outputs, recipient, protocol payload, quantity or excessive fees fail before any signer call; correct fixtures succeed. Production signer policy and key/authority mapping are reviewed without giving production keys to the reviewing agent.

## 5 — Finish only the capabilities selected for release

Owner: Emblem. Findings: F08, R07 and integration follow-ups.

- Make API status, deposit instructions and UI controls use a shared asset/chain capability model covering maintenance, schema readiness, mint, move, release and liquidity support.
- Implement the redemption client's burn proof and owner-signature flow with the actual selected chain and exact quantity. Test the real client/API contract locally.
- Either complete and test Base mainnet mint/liquidity support or clearly keep those new-custody capabilities unavailable. Existing external pools do not prove the server can mint new representations.
- Correct provenance/network labels, actual reserve/token ordering and slippage behavior. Pin compiler, OpenZeppelin and other required build inputs; make contract artifacts reproducible.
- Triage the saved dependency findings, refresh them for the candidate revision, and document resolution or justified residual exposure. Avoid blind forced upgrades/downgrades.

Acceptance: no paused/unsupported workflow solicits a deposit; supported UI journeys complete against local mocked or appropriate isolated test infrastructure; unsupported requests leave no state changes; builds and regression checks are reproducible from a clean checkout.

## 6 — Verify the release candidate and reconcile existing obligations

Owners: independent reviewer and deployment operator; user/deployment owner decides release.

- Re-run the consolidated findings suite and broader regressions against one exact release SHA. Include real routing/middleware, caller variants, maintenance/custody/preview/operator combinations, background tasks, and deployment proxy behavior where relevant.
- Reconcile historical source deposits, mints, burns, releases, pending/uncertain operations, circulating supplies and pool-held tokens. Include manually retired database representations whose tokens may still exist on-chain.
- Verify migration completion, actual deployed code/configuration, signer policy, monitoring, and recovery runbooks. A database-only reserve report does not establish on-chain backing.
- Resolve unexplained discrepancies before reopening. If a subset is deliberately deferred, enforce its exclusion at the server and UI and retain its open findings in the register.
- Obtain separate review of custody and contract behavior before public real-value use. A successful small transaction is supplementary evidence, not a substitute for the preceding checks.

Acceptance: every finding affecting the enabled release scope has a verified resolution; excluded features are explicitly contained; recovery/migration/reconciliation evidence is complete; release configuration matches the reviewed revision; the deployment owner explicitly approves the scoped release. Until then, retain the no-go decision for public custody.

## Builder handoff to copy

> Please remain the implementation owner and keep custody paused. We have seen `b09fa31`, including the added mint parameter, uncertainty flags and deposit catch. Please commit its prevention tests and CI/static checks, review callers that still omit an operation key, and ensure reconciliation is persisted rather than only returned as an HTTP flag. Return the exact SHA, commands/results, finding-by-finding status and remaining limitations. We will independently verify this revision; do not mark R05 complete from the signature fix alone. Next address durable recovery and versioned schema/history migration together, including failed backfill/readiness, restart/concurrent workers, and completion of accounting after a successful external effect. The earlier audit requirements remain release gates; the short `07672db` checklist does not replace them.

This message is prepared for the user to relay. It has not been sent to Emblem by this task.
