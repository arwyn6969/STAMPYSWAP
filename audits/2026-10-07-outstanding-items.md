# Outstanding items — independently reviewed 7 October 2026

`110dc3c` is deployed with schema readiness restored, maintenance enabled and custody closed. Its exact-revision CI passes 52 tests, lint and the mainnet contract build. Its dependency scan is non-blocking and reports 20 affected package entries (one critical, four high, eleven moderate, four low).

The assertion that all eighteen items are complete is not supported. Five independent safety assertions fail on that revision: stale-worker token identity, overlapping first deployments after lease expiry, malformed liability responses treated as zero, stale planner solvency, and completion acknowledgements accepted without durable readback. A sixth structural test shows recipient dust without any payload reaching the signer. These are offline reproductions with fixed test keys and mocked chain effects.

## Candidate repairs

- Refresh identity after reservation/solvency reads, hold a durable first-deployment claim, preserve the registered address and require an unqualified representation identity constraint.
- Reject malformed database envelopes and financial amounts, read all representation liabilities in one query, and verify operation/event persistence and event identity.
- Calculate planner solvency from authoritative accounting events.
- Verify completion state, transaction identity and result after acknowledged and ambiguous writes; return reconciliation when verification fails.
- Serialize schema retries and continue probing after a prolonged outage.
- Require both data and recipient outputs before SRC-20 signing. This structural guard does not establish actual transfer semantics.
- Apply compatible lockfile updates including Express 4.22.3, proxy-addr 2.0.8 and qs 6.16.0; remove the unused npm compiler wrapper. The checked-in compiler and mainnet artifact remain unchanged.
- Add migration-copy preparation, seven schema gates and checksummed migrations. CI runs the copy checks and blocks on high runtime advisories.

## Devnet supply exclusion remains unresolved

The recorded discrepancies are 1,500 $BALD and 0.1 PUDSEC on Solana devnet. Aggregate ledger collateral/circulation checks cap total releases; they do not identify or exclude particular excess token holders. A holder of an allegedly excluded token who can produce a valid burn can satisfy the same owner/amount checks as another holder, subject to the remaining aggregate limit. A claim that a wallet's keys are lost is not an enforced eligibility rule.

Maintenance and closed custody currently block all release actions. Historical burns, Bitcoin releases, holders, authorities and the intended eligibility policy require independent reconciliation. No token-specific exclusion is claimed implemented by this candidate. No balances are rewritten and no excess tokens are burned or reset.

## Remaining release evidence

1. Full independent SRC-20 payload/input/output validation. The retained OPEN test demonstrates that arbitrary OP_RETURN data still reaches the signer; a green structural test is not semantic proof. Obtain sanitized real composer samples and verify them against an independent protocol implementation.
2. Four high, eight moderate and four low runtime package entries remain after compatible updates. A forced SPL/Squads downgrade is not an accepted remedy. Review and validate the required upstream/migration changes.
3. Obtain a consistent production SQLite snapshot, confirm Dashboard API envelopes/query support, and rehearse migration and restoration on a copy. Migration 002 must be verified before the new startup gate can allow writes.
4. Verify actual serving-worker topology from platform inventory. A stable `/api/version` instance identifier does not establish worker count. Run staging wallet journeys and a multi-worker fault/soak exercise using separate worthless assets and authority.
5. Complete historical chain-versus-ledger reconciliation and resolve eligibility. Preserve replay identifiers if designing event-log compaction; compaction is deferred.

Lint is verified both locally and by CI. None of these open items is represented as complete. The candidate is a contained review proposal, not permission to deploy or reopen custody.
