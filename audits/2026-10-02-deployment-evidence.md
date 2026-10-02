# StampySwap — deployment evidence (redacted) · 2 October 2026

Prepared for independent confirmation that custody is closed and the deployed configuration matches
intent. No secrets, keys, seed phrases or operator tokens are included. Everything here is either (a)
directly reproducible by the auditor against the live app, or (b) read-only DB state.

## 1. Confirm the RUNNING revision + effective flags yourself

A public, read-only endpoint reports the **live process** (not the checked-out tree — serving static
files and restarting the backend are separate events):

```
GET /pub/kevmart/stampyswap/api/version
→ { sha, schema_ok, maintenance, custody_live, preview, operator_configured, instance_id, now }
```

- `sha` — the commit the running process was started from (from `git rev-parse HEAD` at boot).
- `maintenance:true` — every value/accounting route returns 503 to non-operators.
- `custody_live:false` — vault RELEASE is gated (deposits are still recorded; nothing is released).
- `preview:false` — sandbox simulation hooks are off.
- `operator_configured` — boolean only (whether an operator token is set); never the token itself.
- `instance_id` — changes per process start. Call `/api/version` twice: a **stable** id across calls
  indicates a single worker; **differing** ids indicate more than one process (relevant to the locking
  assumptions). Also confirm with the platform how many instances serve this artifact.

`GET /api/status` and `GET /api/custody/status` corroborate maintenance + custody state.

### Observed on the host at publish time (app port, bypassing the dashboard proxy)
```
GET /api/status          → {"service":"maintenance","maintenance":true, ...}
GET /api/custody/status  → {"managed":true,"live":false,"deposits_live":false,"service":"maintenance", ...}
```

## 2. Effective gating (how each is determined)

| Control | Source | Effective value | Evidence |
|---|---|---|---|
| Maintenance | env `STAMPY_MAINTENANCE` (default ON) | **ON** | `/api/status` maintenance:true |
| Custody release | env `STAMPY_CUSTODY_LIVE==1` **OR** `.custody-live` file | **GATED (off)** | `/api/custody/status` live:false; `.custody-live` file **absent** on disk |
| Preview sim hooks | env `STAMPY_PREVIEW` (default 0) | **off** | `/api/version` preview:false |
| Schema readiness | startup gate (`SCHEMA_OK`) | **true** | boot log `schema verified + burn backfill complete — SCHEMA_OK=true`; `/api/version` schema_ok:true |
| Solana mint authority | env `SOLANA_AUTHORITY` / `.solana-authority` (default emblem) | **emblem-managed** | `.solana-authority` file absent |
| EVM mint authority | env `EVM_AUTHORITY` / `.evm-authority` (default emblem) | **emblem-managed** | `.evm-authority` file absent |

Flag files on disk at publish time: `.custody-live` absent, `.operator-token` absent,
`.solana-authority` absent, `.evm-authority` absent. (Secret key files exist but are server-side only
and are NOT web-served; they are gitignored and never committed.)

## 3. Schema + the constraint gates the recovery logic depends on

Required tables all present; `migrateSchema` grants `SCHEMA_OK` only after verifying each of six
single-column uniqueness gates (composite and non-`IS NULL` partial indexes are rejected):

| Gate (must be UNIQUE on the column alone) | How enforced |
|---|---|
| `operations.op_key` | `PRIMARY KEY` |
| `consumed_burns.burn_txid` | `PRIMARY KEY` |
| `collateral_ledger.btc_txid` | partial unique index `… WHERE btc_txid IS NOT NULL` (the accepted "unique when present" idiom) |
| `bridge_ops.burn_txid` | inline `UNIQUE` |
| `asset_locks.asset_id` | `PRIMARY KEY` |
| `accounting_events.event_key` | `PRIMARY KEY` |

Hot-path index: `idx_accounting_events_rep ON accounting_events(rep_id)` (solvency/PoR sum events by rep).

