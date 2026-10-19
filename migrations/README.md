# Contained custody/accounting migration preparation

Migration 001 preserves the canonical custody/accounting DDL introduced with `110dc3c`. It assumes the base collateral, representation and canonical-asset tables exist. Migration 002 adds unqualified `UNIQUE(canonical_id,dest_chain)` and the event lookup index. Duplicate identities must be reconciled from evidence; the tool does not choose which token to keep.

Keep maintenance enabled and custody closed. Obtain an internally consistent deployment snapshot and record its checksum. Preserve its bytes unchanged. Prepare a separate local copy:

```sh
python3 scripts/prepare-migration.py snapshot.db migrated-copy.db
python3 -m unittest discover -s test -p '*_test.py' -v
```

The preparer opens the source read-only, refuses an existing destination, applies each migration with a checksum in a single transaction, validates the six existing uniqueness gates plus representation identity, and checks SQLite integrity and foreign keys. It preserves accounting events and removes a failed output copy. It does not bootstrap arbitrary historical schemas or adjust balances/baselines. Its tests are synthetic rehearsal, not production snapshot acceptance.

The production Dashboard API cannot apply DDL. The deployment operator must use supported platform tooling, provide resulting DDL and migration evidence, and validate supported query/execute envelopes and the new accounting query. The candidate startup gate fails closed until the representation constraint is present. No production database was migrated by this review.

Rollback requires custody to stay closed. With no intervening value operations, restore the untouched snapshot through the supported platform procedure, deploy prior contained code and verify status. If operations occurred since the snapshot, reconcile forward instead of discarding their events, burns and reservations. Never drop these records as a downgrade shortcut. Production restore rehearsal remains open.

First deployment owns a durable `representation-deploy:<asset-id>:<chain>` operation claim. An uncertain deployment intentionally remains claimed until its actual chain outcome and token identity are established. There is no automatic claim-reset endpoint. Existing verified identities continue using their registered token; a missing address blocks issuance.
