# STAMPYSWAP independent re-audit — 21 September 2026

**Verdict: improvements verified, but custody is still not ready to reopen.** The latest recovery implementation has reproducible accounting and retry failures. Continue development with maintenance enabled; repair the recovery design before adding further live custody functionality.

Reviewed GitHub main: **`457dc9ad52bbe3aa9b1a36dd646fa6080c602e39`**, published 20:29:16 UTC and rechecked during this audit. Review inputs were the current source, Emblem builder's commit descriptions and `CLAUDE.md` notes, prior audit artifacts, and the unfinished `b164086` review harness. Private Emblem conversations, production configuration/database, actual vault balances, and deployed contract state were not inspected. There is no claim here of a live exploit or an already-insolvent vault.

The older edited local frontend at `77dea9b` is not the reviewed application. Source was cloned separately into `/private/tmp/stampyswap-audit-latest-20260921`; no application repairs, deployment, transaction signing, or production writes were performed.

## What changed and what passed

Since the register's `b09fa31` baseline, Emblem added stricter schema readiness, optional operation identities for additional mint callers, later operation completion, operator reconciliation, deposit/move recovery helpers, a shared in-process Bitcoin release lock, and provenance labels. The latest code change after `b164086` is limited to provenance labeling; it does **not** repair the recovery findings below. [Latest commit](https://github.com/arwyn6969/STAMPYSWAP/commit/457dc9ad52bbe3aa9b1a36dd646fa6080c602e39).

Verified locally:

- Maintenance blocks tested canonical, uppercase, trailing-slash, doubled-slash and query-string write variants. Retired legacy accounting/deposit-mutation routes return 410 even for operators and preview mode.
- An unready schema blocks operator writes; failed backfill does not grant readiness. Historical move burns are backfilled in the modeled valid schema.
- Public redemption requires a real burn and a matching owner signature. Wrong-owner and altered-destination signatures fail. Fresh redemption burns cannot be replayed through move.
- Unknown **ordinary redemption** broadcast outcomes retain the burn reservation. Retrying does not release again in the tested path.
- Base burn depth now rejects one confirmation and accepts the configured three. This verifies the code's threshold, not adequacy of every chain's finality/reorg policy.
- Exact indivisible ACME deposits work; excess precision and unsupported Base-mainnet mint destinations are rejected before credit.
- A failed destination mint with an explicit `UNFUNDED` outcome can resume a move without a second source decrement in the normal path. A supplied, unchanged operation key blocks reminting after a mint/accounting failure.
- New EVM provenance labels correctly distinguish SRC-20, Counterparty and ACME. Four label tests pass. Emblem explicitly acknowledges already-deployed representations retain their old labels; this patch is prospective.
- The shared Bitcoin lock serializes tested release callbacks across asset locks and survives callback rejection **within one process**. Both server custody-release call sites use asset-lock then Bitcoin-lock order. This is not persistent UTXO reservation or cross-worker coordination.

## Priority findings

These identifiers are specific to this review. They overlap prior F/R findings; do not add them together as independent bug totals. P1 = repair before custody reopening; P2 = significant correctness or release-engineering issue.

### A01 — P1: reconciliation can apply a circulation decrement twice

