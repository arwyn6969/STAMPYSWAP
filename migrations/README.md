# StampySwap schema migrations

Versioned, idempotent DDL for the custody/accounting schema. The app server **cannot** run DDL (the
Dashboard DB API blocks `CREATE`/`ALTER`), so migrations are applied **out of band**, then the running
app **verifies** them at startup and only grants `SCHEMA_OK=true` once every object + uniqueness gate is
present. Until then all value/accounting writes stay contained (fail-closed), independent of the
maintenance flag.

## Files
- `001_custody_accounting.sql` — operations, consumed_burns, asset_locks, accounting_events (+ its
  `rep_id` index), the `collateral_ledger.btc_txid` partial-unique index, and bridge_ops.

## Apply procedure
Apply each statement in order via the operator path (agent MCP `db_execute`, or the Dashboard DB API
with CREATE privileges). All statements are `IF NOT EXISTS`, so re-running is safe.

```sh
# example via the agent MCP path (one statement per db_execute call)
# then confirm the running app re-verifies on its next schema check:
curl -s https://<host>/pub/kevmart/stampyswap/api/version   # expect "schema_ok": true
```

The running app re-checks the schema on a background interval (`ensureSchema`), so after the DDL is
applied `schema_ok` flips to true within ~15s without a restart.

## The six uniqueness gates `migrateSchema` enforces (SCHEMA_OK stays false unless ALL hold)
| object.column | required form |
|---|---|
| `operations.op_key` | PRIMARY KEY |
| `consumed_burns.burn_txid` | PRIMARY KEY |
| `collateral_ledger.btc_txid` | UNIQUE index, partial predicate `WHERE btc_txid IS NOT NULL` (the only accepted partial form) |
| `bridge_ops.burn_txid` | inline UNIQUE |
| `asset_locks.asset_id` | PRIMARY KEY |
| `accounting_events.event_key` | PRIMARY KEY |

The gate **rejects** composite uniqueness (e.g. `UNIQUE(a,col)`) and non-`IS NULL` partial indexes
(e.g. `UNIQUE(op_key) WHERE state='completed'`) — those do not guarantee full-column uniqueness.

## Rollback / forward-repair
These tables are additive and carry live custody accounting; **do not drop** them to "roll back". To
forward-repair a bad constraint, create the correct index under a new name and drop the incorrect one in
a dedicated, reviewed migration. Never drop `accounting_events` rows (they are the authoritative supply
ledger and their keys must stay unique to remain idempotent against lost-response retries).