Verbatim DDL (from `sqlite_master`):
```sql
CREATE TABLE operations (op_key TEXT PRIMARY KEY, action TEXT, canonical_id INTEGER, amount TEXT, chain TEXT, recipient TEXT, state TEXT, tx_id TEXT, result_json TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE consumed_burns (burn_txid TEXT PRIMARY KEY, chain TEXT, canonical_id INTEGER, purpose TEXT, owner TEXT, amount TEXT, created_at INTEGER);
CREATE TABLE asset_locks (asset_id INTEGER PRIMARY KEY, holder TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE accounting_events (event_key TEXT PRIMARY KEY, rep_id INTEGER, delta_base TEXT, created_at INTEGER);
CREATE INDEX idx_accounting_events_rep ON accounting_events(rep_id);
CREATE TABLE collateral_ledger ( id INTEGER PRIMARY KEY AUTOINCREMENT, canonical_id INTEGER NOT NULL, direction TEXT NOT NULL, amount TEXT NOT NULL, btc_txid TEXT, dest_chain TEXT, dest_tx TEXT, vault_address TEXT, confirmations INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER, burn_txid TEXT, FOREIGN KEY (canonical_id) REFERENCES canonical_assets(id), UNIQUE(direction, btc_txid, dest_tx) );
CREATE UNIQUE INDEX idx_collateral_btc_txid ON collateral_ledger(btc_txid) WHERE btc_txid IS NOT NULL;
CREATE TABLE bridge_ops ( id INTEGER PRIMARY KEY AUTOINCREMENT, src20_tick TEXT NOT NULL, stamp_asset TEXT NOT NULL, amount TEXT NOT NULL, burn_txid TEXT NOT NULL UNIQUE, user_address TEXT NOT NULL, release_txid TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER );
```

NOTE: the app cannot run DDL (the Dashboard DB API blocks CREATE/ALTER); schema + indexes are applied
out-of-band (operator/MCP). There is no versioned migration package committed yet — this is an
acknowledged outstanding item.

## 4. Outstanding operation inventory (read-only, at publish time)

| Item | Count |
|---|---|
| reserved/reconcile mint operations | 0 |
| pending/reconcile redemptions | 0 |
| pending move-outs | 0 |
| reserving/reconcile stamp-bridge ops | 0 |
| consumed burns | 0 |
| held asset locks | 0 |
| accounting events (all baselines) | 7 |

No uncertain/in-flight operations to reconcile.

## 5. Proof-of-reserves reconciliation (circulating is summed from the event ledger)

`circulating` is the authoritative SUM of `accounting_events` per representation; each of the 7 reps has
exactly one `baseline:<id>` event equal to its supply × 10^18, so events == displayed supply. All solvent:

| Asset | Deposits | Redeemed | Available | Circulating | Backed |
|---|---|---|---|---|---|
| $BALD | 142000 | 1500 | 140500 | 140500 | 100% |
| PUDSEC | 1 | 0.1 | 0.9 | 0.9 | 100% |
| BOSHI | 263777777777 | 0 | 263777777777 | 263777777777 | 100% |
| FAUXCORNCASH | 580001 | 0 | 580001 | 100000 | 580% |
| DANKROSECASH | 500000000 | 0 | 500000000 | 100000000 | 500% |
| ACME | 10000 | 1 | 9999 | 1000 | 999% |
| TREES | 420 | 0 | 420 | 110 | 381% |

Every asset: circulating ≤ available → solvent. (BTC-side vault custody addresses are shown by
`/api/custody/status`; independent chain-vs-vault reconciliation of on-chain balances is still an
outstanding release item.)

## 6. Still outstanding (not claimed done)

- Versioned schema/migration package + rollback procedure.
- Independent chain-vs-ledger reconciliation (on-chain vault balances vs recorded collateral).
- Confirmation of the number of serving instances (locking assumes the operator either runs single-writer
  or tolerates the DB-lock/lease + fail-closed read model; the reads are designed to fail closed either way).
- Lint/CI for the current application (not runnable in the build sandbox used for this evidence).
- Full SRC-20 semantic PSBT validation; dependency-advisory triage; staging soak of the full
  deposit → issuance → burn → withdrawal journey.

Custody remains CLOSED. This document is evidence for review; it is not a request to reopen anything.
