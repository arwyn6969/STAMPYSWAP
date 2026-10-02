# StampySwap independent repair audit

**1 October 2026. Verdict: material fixes verified, but the claim that B01–B09 are all remediated is not supported. The revision is not yet suitable for a limited release candidate. This is a repair audit, not release clearance.**

Reviewed source: **`80963563fc7eb3ce1b30bd87d2c1dcb096393418`**, compared with **`9689964dac19f4b45c5532a744bd3fd8dfe0daea`**. GitHub main still pointed to the requested repaired SHA at the final source recheck. The repair is one commit changing ten files. [Commit](https://github.com/arwyn6969/STAMPYSWAP/commit/80963563fc7eb3ce1b30bd87d2c1dcb096393418), [saved GitHub evidence](github-evidence.json), [reviewed diff](repair-source.diff).

The specific B06 history failures and B07 constraint failures are fixed in the tested configurations. B08's missing authorization is fixed in local integration tests. The original B02 lost-response arithmetic defect is fixed. However, broader tests reproduce excess issuance, erased liabilities after restart, a failed reservation query treated as zero, and a new Bitcoin output-validation regression. B05 recovery also remains incomplete.

No application fixes, deployment, service restart, configuration changes, wallet connection or live value-changing request were performed.

## What was run

| Verification | Result |
|---|---|
| Fresh `npm ci --no-audit --no-fund` in the isolated checkout | Passed; 388 packages installed |
| `npm run lint` | Passed |
| `npm test` | **37/37 passed**, including all 14 new prevention tests |
| Mainnet contract generation | Passed; OpenZeppelin 4.9.6 installed; generated artifact exactly matches the tracked artifact |
| Root JS/MJS syntax | 20/20 passed |
| Previous 18-check auditor suite, copied and repinned to the repair | Six FIXED checks pass; all 12 OPEN checks fail, with an important UI-fixture qualification below |
| New independent whole-server and adapter checks | **39/39 checks completed: 31 positive verification checks and eight defect/residual reproductions** |
| Current-revision GitHub checks/statuses | Zero check runs and zero individual statuses returned; the empty combined `pending` result is not running CI |

**A passing OPEN test demonstrates a defect. It is not a safety pass.** Conversely, an old OPEN test failing does not establish that the entire finding is closed.

The old B08 test fails because its fixture lacks the newly added form fields; it never reaches its original request assertion. That failure is not proof of repair. Separate new tests execute the repaired form and actual EVM signing helper, perform both challenge and signed requests, and verify HTTP 401 followed by 200. The other eleven old OPEN failures align with the intended narrow behavior changes. The six prior-fix regressions remain green.

The original September evidence was preserved. This folder contains a separate copy of its assertions, a new source manifest, and an independent fixture with representation identity uniqueness enforced. The report's test counts do not imply exhaustive verification of all possible interleavings.

## Containment and the live site

The [public application](https://arwyn.party/stampyswap/app/) was inspected read-only in a browser. It displays a maintenance banner, says deposits/mints/redemptions are paused, and marks release as gated. **That public status is confirmed.** The repaired source also defaults to maintenance enabled, and independent local tests show public write variants blocked, retired routes blocked, and custody signing refused when the custody switch is off.

The precise deployed backend SHA, effective environment values, worker count and absence of the `.custody-live` file were not independently established. Ordinary programmatic GETs to the app/status paths returned 403, while the browser could render the application's status. Direct browser navigation to the status URL was client-blocked. No live write was sent to probe enforcement. A redacted operator snapshot is still needed for configuration attestation.

The new withdrawal chain and burn fields are already visible in the served frontend. This does not identify the backend process revision: serving changed static files and restarting the backend are separate events.

An additional UI limitation is visible: the main action buttons do not have disabled attributes despite the maintenance banner. The current `loadStatus` matcher looks for handler names in inline attributes, IDs or labels, while these buttons use event listeners and labels that do not match. This is a maintenance-UX defect, not a demonstrated backend bypass. Do not infer backend access from the enabled appearance. [Maintenance UI logic](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/public/index.html#L1058-L1068); [browser evidence](live-browser-observation.json).

Do not interpret the website's solvency or asset-safety text as independently verified chain-versus-ledger reconciliation.

## Finding by finding

The checked-in prevention tests referenced below are in [test/audit-b.test.cjs](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/test/audit-b.test.cjs#L1-L208). Additional test names refer to [independent-repair.test.cjs](independent-repair.test.cjs). “Fixed” is limited to the stated behavior; production migration and wallet staging remain separate.

| Finding and verified status | Source and prevention coverage | Residual limitation |
|---|---|---|
| **B01 Partially fixed; still open** | [Solvency snapshots and reservation](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L947-L982); [Lease lifecycle](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L1246-L1266). Builder test at line 18 and independent “lease expiry during an already-reserved mint blocks a competitor” pass. | Worker A can pause before its reservation, let B finish after lease expiry, then use its stale supply snapshot to issue again. **C01** reproduces 20 issued against 10 backing. |
| **B02 Original lost-response defect fixed; replacement accounting has a concurrency regression** | [Accounting events and finalization](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L1186-L1237). Builder test at line 34 passes. Six independent release boundaries cover failures before/after event, supply write and terminal status, followed by restart and retry. | An older absolute recomputation can overwrite a newer one. **C03** allows further issuance against an understated materialized supply. |
| **B03 Original false-completion case fixed; recovery incomplete** | [Representation creation and accounting](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L1032-L1065); [Mint repair](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L1999-L2006). Builder test at line 47 and independent insert-failure check pass: non-200, reservation retained, another mint blocked. | Mint reconciliation returns 409 when the representation row is missing and asks the operator to create/verify it elsewhere. More seriously, a created but incompletely materialized representation can lose its mint liability at restart: **C04**. |
| **B04 Partially fixed; still open** | [reservedBase](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L1173-L1175); [Mint reconciliation](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L1979-L2008). Builder test at line 61 and independent uncertain-mint/restart check pass. | Reservation-query errors are swallowed and interpreted as no reserved supply. **C02** permits a second mint against the uncertain first mint's backing. |
| **B05 Initial failure reporting fixed; move recovery incomplete** | [Release finalization](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L1233-L1237); [Move debit phase](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L1327-L1348); [Move reconciliation](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L1933-L1948). Builder tests at lines 74 and 84 pass. Release failure/restart checks recover once without hiding the row. | The move repair action changes the phase without repairing failed materialization. **C06** leaves a move unable to finish and removes it from the pending-move inventory. Startup liability loss in C04 is also incompatible with complete recovery. |
| **B06 Verified fixed for both reported history failures** | [Burn backfill](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L2583-L2595); [Aborted-row reuse](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L1327-L1334). Builder tests at lines 95 and 105 pass. Independent checks go further: an aborted move survives reboot and completes its retry; a NULL-status redeemed burn remains unusable after repeated migration. | Actual production history and migration results were not supplied. Accounting baseline migration has its own new C04 failure; that is distinct from these repaired burn predicates. |
| **B07 Verified fixed for the requested malformed-schema cases** | [Constraint checks](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L2509-L2569). Builder tests at lines 116 and 123 pass. Independent cases reject no-key locks, completed-only operation indexes, composite operation indexes and non-unique accounting events; the exact non-null predicate is accepted. | This is not validation of the actual production schema. No versioned schema/migration files accompany the revision, and the representation identity constraint assumed by creation is not one of the six startup gates. |
| **B08 Missing authorization fixed in local integration** | [Form handshake](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/public/index.html#L717-L783); [Chain signing helpers](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/public/wallet.js#L133-L152). Builder tests at lines 133 and 152 pass. Independent tests use the actual EVM helper plus real signature verification for both forms, and verify both Solana helper variants cryptographically. | Providers are local substitutes; no real wallet extension/staging journey was exercised. The old B08 harness's field error is not closure evidence. Maintenance control appearance remains misleading as noted above. |
| **B09 Original excessive-fee example rejected; finding remains open and has a regression** | [PSBT validation](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/custody.js#L205-L238). Builder test at line 183 and independent excessive-fee check refuse the 999,454-satoshi example before signing. | **C05** bypasses the non-vault value caps using a spendable script. Separately, an unrelated dust output with no data payload passes. Inputs are only declared values; full protocol semantics remain explicitly outside this batch and unverified. |

## New and remaining failures

P1 means repair before enabling the affected custody/issuance path. P2 here means an operational recovery gap that must be resolved or explicitly incorporated into a tested operator procedure. These findings overlap B identifiers and should not be added to them as unrelated bug totals.

### C01 P1 Stale supply can survive the lock and reservation sequence

**Source:** [server.js 947-979](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L947-L979). **Reproduction:** “OPEN C01/B01: stale supply snapshot before reservation survives an expired lease and overissues.”

Worker A reads circulation zero and 10 units of collateral, then pauses immediately before inserting its operation reservation. Its lease expires. B acquires the asset, mints 10, records circulation 10 and completes its operation. A resumes, inserts its reservation, and sees no other unfinished operation. Its solvency check still uses the previously read zero circulation. A mints another 10.

Both complete successfully. The fixture ends with 20 minted against 10 backing. This is a different schedule from the supplied test, which pauses A after its reservation already exists.

**Repair requirement:** make backing allocation and its supply/reservation snapshot atomic or equivalently protected by a durable version/ownership protocol. A lease that can expire does not make earlier reads current. Rechecking only one part of the invariant remains insufficient.

### C02 P1 A reservation read error opens the mint path

**Source:** [server.js 1173-1175](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L1173-L1175). **Reproduction:** “OPEN C02/B04: reservation-read error is converted to zero and reuses uncertain backing.”

The first mint is accepted externally but loses its response. Its operation is `reconcile` and its 10 units must remain reserved. On a second operation, fail only the reservation query. `reservedBase` catches that error and returns an empty list. The second 10-unit mint succeeds against the same 10 collateral.

This requires no concurrent workers. It is a new failure mode introduced by the reservation implementation.

**Repair requirement:** inability to read safety-critical liabilities must stop issuance with a retriable error. Preserve all reservations. Add prevention tests for timeouts, malformed results and unavailable reservation storage.

### C03 P1 An old absolute write can overwrite a newer event total

**Source:** [server.js 1201-1224](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L1201-L1224). **Reproduction:** “OPEN C03/B02: an older absolute supply write overwrites a newer sum and permits extra mint.”

Start with recorded and modeled actual supply 100 and collateral 120. A mints 10, records its event, computes 110 and pauses before writing that value. After lease expiry, B correctly counts A's 10-unit reservation, mints the other available 10, computes the newer event total 120, writes it and completes. A resumes and overwrites 120 with its stale 110.

A third 10-unit mint now passes the materialized-supply check. The model ends with 130 actual and recorded supply against 120 backing; the third write catches accounting up only after issuance has already exceeded backing.

Writing an absolute number avoids repeating one arithmetic delta. It does not prevent stale calculations from overwriting newer state.

**Repair requirement:** serialize or version event insertion, recomputation and materialization; prevent stale writers from committing. Every solvency decision must use a consistent authoritative state. Include concurrent operations on distinct keys, not only retry of one event.

### C04 P1 Startup can cancel a real mint liability

**Source:** [New representation and event](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L1039-L1057); [Baseline seeding](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L2572-L2581). **Reproduction:** “OPEN C04/B03/B05: restart baseline cancels an unmaterialized mint event on a new representation.”

A new destination representation starts at zero. A 10-unit mint succeeds and its accounting event is saved, but all materialized supply updates fail. The operation correctly remains reconcilable.

On restart, the new representation has no baseline event. Migration computes `baseline = current circulation - existing events`: zero minus 10. It inserts a **negative 10-unit baseline**. Correctly reconciling the real mint then produces zero circulation and marks the operation complete. Another mint of 10 succeeds against the same backing.

This is a single-worker restart failure. A normal operator resolution of the confirmed mint triggers it; no incorrect operator declaration is required.

**Repair requirement:** distinguish legacy baseline initialization from representations created under the event model. Initialize the latter's baseline durably at creation and never treat an incomplete materialized value as authoritative history. Test interrupted first mint, restart, event replay and migration idempotency together.

### C05 P1 Spendable Bitcoin scripts bypass the new output guard

**Source:** [custody.js 217-237](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/custody.js#L217-L237). **Reproduction:** “OPEN C05/B09: a spendable bare public-key output bypasses the non-vault value caps.”

When an output cannot be converted to a standard address, the guard labels it data and immediately continues. This skips its value cap and excludes it from the non-vault total. A bare pay-to-public-key output is spendable, but address conversion fails for it.

The independent PSBT has a 1,000,000-satoshi input, **999,000 satoshis to a fixture-controlled bare public key**, 500 satoshis vault change and a 500-satoshi fee. It passes the guard and reaches the mocked signer. The old guard counted unknown-script value against the cap; this repair introduces the bypass.

This is independent of the acknowledged missing full SRC-20 decoder. It is a regression in the basic BTC value protection already claimed to exist.

**Repair requirement:** classify scripts precisely, bound value on every non-vault output including unknown scripts, and fail closed for unrecognized spendable scripts. Data classification must not remove value from accounting. Keep fee checks and require the authorized transfer intent.

The test proves the application submits this PSBT for signing. It does not prove Emblem's production signer would approve or broadcast it; any signer-side mitigation needs separate evidence.

### C06 P2 The move reconciliation action does not repair the missing supply write

**Source:** [Move accounting](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L1335-L1348); [Phase-only reconciliation](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L1933-L1948). **Reproduction:** “OPEN C06/B05: a failed move cache write has no complete repair through the phase-only action.”

Fail every source supply write after its immutable debit event is saved. The move returns an error and initially remains visible, which fixes the original false success. Restore database writes. The reconciliation action for `decremented` changes only the phase; it does not materialize the event total. It returns 200 while recorded source supply remains 100 instead of 90.

The user's destination retry then fails the solvency check, and the move is no longer in the pending-move list. A durable event exists, but the exposed action cannot finish its accounting.

**Qualification:** the action's wording asks the operator to confirm the source debit. This test is not evidence that an already verified and materialized debit is rejected. It establishes that event existence alone is insufficient and that repairing materialization outside this API is an undocumented prerequisite to this recovery path.

**Repair requirement:** an authenticated, idempotent operation that repairs and verifies the debit's materialization before advancing the phase, or an explicit tested operator procedure that performs that work and preserves repair visibility until completion.

## Other residual limitations exercised or inspected

**Operation completion can still fail silently.** An independent test fails the final `opComplete` update. The mint endpoint returns 200 while the operation remains reserved, and retry returns 409. Accounting remains recorded, so this particular test does not demonstrate excess issuance, but “success” still does not mean a durably completed operation. [server.js 1158-1164](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/server.js#L1158-L1164). This was already raised in September.

**Payload presence is not enforced as claimed.** `if (!hasData && !hasRecipient)` accepts either condition, and any non-vault address is treated as a recipient. An independent check sends to a different fixture address with no data payload and reaches the signer. Full tick/amount/recipient decoding remains outside this pass's repair scope; its absence is preserved as an open release gate. The checked-in “well-formed SRC-20” test uses an arbitrary text marker, not evidence that a real protocol transfer is valid.

**First-representation repair is manual.** The new mint reconciliation endpoint requires an existing representation row. It also depends on operator verification of the chain outcome; supplying a transaction string is not automated chain verification. Do not free uncertain reservations merely to restore availability.

**Schema packaging is incomplete.** The app attempts to create `accounting_events` and checks constraints, but the commit contains no versioned migration package, rollback/forward-repair procedure or actual deployment schema snapshot. The new baseline failure makes live upgrade review particularly important.

## The requested acceptance schedules

| Schedule | Independent outcome |
|---|---|
| A checks backing, lease expires, B proceeds, A resumes | Original pause-after-reservation case passes; earlier pause-before-reservation fails in C01. Stale materialization additionally fails in C03. |
| Committed debit loses its response; retry/restart | Original double debit prevented. Six before/after event, materialization and terminal-write schedules recover one debit. Concurrent different events remain unsafe in C03. |
| First representation insert fails after mint | Correct non-success and retained backing verified. Repair requires a missing row to be restored elsewhere; created-but-incomplete rows expose C04 at restart. |
| Accepted mint loses its response, then another key | Normal path, including restart, blocks the second mint. Reservation query failure defeats it in C02. |
| Persistent circulation failures during redeem/move | Initial errors are truthful and rows remain visible. Redeem repair succeeds after writes recover. Move repair has C06's phase/materialization gap. |
| Stop at external-effect/accounting boundaries | Thirteen positive failure/restart checks cover six release boundaries and seven existing-representation mint boundaries. New-representation restart fails C04. This is not an exhaustive hard-process-kill or distributed staging soak. |
| Missing lock key; completed-only operation index; composite index | Writes remain contained in tested malformed schemas. Missing event uniqueness is also rejected; exact non-null predicate is accepted. |
| Aborted move and NULL historical redemption after restart | Verified: aborted move can finish a subsequent legitimate retry; historical redeemed burn cannot be reused. |

## Additional claimed fixes

**Solana token identity:** verified in isolated adapter tests. A transient mint lookup error retries four times and returns `RPC_UNCERTAIN`; a not-found error returns `MINT_MISSING`. Neither calls `createMint` for an existing mint. This does not verify actual on-chain decimals, all metadata or finality/reorg policy. [sol-mint.js 64-88](https://github.com/arwyn6969/STAMPYSWAP/blob/80963563fc7eb3ce1b30bd87d2c1dcb096393418/sol-mint.js#L64-L88).

**OpenZeppelin and contract build:** verified from a clean install. The manifest permits compatible versions with `^4.9.6`; the lockfile resolves 4.9.6. The generated mainnet artifact is byte-identical to the tracked artifact, with 21 ABI entries and 4,228 bytes of creation bytecode. [Build output](contract-build.txt), [artifact/hash verification](build-verification.json).

## What remains before a limited release candidate

1. Repair **C01–C04** in a coherent accounting/allocation design. Passing more single-operation tests is insufficient; the shared state must remain safe under concurrent completion, read failure and restart.
2. Repair **C05** before enabling SRC-20 signing. A candidate may explicitly exclude that route; this does not remove the shared accounting blockers.
3. Finish move and mint recovery, including C06, missing representation handling and truthful completion persistence.
4. Deliver versioned schema and migration instructions, plus a redacted deployment inventory and historical chain-versus-ledger reconciliation. Do not run the new baseline migration on live data without addressing C04 and reviewing existing state.
5. Define a bounded asset/protocol/chain/action scope. Mainnet mint wiring and actual authority/approval configuration are not established by a successful contract build.
6. Complete the separately acknowledged gates: full SRC-20 semantics for any enabled SRC-20 route, dependency advisory triage, a current-application CI workflow, multi-worker staging soak and deposit → issuance → burn → withdrawal staging journeys.
7. Freeze the resulting source and deployment configuration for independent candidate review. A backend restart is a distinct deployment action; it is not approved by this report.

Items in step 6 were explicitly outside this repair batch and remain **not done/unverified**, not silently accepted. No fresh dependency triage was performed; the approximately 21 advisory entries are the previously reported baseline, not a newly certified count. GitHub's lack of current checks was independently confirmed.

## Evidence and reproducibility

The isolated checkout is `/private/tmp/stampyswap-repair-audit-8096356`. The older edited workspace was preserved. Tests ran on Node v23.3.0 on macOS arm64; the runtime is recorded in [test-runtime.json](test-runtime.json).

The fixtures load the **whole pinned server**, use real Express, local SQLite and real EIP-191/BIP-322 signatures, and substitute blockchain/indexer effects. Separate server contexts share a database to model workers. Clock advancement models lease expiry. Before/after write hooks distinguish a failure before commit from a committed-but-lost response. Restart checks construct another server context and rerun actual startup migration on surviving fixture data. These are controlled state-transition models, not real chain executions or exhaustive process termination tests.

The independent signing checks parse real PSBTs and use fixed test keys; the signer and broadcast are mocked. Wallet helpers use provider substitutes, and Solana identity checks use a mocked RPC. No production key file is read.

To reproduce against a clean checkout of the exact SHA with dependencies installed:

```sh
STAMPY_AUDIT_SOURCE=/path/to/8096356-checkout node --experimental-sqlite --test --test-timeout=10000 --test-reporter=tap /path/to/this-audit/independent-repair.test.cjs
STAMPY_AUDIT_SOURCE=/path/to/8096356-checkout node --experimental-sqlite --test --test-timeout=8000 --test-reporter=tap /path/to/this-audit/release-readiness.test.cjs
```

The first command completes 39 evidence checks, including eight OPEN reproductions. The second intentionally exits nonzero on the repaired code; see the UI-fixture qualification above. Keep both fixtures and the source manifest beside the test files.

Artifacts: [independent tests](independent-repair.test.cjs), [independent fixture](independent-fixture.cjs), [39-check results](independent-repair-results.txt), [repinned old assertions](release-readiness.test.cjs), [old-suite results](legacy-reproduction-results.txt), [37 project tests](repository-tests.txt), [installation](npm-ci.txt), [lint](lint.txt), [syntax](syntax-results.json), [source hashes](source-sha256.json), [browser containment observation](live-browser-observation.json), [HTTP observations](live-app-read-only-check.json), [next repair handoff](EMBLEM-HANDOFF.md).
