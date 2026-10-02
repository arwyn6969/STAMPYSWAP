# STAMPYSWAP audit register and ownership recommendation

## Latest completed repair review 1 October 2026

Reviewed **`80963563fc7eb3ce1b30bd87d2c1dcb096393418`**, against the September baseline **`9689964`**. See the [repair audit](2026-10-01-8096356/AUDIT.md), [Emblem handoff](2026-10-01-8096356/EMBLEM-HANDOFF.md) and [verification summary](2026-10-01-8096356/verification-summary.json).

The claim that all B01–B09 findings are remediated is **not verified**. B06/B07's reported failures and B08's local authorization flow are fixed. The original B02 response-loss case is fixed. New independent schedules reproduce C01–C04 accounting/allocation failures, C05's Bitcoin script-value bypass and C06's move-repair gap. Custody must remain contained; this is not release clearance.

Fresh install, lint, 37 project tests and a byte-identical mainnet contract build pass. The independent suite completes 39 checks: 31 positive verifications and eight defect/residual reproductions. The old suite has six positive passes and 12 OPEN failures; its B08 failure is a missing-fixture-field error, so separate integration tests establish the actual authorization fix. OPEN checks passing is evidence of a defect.

The public browser view reports maintenance and release gated. Backend revision, effective environment/file flags and production state are not independently attested. No live write or deployment was performed. The report and evidence are the current handoff; earlier entries below are preserved history.


## Previous completed independent review 30 September 2026

Current reviewed GitHub main is **`9689964dac19f4b45c5532a744bd3fd8dfe0daea`**, published 22 September and rechecked on 30 September. Nine commits follow the previous completed review. See the [detailed release audit](2026-09-30-9689964/AUDIT.md), [Emblem repair handoff](2026-09-30-9689964/EMBLEM-HANDOFF.md) and [GitHub evidence](2026-09-30-9689964/github-evidence.json).

Verdict: **not ready for public custody or full mainnet release**. Locked installation, lint and 23 project tests pass. Eighteen independent checks completed: 12 reproduce failures across B01–B09 and six confirm selected protections. OPEN checks pass by demonstrating a defect, not by establishing safety. Twenty root JS/MJS syntax checks pass; mainnet contract generation fails on missing OpenZeppelin sources. Fresh dependency advisories report 21 affected entries, including five high; no current-revision GitHub checks were returned.

Verified progress includes required mint keys, legacy-key containment, transaction-specific Counterparty claims, holder-signed move authorization, exact claims, and reservation before uncertain stamp release. Remaining failures concern lease expiry, committed-but-lost database responses, unrecorded/uncertain issuance, falsely completed accounting, migration dispositions, incomplete uniqueness checks, unusable withdrawal/move forms and incomplete Bitcoin signing validation. Production state remains unverified.

Use the new report and handoff as current status. Keep Emblem as implementation owner and have the owner liaise using the prepared handoff. No deployment, production transaction, application repair or external message was performed. The older edited local checkout was preserved.


## Previous completed independent review — 457dc9a

21 September 2026: current GitHub main `457dc9ad52bbe3aa9b1a36dd646fa6080c602e39` independently reviewed. See the [full audit](457dc9a/AUDIT.md), [ordered repair handoff](457dc9a/REPAIR-HANDOFF.md), and [saved GitHub evidence](457dc9a/github-evidence.json). This completed review supersedes the **current-status** statements in the historical consolidation below; the earlier records remain preserved as evidence.

Verdict: **custody still no-go**. Maintenance/legacy retirement, selected schema gates, burn authorization, source precision, configured Base confirmation depth, and new provenance labels pass their targeted checks. R05/F06/F07 recovery remains incomplete: reconciliation can decrement twice, new keys miss legacy operations, two workers can erase backing after issuance, failed reconciliation conflicts with startup backfill, and move resumption trusts a reservation before accounting finishes. Optional direct-mint keys and uncertain stamp-release retries remain unsafe. Schema constraints are assumed, clean npm installation fails, and current GitHub checks are absent.

Evidence: 41 independent local checks completed (15 focused fault/interleaving checks + 26 real-router checks), 12 pure repository unit tests passed, separately provisioned lint and 23 syntax checks passed. Counterexample/OPEN tests pass by reproducing defects; they are not clearance. `npm test` reports 13 including a smoke script that passed despite failed external calls. Fresh npm audit reports 21 affected dependency entries, including 5 high. Production deployment, schema, balances and signer controls remain unverified.

Keep Emblem as the implementation owner for the next bounded batch, using the new handoff. The earlier `b164086` task remained incomplete; its unfinished harness was adapted, source-pinned and actually run as part of this new `457dc9a` review. No application changes, deployment, custody actions, or messages to Emblem were made.