Locations: [server.js:1722–1728](https://github.com/arwyn6969/STAMPYSWAP/blob/457dc9ad52bbe3aa9b1a36dd646fa6080c602e39/server.js#L1722-L1728), with the same split-write boundary in [ordinary redemption:1660–1661](https://github.com/arwyn6969/STAMPYSWAP/blob/457dc9ad52bbe3aa9b1a36dd646fa6080c602e39/server.js#L1660-L1661). New reconciliation defect within R05.

The code assumes a pending/reconcile row means circulation has never been decremented. It updates circulation and terminal ledger state separately, so that assumption is false after an interrupted final write.

**Reproduction:** start with recorded circulation 100 and a 10-unit pending redemption. Reconcile as released, fail only the terminal ledger write: recorded circulation becomes 90 and the row remains pending. Retry: recorded circulation becomes 80, although the actual post-burn supply is 90. The next 10-unit mint is accepted against 90 available collateral, allowing actual supply of 100 against 90 backing in the fixture.

**Repair:** apply accounting and terminal state once in a database transaction, with an operation-specific unique accounting event or compare-and-set transition. Use the same finalizer for normal redemption and reconciliation. Repeating reconciliation after any interrupted write must not repeat the decrement. Operator authorization does not prevent this accidental failure.

### A02 — P1: recovery key changes ignore existing operation records

Locations: [recovery.js:15–16](https://github.com/arwyn6969/STAMPYSWAP/blob/457dc9ad52bbe3aa9b1a36dd646fa6080c602e39/recovery.js#L15-L16), [server.js:1555–1568](https://github.com/arwyn6969/STAMPYSWAP/blob/457dc9ad52bbe3aa9b1a36dd646fa6080c602e39/server.js#L1555-L1568), [move:1126–1134](https://github.com/arwyn6969/STAMPYSWAP/blob/457dc9ad52bbe3aa9b1a36dd646fa6080c602e39/server.js#L1126-L1134). Upgrade regression introduced by `b164086`.

Parent `5e49696` writes `deposit-mint:<deposit>:<chain>:<recipient>` and `move-mint:<burn>:<chain>:<recipient>`. New code looks up shorter identity-only keys. No corresponding operation-key migration is present. Consequently, “no operation found” does not establish that no mint was submitted.

**Reproduction:** seed the parent-format reserved operation, a confirmed deposit, and no circulation update because the old mint landed just before a database failure. A current retry ignores that record and mints again under a second key. Ten deposited units can now correspond to 20 actual issued units. A legacy move operation is similarly ignored during resume.

**Qualification:** production exposure depends on whether legacy records/effects exist; that database was not inspected. Even if none exist, that must be established before treating absence as safe.

**Repair:** migrate and reconcile all historical operation identities before serving writes; fail closed on aliases, collisions, uncertainty, or deposits/moves with unexplained legacy issuance evidence. Retain immutable request metadata and the original transaction evidence.

### A03 — P1, multiple-worker condition: one deposit request can delete another worker's backing

Locations: [server.js:1569–1589](https://github.com/arwyn6969/STAMPYSWAP/blob/457dc9ad52bbe3aa9b1a36dd646fa6080c602e39/server.js#L1569-L1589), [mint checks before reservation:938–959](https://github.com/arwyn6969/STAMPYSWAP/blob/457dc9ad52bbe3aa9b1a36dd646fa6080c602e39/server.js#L938-L959). R05 cross-worker work was already acknowledged as open; this is a concrete remaining failure.

**Reproduction using two isolated worker contexts and a shared SQLite database:** A inserts a confirmed 10-unit deposit and pauses. B sees the credit, resumes and mints 10. A resumes, fails the collateral check (which precedes the operation lookup), interprets the response as a definite failure and deletes the credit it originally inserted. Final database: circulation 10, confirmed collateral 0, completed mint operation present. The operation primary key did not prevent the deletion.

This reproduces even with the claimed primary keys and unique deposit constraint. It does not require two physical processes to model the interleaving, but it does require more than one independent in-memory lock domain in operation.

**Repair:** transactional deposit/operation ownership and conditional rollback; consult the operation before solvency checks or cleanup. An insertion by this request is not proof that no other worker used the credit. Enforce one worker as temporary containment if necessary, while implementing database-backed coordination and shared UTXO reservations.

### A04 — P1: failed-redemption recovery can permanently reconsume or strand the burn

Locations: [server.js:1734–1737](https://github.com/arwyn6969/STAMPYSWAP/blob/457dc9ad52bbe3aa9b1a36dd646fa6080c602e39/server.js#L1734-L1737), [startup backfill:2187–2189](https://github.com/arwyn6969/STAMPYSWAP/blob/457dc9ad52bbe3aa9b1a36dd646fa6080c602e39/server.js#L2187-L2189). New reconciliation behavior conflicts with migration.

Two reproduced schedules:

1. Marking the ledger failed succeeds, burn deletion fails, but the API reports `freed_burn:true`. The row is now terminal, so the same reconciliation endpoint refuses to repair it.
2. Both writes succeed and the burn is freed. Startup backfill then scans **all** redeem rows, including failed ones, and inserts that burn back into `consumed_burns`. The holder's retry is blocked after restart.

**Repair:** atomically resolve ledger and entitlement state, report actual outcomes, and make migration respect explicit failed/retryable dispositions. Preserve uncertainty separately. This is not permission to release an unknown broadcast's reservation.

### A05 — P1/P2: a consumed move marker does not prove its source decrement completed

Locations: [server.js:1121–1149](https://github.com/arwyn6969/STAMPYSWAP/blob/457dc9ad52bbe3aa9b1a36dd646fa6080c602e39/server.js#L1121-L1149), [mint checks:938–958](https://github.com/arwyn6969/STAMPYSWAP/blob/457dc9ad52bbe3aa9b1a36dd646fa6080c602e39/server.js#L938-L958). F06 is only partially repaired.

**Reproduction:** burn reservation succeeds, then the source circulation update fails. The retry sees the reservation and skips the decrement, even though it never happened. With fully allocated collateral the destination mint remains blocked; the API says `source_decremented:true` and encourages resumption despite unchanged recorded circulation. No destination operation exists to reconcile.

A second test completes a normal move and resubmits it. The collateral check executes before the completed-operation check and returns an insufficient-collateral/resumable error instead of cached completion. It does not remint in this schedule, but breaks the promised idempotent result and encourages futile retries.

**Repair:** commit burn reservation, source accounting and move state atomically; derive resume actions from explicit completed phases. Resolve completed or uncertain operations before preconditions for a new mint, and verify immutable amount/asset/chain/recipient metadata on retries.

### A06 — P1: operator mint still permits the original duplicate-mint failure

Location: [server.js:1027–1033](https://github.com/arwyn6969/STAMPYSWAP/blob/457dc9ad52bbe3aa9b1a36dd646fa6080c602e39/server.js#L1027-L1033). Original F07 remains open for this call shape.

`op_key` is optional. The route accepts omission and passes null, bypassing operation reservation entirely. A real-router local test submits an operator mint without the field, records the external mint, fails the circulation update, and retries: two mint effects are produced and one is accounted for. Supplying the same explicit key prevents the second effect in the companion test.

**Repair:** require durable identity at every value-changing entry point; bind it to the full request and reject mismatches. Account for outstanding uncertain issuance when determining available collateral. Passing keys from some callers is not complete coverage. The operator demo swap also remains a known unguarded caller.

### A07 — P1: stamp release still retries an unknown broadcast as a new release

Location: [server.js:1825–1834](https://github.com/arwyn6969/STAMPYSWAP/blob/457dc9ad52bbe3aa9b1a36dd646fa6080c602e39/server.js#L1825-L1834). Previously acknowledged open R05 release work; not a new discovery attributed to the label patch.

The stamp path broadcasts before recording its bridge operation. Its generic catch tells the user to retry. In the current full-router test, a mock signer/broadcast records release then throws a response error. No operation is written, and retry produces a second external release effect for the same burn. The new Bitcoin lock serializes these calls but cannot remember an uncertain first release.

**Repair:** reserve the release before signing, persist recoverable transaction identity, and reconcile uncertainty without producing a second transfer. Apply the same durable release design to ordinary redemption and stamp release. Production prerequisites include enabled stamp bridge and custody; default maintenance contains public access.

### A08 — P1 qualification: schema readiness does not verify required uniqueness

Location: [server.js:2172–2195](https://github.com/arwyn6969/STAMPYSWAP/blob/457dc9ad52bbe3aa9b1a36dd646fa6080c602e39/server.js#L2172-L2195). R03 remains only partially closed.

Startup selects three columns and runs backfill; it neither supplies versioned DDL nor verifies primary-key/unique constraints. Replacing `operations` and `consumed_burns` with same-column tables without primary keys still yields `SCHEMA_OK=true`; two reservations of the same operation both return fresh. This is a conditional migration/configuration risk, not proof that production lacks those constraints.

**Repair:** ship versioned migrations, verify all safety-critical constraints and versions, and provide historical reconciliation evidence. Audit assertions about unique keys must be enforced, not assumed.

### A09 — P2: the advertised test/lint gate is not reproducible from a clean install

Locations: [package.json:24–27](https://github.com/arwyn6969/STAMPYSWAP/blob/457dc9ad52bbe3aa9b1a36dd646fa6080c602e39/package.json#L24-L27), unchanged `package-lock.json`, `test-acme.js`.

`npm ci --ignore-scripts --no-audit --no-fund` fails because ESLint and its dependency tree are absent from the lockfile. Lint passes when ESLint 8.57.1 is provisioned separately; that workaround is not a successful project installation.

`npm test` reports 13 passing entries: eight recovery helper tests, four label tests, and the ACME smoke script. In this audit the smoke script reported missing lookups, no chain height, and `fetch failed`, yet passed. It lacks assertions requiring successful live checks. There are no committed handler/database failure tests or current workflow files, and GitHub reports no check runs/statuses for this SHA. Earlier visible Actions runs belong to the old frontend.

**Repair:** synchronize the lockfile, separate optional live smoke checks from deterministic assertions, and commit handler/SQLite fault-injection tests and a workflow that runs on the current application. The clean install must pass before claiming a reproducible gate.

## Other release gates still open

- **R04/F10 entitlement:** current router tests still accept 1 unit against a 10-unit representation burn and block the remaining 9. An unauthenticated observer can similarly make a partial stamp claim to the real burner's address, consuming the whole claim. Require exact-event amounts or persist authenticated remaining entitlement.
- **F04 and F05:** public Counterparty claims and moves remain operator-restricted. Transaction-specific XCP attribution and holder-signed move authorization are still unfinished.
- **R07/UI:** maintenance availability messages improved, but the current redemption form still sends neither `burn_txid` nor `auth_sig`, and hardcodes Solana. Executing that form against an enabled local handler returns 401. Base-mainnet mint wiring remains unavailable.
- **R05 operational recovery:** no general mint-operation reconciliation action or persistent signed-transaction recovery is implemented. `opComplete` logs persistence failures but still suppresses them; the reserved row may remain while the caller receives success. Default closure and logs do not establish completed recovery.
- **Signing/identity/finality:** independently decode and validate signed PSBT/envelope contents; finish canonical asset identity, correct Solana mint-decimal verification and mint identity handling, and explicit per-chain reorg/finality policy. Same-process serialization does not validate selected UTXOs or signer intent.
- **Production evidence:** deployed SHA/config, schema/migration results, source-event and on-chain supply reconciliation, and actual custody/approval control remain unverified. Database-only solvency messages are insufficient evidence.
- **Dependencies/builds:** fresh npm audit still reports 21 affected package entries: 5 high, 11 moderate, 5 low. These are advisory/dependency counts, not 21 demonstrated application exploits. Contract build reproducibility/OpenZeppelin inputs remain outstanding. No automatic dependency changes were applied.
- **Emblem input on balances:** the builder notes an unresolved ACME duplicate-holder-row display issue. This audit did not independently query live balances or validate its proposed correction.

## Evidence and limits

**41 independent evidence checks completed: 15 focused failure/interleaving checks and 26 real-Express route checks.** Counterexample/OPEN tests are green when they reproduce the stated defect; green evidence is not release approval. The repository's 12 pure unit tests also pass; `npm test` reports 13 including the non-asserting live smoke entry. All 23 standalone JS/MJS files pass syntax checks. Separately provisioned lint passes; clean `npm ci` fails.

The focused harness executes verbatim slices from the hash-pinned current `server.js`, with real in-memory SQLite and isolated worker contexts. Its signature stub tests binding construction, not cryptography. The router harness loads the complete current server with real Express 4.22.2, BIP-322/EIP-191 verification and fixed RPC/indexer responses. Actual signing adapters are replaced with recorded local effects; no vault keys are loaded. The fixture schema models the claimed primary keys and unique deposit key; A08 separately removes primary keys. Production schema remains unknown.

Router dependencies were reused from the previous audit installation. Its lockfile is byte-identical to the current lockfile (SHA-256 recorded below), so dependency reuse did not change the reviewed source or bypass the reported clean-install failure. Fixture schema assumptions and failure boundaries are visible in the scripts.

Artifacts: [focused harness](review-tests.cjs), [focused results](test-results.txt), [router harness](router-tests.cjs), [router results](router-test-results.txt), [pure unit results](unit-test-results.txt), [npm test output](npm-test-results.txt), [clean-install failure](npm-ci-results.txt), [lint output](lint-results.txt), [syntax results](syntax-results.json), [dependency advisories](dependency-audit.json), [source hashes](source-sha256.json), [GitHub evidence](github-evidence.json), and [repair handoff](REPAIR-HANDOFF.md).

No message was sent to Emblem. The handoff is prepared for review and transfer.
