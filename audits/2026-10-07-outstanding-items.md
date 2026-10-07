# Outstanding items — independently reviewed 7 October 2026

`110dc3c` is deployed with schema readiness restored, maintenance enabled and custody closed. Its exact-revision CI passes 52 tests, lint and the mainnet contract build. Its dependency scan is non-blocking and reports 20 affected package entries (one critical, four high, eleven moderate, four low).

The assertion that all eighteen items are complete is not supported. Five independent safety assertions fail on that revision: stale-worker token identity, overlapping first deployments after lease expiry, malformed liability responses treated as zero, stale planner solvency, and completion acknowledgements accepted without durable readback. A sixth structural test shows recipient dust without any payload reaching the signer. These are offline reproductions with fixed test keys and mocked chain effects.

## Candidate repairs

- Refresh identity after reservation/solvency reads, hold a durable first-deployment claim, preserve the registered address and require an unqualified representation identity constraint.
- Reject malformed database envelopes and financial amounts, read all representation liabilities in one query, and verify operation/event persistence and event identity.
- Calculate planner solvency from authoritative accounting events.
- Verify completion state, transaction identity and result after acknowledged and ambiguous writes; return reconciliation when verification fails.
- Serialize schema retries and continue probing after a prolonged outage.
- Independently validate current OLGA SRC-20 TRANSFER data, exact token/quantity, first recipient, all outputs, real funding transactions, vault ownership, fees, SIGHASH_ALL and returned vault signatures before broadcast. Public indexed redemption evidence replaces the synthetic structural fixture. Unsupported formats fail closed.
- Apply locked dependency updates including Express 4.22.3, proxy-addr 2.0.8, qs 6.16.0, BIP-322 4 and jayson 5; replace the vulnerable native bigint-buffer with a bounded project-owned pure-JS adapter. Remove the unused npm compiler wrapper. Both full and runtime npm audits report zero vulnerabilities. The checked-in compiler and mainnet artifact remain unchanged.
- Add migration-copy preparation, seven schema gates and checksummed migrations. CI runs the copy checks and blocks on high runtime advisories.

## Devnet supply exclusion remains unresolved

The recorded discrepancies are 1,500 $BALD and 0.1 PUDSEC on Solana devnet. Aggregate ledger collateral/circulation checks cap total releases; they do not identify or exclude particular excess token holders. A holder of an allegedly excluded token who can produce a valid burn can satisfy the same owner/amount checks as another holder, subject to the remaining aggregate limit. A claim that a wallet's keys are lost is not an enforced eligibility rule.

Maintenance and closed custody currently block all release actions. Historical burns, Bitcoin releases, holders, authorities and the intended eligibility policy require independent reconciliation. No token-specific exclusion is claimed implemented by this candidate. No balances are rewritten and no excess tokens are burned or reset.

## Remaining release evidence

1. Verify the deployed composer and managed signer in isolated staging. Independent intent, funding and signature validation is implemented and tested against a public indexed OLGA redemption, including the former arbitrary-data defect. The original unsigned response and real managed-signer integration remain staging evidence; the reconstructed historical PSBT is labeled explicitly. See docs/src20-validation.md.
2. Runtime and full dependency advisories are remediated in this follow-up, with real SPL layout, RPC and BIP-322 compatibility tests and a clean npm 10 install. Preserve these checks when upgrading dependencies. CI must verify the exact published revision.
3. Obtain a consistent production SQLite snapshot, confirm Dashboard API envelopes/query support, and rehearse migration and restoration on a copy. Migration 002 must be verified before the new startup gate can allow writes.
4. Verify actual serving-worker topology from platform inventory. A stable `/api/version` instance identifier does not establish worker count. Run staging wallet journeys and a multi-worker fault/soak exercise using separate worthless assets and authority.
5. Complete historical chain-versus-ledger reconciliation and resolve eligibility. Preserve replay identifiers if designing event-log compaction; compaction is deferred.

Local validation now passes 127 application/compatibility/prevention tests, four migration-copy checks, lint and the identical mainnet artifact. The prior 40bd17a revision had 93 tests and a failing advisory gate; its evidence remains historical. None of the remaining host/staging items is represented as complete. The candidate is a contained review proposal, not permission to deploy or reopen custody.
