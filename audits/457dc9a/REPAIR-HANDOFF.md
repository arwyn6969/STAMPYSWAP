# Repair handoff — independent audit of 457dc9a

Target: `457dc9ad52bbe3aa9b1a36dd646fa6080c602e39` (current GitHub main during review).

The label correction is verified for future EVM representations. Keep it. Maintenance/retirement, basic burn authorization, source precision, and selected recovery protections also passed local checks. **Do not treat the current recovery code or 13/13 test output as clearance to reopen custody.** See [AUDIT.md](AUDIT.md) for exact triggers, source locations, caveats and remaining gates.

## Next bounded repair batch

1. **Fix A01/A04 together:** transactional, exactly-once redemption finalization shared by normal release and reconciliation. Failed recovery must atomically restore retry entitlement, and migration must never resurrect a deliberately freed failed redemption. Verify crashes between every write and concurrent reconcile attempts.
2. **Fix A02/A05:** explicit deposit/move phases plus legacy operation-identity migration. Treat historical uncertainty as reconciliation, not permission to mint. Commit move burn claim, source debit and move record together. Inspect operation completion/uncertainty before new-mint solvency checks. Reject changed amount, asset, chain or recipient on retry.
3. **Fix A03/A06:** mandatory, request-bound operation identity and database-backed collateral reservations/conditional cleanup. Never delete a credit because this request originally inserted it. Test independent workers against one database, including the exact A-inserts/B-mints/A-cleans-up schedule. An unresolved mint must reserve its potential effect against further issuance.
4. **Fix A07:** reserve and persist release identity before signing/broadcasting. An accepted transaction with a lost response must not cause a second transfer. Apply to stamp release and ordinary redemption; use persistent UTXO reservation across workers.
5. **Fix A08/A09:** versioned DDL plus verified uniqueness constraints; synchronize package-lock, add handler/database tests and current CI. Separate live ACME smoke checks from the deterministic test command, and make success require meaningful assertions.

For each commit provide: exact SHA, mapped finding IDs, checked-in prevention tests, commands/results, and unresolved scope. Preserve the current protections and operator restrictions. Local mocked signers and SQLite make these failure tests possible without funding or accessing production.

## Acceptance examples

- Reconcile a 10-unit redemption after failure at either write boundary: circulation falls exactly once, independent of retries/restarts.
- Seed every old operation-key form, including a landed mint with missing accounting: retry never mints again.
- Two workers process one deposit: one credit, at most one mint, and collateral never disappears after issuance.
- Interrupt move immediately after burn reservation: retry completes required source accounting once before destination issuance; completed retry returns cached completion.
- Omitted operation identity is rejected before signing. Mismatched retries are rejected. Unknown outcomes block reissuance using that collateral.
- Unknown stamp broadcast response: persist uncertainty and reconcile/rebroadcast the same identified transaction as appropriate; no second transfer.
- Failed redemption remains retryable after startup migration. Claimed schema with missing uniqueness fails readiness.
- A fresh clone passes locked installation and deterministic tests. CI runs on that exact revision.

The next independent review must still cover entitlement (R04/F10), XCP attribution, move holder authorization, signature/PSBT intent validation, capability/UI integration, source identity/decimals, per-chain finality, and historical production reconciliation. These are existing gates, not newly introduced label defects.

## Reproduce this audit locally

Use Node with `node:sqlite` support. On the review machine, Node 23.3.0 requires `--experimental-sqlite`. Audit tests record local mocked effects only.

```sh
git clone https://github.com/arwyn6969/STAMPYSWAP.git /tmp/stampyswap-review-source
git -C /tmp/stampyswap-review-source checkout --detach 457dc9ad52bbe3aa9b1a36dd646fa6080c602e39
STAMPYSWAP_REVIEW_TREE=/tmp/stampyswap-review-source node --experimental-sqlite --test review-tests.cjs
```

The router harness additionally requires the repository's locked dependencies. `npm ci` currently fails because package.json added ESLint without updating the lock. To reproduce without silently repairing the audited source, install the **locked root manifest** in a separate temporary dependency directory:

```sh
mkdir -p /tmp/stampyswap-review-deps
cp /tmp/stampyswap-review-source/package-lock.json /tmp/stampyswap-review-deps/package-lock.json
node - <<'JS'
const fs = require('node:fs');
const lock = JSON.parse(fs.readFileSync('/tmp/stampyswap-review-deps/package-lock.json'));
fs.writeFileSync('/tmp/stampyswap-review-deps/package.json', JSON.stringify(lock.packages[''], null, 2));
JS
npm ci --prefix /tmp/stampyswap-review-deps --ignore-scripts --no-audit --no-fund
STAMPY_AUDIT_SOURCE=/tmp/stampyswap-review-source STAMPY_AUDIT_DEPS=/tmp/stampyswap-review-deps node --experimental-sqlite --test router-tests.cjs
```

Run from the extracted audit folder so `source-sha256.json` remains beside the router script. The local loopback server may require sandbox permission. No external indexer calls or custody keys are needed by either audit harness. The original project `npm test` does attempt optional external ACME reads; its captured output documents the misleading pass.

The tests named COUNTEREXAMPLE or OPEN currently pass by reproducing failures. Implement prevention assertions for the intended behavior; do not present this evidence suite's green result as a repaired application.
