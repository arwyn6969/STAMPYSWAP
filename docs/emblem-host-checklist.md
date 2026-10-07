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

## Backup-manifest preparation

The host confirms its tools read `package.json.emblem_build.tables`, an array of `{name,schema}` objects. Each schema must be one `CREATE TABLE IF NOT EXISTS` definition; the backup tool separately dumps explicit indexes. Its description does not establish transaction consistency.

Export actual table and explicit-index definitions with one read-only query:

```sql
SELECT type,name,tbl_name,sql FROM sqlite_master
WHERE sql IS NOT NULL AND type IN ('table','index')
AND tbl_name IN ('canonical_assets','representations','collateral_ledger','operations',
 'consumed_burns','asset_locks','accounting_events','bridge_ops','stamp_bridges',
 'pools','supported_chains','schema_migrations')
ORDER BY type DESC,name;
```

In a private scratch checkout, save the exact response as `schema-export.json` and prepare a new package copy:

```sh
python3 scripts/prepare-backup-manifest.py package.json schema-export.json package.backup-manifest.json
```

The preparer requires all eleven application accounting/configuration tables, includes the migration log if present, refuses wallet-session/authentication tables, rejects truncated/error responses, parses actual DDL in an empty in-memory database and verifies all seven financial uniqueness gates. It preserves the supplied package and refuses output overwrite. It never registers a manifest or mutates production. No schema is guessed from the limited logical export.

For any metadata-only registration on the existing artifact, use a copy of the existing live package as the source and review that only `emblem_build` changes. Do not replace the live package with a newer dependency/script configuration just to enable a backup. Send the generated package diff and schema evidence for review before registration. Private backup output is gitignored. Confirm backup consistency separately and rehearse its actual restore semantics in isolation.

## Single-statement application snapshot alternative

If the platform backup tool's transaction consistency is undocumented, `scripts/application-snapshot.py` prepares one read-only SELECT for all declared application tables. SQLite documents that a SELECT starts a read transaction and concurrent committed writes on other connections remain invisible until it ends: [transactions](https://www.sqlite.org/lang_transaction.html), [isolation](https://www.sqlite.org/isolation.html). The host read-only probe reports SQLite 3.49.2, JSON1 available and read_uncommitted=0. This establishes capability; execution and restore evidence are still required. A shared connection must not interleave writes while stepping this statement.

In private scratch with the reviewed helper files and actual schema evidence:

```sh
python3 scripts/application-snapshot.py query schema-export.json application-snapshot.sql
```

Inspect that this is exactly one SELECT, then submit it once through the supported read-only database query tool. The query is approximately 31 KiB for the observed schema; if the transport rejects its size, report that limitation instead of splitting it into multiple requests. Save the exact complete result envelope privately as `application-snapshot-envelope.json`. Require HTTP success, one row, rowCount=1, truncated=false and the full snapshot_hex string. Do not paste/export the private row data into chat or commit it. No manifest registration or served-package change is needed for this SELECT.

```sh
python3 scripts/application-snapshot.py restore application-snapshot-envelope.json restored-private-copy.db
python3 scripts/prepare-migration.py restored-private-copy.db migrated-private-copy.db
```

Both destinations must be new private files. The restore helper accepts only the eleven application tables plus an optional migration log, excludes authentication/session tables, preserves actual DDL/indexes, typed values, integer precision, rowids and autoincrement sequences, and verifies every imported cell/count and all seven gates plus integrity/foreign keys. Unsupported schema objects, changed columns, dirty-read isolation, incomplete envelopes or invalid rows fail closed. The snapshot is application-scoped, not a complete platform/authentication backup. File/engine settings outside that scope are not captured.

Return only the captured UTC time, snapshot/file checksums, complete table row counts and restore/migration validation results. Report transport/storage errors honestly. A private local restore does not prove the supported host restore path or isolated Dashboard DB API behavior; those still need their own rehearsal. Authoritative replica inventory and custody eligibility remain separate release requirements.

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

The known Solana-devnet mismatches are 1500 $BALD and 0.1 PUDSEC. A ledger-wide or per-asset release cap and owner signatures do not distinguish excess fungible tokens. Current code holds the entire historical mint identities CRWA5RPKt4gqXhWTQ5J3y6zpxbX99JkbyLquw66sR5c5 and HnaXwTXhPXW9WX1ivuAJ7whrb7BYVK3P4UMZ9GGxCVPL: no deposit credit, further mint, redemption or source/destination move may use them, including operator requests. Proof of reserves exposes eligibility_hold and known_excess. There is no environment override. Preserve balances/history; clearing the identity holds requires a separately reviewed reconciliation and policy change. Do not silently edit baselines, reset supply, choose a duplicate token identity or clear uncertain deployment claims.

### Historical Counterparty deposit claims

The historical database contains balance-based deposit keys in the form `xcp:<asset>:<amount>`. These do not collide with current `xcp:<transaction-hash>` keys. Current code refuses further deposit claims for an asset with any confirmed synthetic Counterparty credit, including operator claims, before adding credit or invoking a mint. Do not bypass this gate or rewrite balances. Map the old credits to independently verified public sends and durable consumed-claim records in a private proposal, preserve the historical rows, and send the concrete reconciliation plan for review before any production write or reopening.

## 4. Isolated staging acceptance

Inventory a separate database, test assets and signer/wallet authority first. Use worthless test assets and explicitly authorized test operations. Cover deposit -> owner-bound mint -> burn -> owner-bound redeem, plus chain moves and replay rejection. Verify the current composer produces the supported OLGA format and the managed signer preserves the validated transaction and valid vault signatures. Record actual transaction IDs and both chain/indexer confirmations before asserting success.

With at least two workers sharing the staging DB, pause a worker beyond the 30-second lease during first deployment and while an external result is ambiguous. Send duplicate and different operation keys concurrently. Inject DB outages and process restarts. Require one token identity, no repeated chain effect, no unbacked issuance and durable reconciliation for uncertainty. Local mocked-worker tests are regression evidence; they do not replace this platform soak.

## 5. Final release procedure

Return the evidence above to Codex for review against the exact PR head and green CI. Once the user's conditional live-update requirement is met, apply only the reviewed migration using supported platform tooling, deploy that exact commit, restart through the process manager and independently verify running SHA, schema readiness, worker count and maintenance/custody flags. The application-code deployment and custody reopening are separate decisions; keep custody closed during post-deployment checks. Preserve rollback evidence and do not discard events that occurred after the snapshot.