## Historical consolidation at b09fa31

Updated 21 September 2026. GitHub main checked at 16:18 UTC: `b09fa31545e0e900ffa86ccb9ce1b20474ebe954`. Main advanced from `07672db` during this consolidation; the new commit diff was inspected before finalizing this document.

Recommendation: retain Emblem as the primary implementer for the next repair batch. Use this local workspace for independent verification, evidence, and this consolidated register. Keep one implementation owner per change. Reassess ownership against the next batch's runnable evidence, rather than starting a competing rebuild.

This document consolidates the available audits and inspects selected current source. It is not a completed third independent audit or authorization to reopen custody. Production configuration, balances, migration state, and the Emblem agent's private working state have not been inspected.

## Audit and repair sequence

All entries below concern work reported on 21 September 2026. F and R identifiers overlap in scope; they must not be counted as 17 independent unresolved bugs.

| Order | Revision / event | Evidence available | Interpretation |
|---|---|---|---|
| 1 | Original audit at `2345961` | [Audit](2345961/AUDIT.md), [plan](2345961/REPAIR-PLAN.md), harness and saved results | Ten findings F01–F10, supported by eleven offline reproductions. Public custody not ready. |
| 2 | First five repair commits, ending `621499e` | Git history below | Changes submitted by the builder; commit descriptions alone do not establish closure. |
| 3 | Follow-up audit at `621499e` | [Audit](621499e/AUDIT.md), [plan](621499e/REPAIR-PLAN.md), [results](621499e/test-results.txt), [handoff](621499e/AI-HANDOFF.md) | Twenty-six local checks documented both successful protections and remaining/new defects R01–R07. OPEN/NEW checks pass when they reproduce a defect. Custody remained no-go. |
| 4 | Three further repair commits, ending `07672db` | Git history and current source | Containment, schema checks, finality/status, and part of durable mint handling changed. |
| 5 | Local independent third review requested at `07672db` | Task “Audit STAMPYSWAP HEAD”; detached source checkout exists | Interrupted repeatedly by a platform cybersecurity flag. No completed third local report or new test-results file was found. Do not describe it as still running or completed. |
| 6 | User-supplied re-audit at `07672db`, already sent to Emblem | [Preserved supplied report](07672db/PROVIDED-REVIEW.md) | Reports improved containment and identifies the missing `opKey` parameter. No runnable test harness/results accompanied this attachment; author and method are not established by the attachment. |
| 7 | New builder commit `b09fa31` | [Commit and diff](https://github.com/arwyn6969/STAMPYSWAP/commit/b09fa31545e0e900ffa86ccb9ce1b20474ebe954), published 16:14:19 UTC | Adds the missing parameter, explicit uncertainty flags, and a catch around mint-after-deposit. The builder reports manual runtime/idempotency checks. Only `server.js` and `CLAUDE.md` changed; no regression tests were committed in this batch. |
| 8 | This consolidation | Current GitHub branch, local `07672db` source, `b09fa31` diff, previous artifacts, official Emblem docs | Confirms the earlier regression and the new source changes. Records remaining qualifications and verification work. No new application regression suite was executed. |

The eight builder commits after the original baseline, in order:

1. `5222498` — P0 vault safety and selected P1 fixes.
2. `69288a8` — fail-loud key loading and operator restriction on moves.
3. `b1c49ce` — maintenance containment.
4. `6a8bb69` — excess-precision guard, mint-capability check, ACME redemption decimals.
5. `621499e` — owner-bound redemption and shared burn consumption.
6. `1397e6e` — containment rework, unknown broadcast handling, schema/history checks.
7. `d42f9fb` — burn finality and maintenance/status changes.
8. `07672db` — durable mint operation records, part 1.

The ninth subsequent repair commit is `b09fa31` — missing mint parameter and deposit exception/uncertainty handling. Source: [comparison from original baseline](https://github.com/arwyn6969/STAMPYSWAP/compare/2345961...b09fa31). The descriptions above summarize intent, not independent verification.

## What is currently happening

- The user reports that the supplied re-audit has been sent to Emblem, the main builder. A corresponding repair commit, `b09fa31`, is now visible on GitHub. The private Emblem conversation and any further uncommitted work remain uninspected.
- GitHub main points to `b09fa31`. Its commit message reports an operator mint returning a clean unfunded response and duplicate-key rejection; those claims do not establish successful issuance, crash recovery, or complete prevention coverage.
- The previous local audit task has a system-error status. Its third review remains unfinished.
- The main local folder `/Users/arwynhughes/Documents/STAMPYSWAP` is at older revision `77dea9b`, with existing uncommitted changes. Its React frontend, tests, and CI must not be mistaken for the newer Express/custody application's quality gate.
- The prior review source is already local at `/private/tmp/stampyswap-audit-07672db`; the original and second audit checkouts are also under `/private/tmp`. The new `b09fa31` diff was retrieved through GitHub. Fetch that exact commit into the review checkout before running its tests; the temporary checkout has not been updated in this task. No manual download is necessary.
- Audit artifacts under this project's `audits/` folder are currently untracked local files. This consolidation has not published them or changed the application.

For ongoing implementation, create a permanent clean clone/check-out of the current GitHub source, separate from the older edited project. Preserve the old edits and the existing evidence. A temporary detached checkout is suitable for a pinned review, but not the only durable home for ongoing repairs. Do not blindly pull the newer application into the older dirty folder.

## Findings register

“Verified earlier” means evidence at `621499e`, not automatic clearance of `b09fa31`. “Reported changed” means the supplied review or builder describes a change that still needs the current independent test pass. Operator restrictions are containment, not complete user-facing repairs. Except for the mint signature/error changes identified below, the new diff does not change these dispositions.

| ID | Last demonstrated issue / protection | Current disposition and next evidence |
|---|---|---|
| F01 | No-burn public release blocked and burner signatures verified at `621499e` | Core protection verified earlier; full redemption remains open through recovery, entitlement, finality, and UI requirements. Retest the release flow. |
| F02 | Legacy accounting-only redemption remained behind restrictions | Retirement middleware is present at `07672db`. Verify all supported path/configuration variants and preserve historical accounting for reconciliation. |
| F03 | Mutable deposit key permitted replay at `621499e` | Legacy route retirement is present; prove route containment and durable source-event immutability. Do not equate one blocked route with full database-level protection. |
| F04 | Counterparty aggregate balance attribution | Restricted to operator, root cause still open. Require exact per-send entitlement before exposing public claims. |
| F05 | Move lacks holder-bound destination authorization | Operator-only; root cause still open. `moveBindingMsg` exists but is not wired into the move handler. |
| F06 | Valid deposit/move cannot recover after a failed mint | `07672db` regression patched in source at `b09fa31`; independent verification pending. Deposit exceptions now preserve credit and return a reconciliation flag, but durable recovery and move resumption remain unfinished. |
| F07 | Successful mint followed by failed accounting may duplicate on retry | Missing-parameter obstacle patched in `b09fa31`; durable protection remains unverified/incomplete. Test every caller, unknown outcomes, failed operation persistence, failed accounting, retries, restarts, and multiple workers. |
| F08 | Unsupported Base mainnet mint consumed a deposit | Early capability guard verified earlier. Mainnet mint support remains incomplete; keep unavailable capabilities unadvertised and test rejection without state changes. |
| F09 | Excess ACME precision over-credited | Fixed in tested cases at `621499e`; retain as regression coverage and test current source. Wider quantity/decimal conservation remains in scope. |
| F10 | Partial stamp claim consumes whole burn | Open, overlaps R04. Maintenance restrictions do not implement remaining entitlement. |
| R01 | Maintenance matcher differed from dispatched routes | Normalization and default-deny middleware are present; supplied review reports containment. Current independent HTTP/proxy/configuration matrix still required. |
| R02 | Unknown broadcast exception freed the burn reservation | Reported changed to reconciliation. Verify externally accepted transactions with lost responses across all relevant release paths. |
| R03 | Historical burn migration/replay gap | Startup/backfill code added, but packaging and readiness remain incomplete. `SCHEMA_OK` is set before backfill finishes; failed backfill only logs a warning. Operator bypass also precedes schema containment. |
| R04 | Partial redemption discards remaining burn entitlement | Open. Define exact-full-event or authenticated residual claims, with event-level identities shared across operations. |
| R05 | Durable operation recovery across mint/move/release/stamp paths | Open. `b09fa31` patches the immediate parameter/error regression; complete transactional reservations, recoverable external effects, accounting recovery, and cross-worker coordination still require implementation and tests. |
| R06 | Burn verification lacked required finality | Verifier/depth changes reported. Policy, reorg handling, block identity, and L2 settlement assumptions still need verification. A configured block count alone is not proof of the required assurance. |
| R07 | Status/maintenance and redemption client disagreed | Paused status reportedly improved; burn/signature redemption UI still unfinished. Verify every advertised asset/chain capability and actual client flow. |

Additional obligations from the earlier plans remain: canonical protocol/asset identity; Bitcoin PSBT/envelope content and fee validation; shared vault UTXO coordination; actual SPL decimals and stable mint identity; pool reserve/token ordering; reproducible contract builds; dependency remediation; historical backing/supply reconciliation; and production signer/override policy.

## Qualifications to the supplied re-audit

1. **The mint regression was supported by source and is now patched in source.** At `07672db`, `mintCritical` declares four parameters at [server.js line 902](https://github.com/arwyn6969/STAMPYSWAP/blob/07672db29d83659126914c0a7aed93f00eee8d55/server.js#L902), reads undeclared `opKey` at line 927, and receives a fifth argument at lines 1100 and 1498. Requests that reach that guard throw; earlier validation failures can return before it. `b09fa31` adds `opKey = null` and a local deposit catch. This is a source-confirmed patch, not yet independent runtime clearance.
2. **A signature edit is not R05 closure.** `performMint` still supplies no operation identity at line 900. `opComplete` suppresses database errors at line 1063. The completed-operation branch returns a cached result before repairing later accounting, and the deposit duplicate check can stop resumption before it reaches the operation guard. These are source observations for targeted tests, not a completed new reproduction suite.
3. **Error classification is improved but needs durable outcomes.** `b09fa31` adds the previously missing `reconcile: true` flags on uncertain signer errors and retains deposit credit on unexpected exceptions. The new catch returns a reconciliation flag but does not itself persist an operation/reconciliation record. Test exceptions before operation reservation as well as after execution; an HTTP flag alone is not restart-safe recovery. Do not prescribe unconditional deletion/rollback in a catch.
4. **The schema gate is narrower than the handoff suggests.** Readiness is assigned after checking three columns but before historical backfill completes. Backfill failure does not clear it; the operator bypass also applies when readiness is false. “SCHEMA_OK=true” therefore does not yet establish complete, successful migration or universally blocked writes.
5. **Containment is not production certification.** The supplied report says containment is holding. This pass has not replayed its full route matrix or inspected the deployed SHA, reverse proxy, environment, or operator permissions. Existing external pool availability/safety was not checked.
6. **The seven-item reopen list is incomplete.** It must not supersede the earlier recovery, migration, entitlement, finality, reconciliation, signer, dependency/build, and CI obligations. A dry mint or a small canary cannot close those requirements.
7. **A stuck confirmed deposit is not automatically fabricated backing.** A real source deposit can remain real while its mint is stranded. The demonstrated issue is broken issuance/recovery accounting; actual backing must be reconciled before stronger claims are made.

## What Emblem's documentation establishes

The official [developer index](https://emblemvault.ai/docs) describes SDK, MCP and A2A integration surfaces. The [hosted MCP documentation](https://emblemvault.ai/docs/mcp) says read tools are the default and transaction tools require an opt-in header. The [integration overview](https://emblemvault.ai/integrations) describes authenticated access from other clients and agent-to-agent integration.

These pages support a mixed workflow: local development/review can coexist with Emblem services. They do not establish that STAMPYSWAP must be edited inside Emblem, that this particular builder has a complete test environment, or that a repair is correct. The inspected repository already contains portable Node source, but live operation depends on external signing, database, RPC/indexer, and configuration services. A source checkout is not a complete production environment.

The app uses `@emblemvault/auth-sdk` and calls signing adapters directly. The MCP endpoint's read-only defaults or transaction opt-in do not automatically constrain this server's direct SDK calls. Validate the actual configured authority and code path. No new Emblem connection or production credential is needed for local mocked regression tests.

Documentation access note: the web reader could retrieve the integrations page but not the developer/MCP pages; those two pages were read successfully in the browser. This is a documentation review, not inspection of a private Emblem session or account.

## Ownership and handoff decision

| Work | Recommended owner | Required output |
|---|---|---|
| Next application repair batch | Emblem builder | Exact commit, changed findings, checked-in prevention tests, command/results, limitations. |
| Independent validation and consolidated register | Local reviewer in this workspace | Findings reproduced or closed against the same SHA, retained evidence, updated status and next batch. |
| Production configuration, schema application, reconciliation | Deployment operator with builder support | Redacted evidence tied to a release SHA and migration version. |
| Public reopening | User/deployment owner after review | Explicit release decision after all applicable gates pass. |

This is a recommendation, not a newly assigned task or message to Emblem. The user has already sent the supplied review; this task has not contacted the builder.

Retain Emblem for the next bounded batch because it is already implementing this integration and a simultaneous rewrite would duplicate work and weaken ownership. Require evidence before declaring that batch done. If Emblem cannot provide runnable tests, versioned schema/build inputs, and a stable reviewable commit—or the same recovery defects keep returning—move an agreed implementation slice to a permanent local branch and pause overlapping builder edits. Preserve Emblem integration support and obtain separate review of locally authored changes.

Next deliverable: [the ordered remediation plan](REMEDIATION-PLAN.md), starting with independent verification of `b09fa31` and checked-in prevention tests. The rest of R05 and the earlier release gates remain open after the immediate regression patch.
