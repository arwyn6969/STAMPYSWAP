# Emblem: host work remaining after PR #3

Codex owns implementation, dependency remediation, independent protocol validation and local regression checks. Use one reviewed branch. Keep production maintenance enabled and custody closed until the acceptance evidence below is complete. No production balance rewrite, claim deletion, burn, mint, signing or broadcast is authorized by this checklist.

## 1. Production inventory and backup

Record the actual running SHA, Node/npm versions, process manager, entry point, number of serving workers/replicas and database instance boundaries. Public instance-ID sampling is corroboration, not a worker-count proof. The candidate requires Node >=22.12. Keep all credential values private.

Obtain a transaction-consistent snapshot/export with supported platform tooling. Record UTC time, SHA256, schema definitions and every accounting table's row count. Keep the original immutable in the host's private workspace. Do not share keys, tokens or authentication records. A series of independent SELECT exports is not necessarily a consistent snapshot. If SQLite file export is unavailable, identify the actual supported backup/restore mechanism and explain the boundary.

Run these read-only queries against the accounting database and retain their exact HTTP status/envelopes:

```sql
SELECT name,tbl_name,sql FROM sqlite_master
WHERE tbl_name IN ('operations','consumed_burns','collateral_ledger','bridge_ops',
                  'asset_locks','accounting_events','representations')
ORDER BY tbl_name,name;
SELECT canonical_id,dest_chain,COUNT(*) AS n FROM representations
GROUP BY canonical_id,dest_chain HAVING COUNT(*)>1;
SELECT action,state,COUNT(*) AS n FROM operations GROUP BY action,state;
SELECT state,COUNT(*) AS n FROM operations
WHERE op_key LIKE 'representation-deploy:%' GROUP BY state;
SELECT direction,status,COUNT(*) AS n FROM collateral_ledger GROUP BY direction,status;
SELECT 1 AS probe;
SELECT 1 AS probe WHERE 0;
```

Also capture the envelope for an intentionally invalid, read-only SELECT. Do not execute write probes on production. The implementation uses `accounting_events`, `collateral_ledger.btc_txid` for deposit uniqueness, and durable deployment claims inside `operations` with `representation-deploy:` keys. There are no separate `ledger_events`, `consumed_deposits` or `representation_deployments` tables in this candidate.

## 2. Copy migration, restore and API compatibility

Use an isolated copy of the immutable snapshot:

```sh
python3 scripts/prepare-migration.py snapshot.db migrated-copy.db
python3 -m unittest discover -s test -p '*_test.py' -v
```

The helper never changes its source; it rejects duplicate representation identities and an existing output file. Compare ledger/events/burns/operations and representation identities before/after. Verify all seven uniqueness gates, foreign keys and integrity. Rehearse restoration on an isolated database with the supported host procedure. Preserve the original backup and migration checksums.

Run the candidate against an isolated Dashboard DB API wired to that copy. Confirm PRAGMA/index inspection, the LEFT JOIN accounting snapshot, bind parameters, SELECT result envelopes and execute acknowledgement fields. In that copy, reproduce HTTP-200 error envelopes, lost acknowledgements and acknowledged no-op writes; the candidate must refuse uncertain accounting without repeating external effects. Production DDL is a later operator step, not part of this rehearsal.

## 3. Historical reconciliation and eligibility

For every representation, bind observed chain supply to its exact token address, chain/network, block/slot and decimals. Compare it with the append-only accounting-event sum, pending/uncertain mint reservations and confirmed backing less non-failed withdrawals. Cross-check Bitcoin deposit/release transactions, indexer amounts, consumed burns and operation outcomes. Keep exact integer/decimal quantities; do not round discrepancies away.

The known Solana-devnet mismatches are 1500 $BALD and 0.1 PUDSEC. A ledger-wide release cap and allegedly lost wallet keys do not exclude specific tokens. Historical eligibility must have an enforced policy before releases reopen. Report any mismatch and required policy decision; do not silently edit baselines, reset supply, choose a duplicate token identity or clear uncertain deployment claims.

## 4. Isolated staging acceptance

Inventory a separate database, test assets and signer/wallet authority first. Use worthless test assets and explicitly authorized test operations. Cover deposit -> owner-bound mint -> burn -> owner-bound redeem, plus chain moves and replay rejection. Verify the current composer produces the supported OLGA format and the managed signer preserves the validated transaction and valid vault signatures. Record actual transaction IDs and both chain/indexer confirmations before asserting success.

With at least two workers sharing the staging DB, pause a worker beyond the 30-second lease during first deployment and while an external result is ambiguous. Send duplicate and different operation keys concurrently. Inject DB outages and process restarts. Require one token identity, no repeated chain effect, no unbacked issuance and durable reconciliation for uncertainty. Local mocked-worker tests are regression evidence; they do not replace this platform soak.

## 5. Final release procedure

Return the evidence above to Codex for review against the exact PR head and green CI. Once the user's conditional live-update requirement is met, apply only the reviewed migration using supported platform tooling, deploy that exact commit, restart through the process manager and independently verify running SHA, schema readiness, worker count and maintenance/custody flags. The application-code deployment and custody reopening are separate decisions; keep custody closed during post-deployment checks. Preserve rollback evidence and do not discard events that occurred after the snapshot.
