# StampySwap repair audit handoff

Independent review date: **1 October 2026**. Reviewed repair: **80963563fc7eb3ce1b30bd87d2c1dcb096393418**, against **9689964dac19f4b45c5532a744bd3fd8dfe0daea**. [Full report](AUDIT.md).

The implementation passes its 37 tests and lint. The mainnet build now reproduces exactly, and the Solana identity change is independently verified. B06/B07's specified defects and B08's local authorization flow are fixed. However, **B01–B09 cannot all be closed**: independent tests reproduce six new or remaining core failures, plus two retained limitations.

Keep custody maintenance-contained. The public browser view reports maintenance and release gated; the actual backend revision, effective flags, .custody-live state, worker count and schema snapshot still need operator evidence. Do not treat this report as deployment or reopening approval.

## First repair the shared accounting design

Do not patch only the exact old OPEN assertions. Address these new whole-server schedules:

| ID | Reproduction on 8096356 | Required prevention |
|---|---|---|
| C01 | A reads supply 0/backing 10 and pauses before reserving; its lease expires; B mints/completes 10; A resumes with stale supply and mints another 10 | Allocation must atomically check current supply and all reservations. Stale workers/read snapshots cannot allocate backing. |
| C02 | First mint is uncertain; a reservation query fails; catch-to-empty permits a second key against the same backing | Safety-critical query failure stops issuance. Never interpret unknown liabilities as zero. |
| C03 | A computes supply 110; B computes/writes 120; A writes stale 110; another 10-unit mint succeeds against backing 120 | Version or serialize event insertion, recomputation and materialization. Older writers must not overwrite newer authoritative totals. |
| C04 | New representation is created at 0; +10 mint event persists but materialization fails; restart inserts baseline -10; correct mint reconciliation records 0 and frees backing | Separate legacy initialization from event-native representations. Establish a zero baseline at creation and never infer history from an incomplete materialized value. |

Use the storage primitive that can actually guarantee the invariant. State explicitly whether the current database API supports the required transactions/version checks. Uniqueness of event keys does not serialize different events, and an absolute write is only safe against retries of the same unchanged state.

Acceptance must include independent workers, stale readers, failed reads, committed-but-lost responses, first-representation initialization, process restart and two different operation keys. Keep immutable event identities, and verify their representation/amount binding on replay.

## Repair the Bitcoin guard regression

**C05:** an output that cannot be rendered as a standard address is now classified as data and skipped before value caps. A spendable bare public-key output carrying 999,000 satoshis reaches the mocked signer, with a 500-satoshi fee and 500 satoshis change.

Count every non-vault output's value, including unknown scripts. Distinguish actual zero-value protocol data from spendable scripts; reject unrecognized scripts. The new fee caps do not prevent this leak. This regression is separate from full SRC-20 semantic decoding, which is still an acknowledged open release gate.

Also, a non-vault dust output with no data payload currently passes, even when it differs from the requested recipient. Do not describe the presence check as complete transfer validation.

## Finish recovery rather than only advancing phases

**C06:** after a move's debit event persists but supply materialization fails, the move reconciliation action only marks the phase decremented. It leaves materialized supply unchanged, destination mint remains blocked and the row leaves the pending-move list.

Provide an idempotent repair action that applies/verifies materialization before advancing the phase, or a concrete tested manual procedure with those prerequisites. Event existence alone is insufficient. The test does not establish a failure for an already verified and fully materialized source debit.

Other retained gaps:

- opComplete still suppresses persistence failures and returns mint success while the operation remains reserved.
- Completing a mint with no representation row still requires creation/verification outside the new repair endpoint.
- Reconciliation takes operator-declared chain outcomes; a supplied transaction string is not independently checked chain evidence.
- Versioned schema/upgrade instructions and actual deployment schema evidence are missing.

## Preserve what now works

Retain regression coverage for:

- Exact original lease-after-reservation and uncertain-mint schedules.
- Committed-but-lost debit responses, with single application across restart.
- Truthful initial errors for representation insert/materialization failures.
- Aborted moves remaining retryable and NULL-status historical redeems remaining consumed.
- Rejection of missing, composite and completed-only unique constraints; acceptance of the exact non-null unique-index predicate.
- EVM challenge/sign/retry requests from both UI forms and both Solana signing-helper variants.
- Excessive declared fee rejection.
- Solana transient/not-found lookup never creating a replacement identity.
- Reproducible OpenZeppelin contract build.

The maintenance UI's principal buttons still appear enabled in the public page. Fix that display behavior while preserving backend enforcement; this is not evidence of a backend maintenance bypass.

## Deliver the next verification package

For each C finding and residual B finding, provide:

1. Repair SHA and source locations.
2. Prevention tests asserting the safe result, including all new interleavings.
3. Clean install, lint, full test and contract-build outputs.
4. Versioned schema/migration and historical reconciliation procedure.
5. Redacted deployed SHA, flags, .custody-live presence/absence, worker count and operation inventory.
6. Explicit first-candidate assets, protocols, networks and enabled actions.

Full SRC-20 semantic validation, dependency advisory triage, current-app CI, multi-worker staging soak and the complete custody staging journey remain outside the completed repair batch. They must be fulfilled or explicitly excluded where a restricted candidate can safely exclude the relevant feature. Shared accounting failures cannot be excluded merely by disabling one protocol.

The current independent suite contains **39 checks: 31 verify protections; eight reproduce defects/residuals**. See [results](independent-repair-results.txt). OPEN assertions pass when a problem reproduces. The old suite's UI test fails on a missing fixture field; use the new positive integration checks for B08.

Follow the [report's reproduction instructions](AUDIT.md#evidence-and-reproducibility), using a clean checkout of the exact source SHA and keeping the new source-hash manifest intact. Preserve the original September evidence. No production credentials, funded wallets or live broadcast are needed for these local tests.
