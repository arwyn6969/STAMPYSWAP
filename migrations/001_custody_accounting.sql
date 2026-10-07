-- StampySwap custody/accounting schema — versioned migration 001
-- Canonical DDL for the tables + indexes the recovery/solvency logic depends on. This is the schema
-- `migrateSchema()` VERIFIES at startup (it will not grant SCHEMA_OK until every object + uniqueness gate
-- below is present). The app server itself cannot run DDL (the Dashboard DB API blocks CREATE/ALTER), so
-- these statements are applied OUT OF BAND by an operator / the agent MCP db_execute path, then the app
-- verifies them. All statements are idempotent (IF NOT EXISTS) and match the live production schema.

-- Durable operation records (crash-safe idempotency for mints/moves). op_key UNIQUE = one op, one effect.
CREATE TABLE IF NOT EXISTS operations (
  op_key TEXT PRIMARY KEY,
  action TEXT, canonical_id INTEGER, amount TEXT, chain TEXT, recipient TEXT,
  state TEXT, tx_id TEXT, result_json TEXT, created_at INTEGER, updated_at INTEGER
);

-- Shared consume-once burn registry. burn_txid UNIQUE = one burn authorizes exactly one release/mint.
CREATE TABLE IF NOT EXISTS consumed_burns (
  burn_txid TEXT PRIMARY KEY,
  chain TEXT, canonical_id INTEGER, purpose TEXT, owner TEXT, amount TEXT, created_at INTEGER
);

-- Cross-process per-asset lock. asset_id UNIQUE (PK) so two holders cannot both acquire the same asset.
CREATE TABLE IF NOT EXISTS asset_locks (
  asset_id INTEGER PRIMARY KEY,
  holder TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);

-- Once-only accounting events: circulating_supply is the materialized SUM of these per representation.
-- event_key UNIQUE makes each logical debit/credit idempotent (a retried/lost-response write converges).
CREATE TABLE IF NOT EXISTS accounting_events (
  event_key TEXT PRIMARY KEY,
  rep_id INTEGER, delta_base TEXT, created_at INTEGER
);
-- Hot-path index: every solvency/PoR read sums a rep's events by rep_id.
CREATE INDEX IF NOT EXISTS idx_accounting_events_rep ON accounting_events(rep_id);

-- Collateral/representation ledger. The btc_txid uniqueness gate is a PARTIAL index (nulls allowed) — the
-- "unique when present" idiom, which migrateSchema accepts (a predicate on other columns/states would NOT
-- satisfy the gate). Stops two workers double-crediting the same deposit.
-- NOTE: collateral_ledger and representations/canonical_assets are created by the base app schema; this
-- migration (re)asserts only the uniqueness INDEX the recovery logic requires.
CREATE UNIQUE INDEX IF NOT EXISTS idx_collateral_btc_txid ON collateral_ledger(btc_txid) WHERE btc_txid IS NOT NULL;

-- Stamp-bridge operations. burn_txid UNIQUE = one burn, one stamp release.
CREATE TABLE IF NOT EXISTS bridge_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src20_tick TEXT NOT NULL, stamp_asset TEXT NOT NULL, amount TEXT NOT NULL,
  burn_txid TEXT NOT NULL UNIQUE, user_address TEXT NOT NULL, release_txid TEXT,
  status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER
);
