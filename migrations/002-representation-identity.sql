-- Upgrade the known f864b81 schema. Existing duplicate identities must be reconciled first.
CREATE UNIQUE INDEX IF NOT EXISTS idx_representations_identity
ON representations(canonical_id, dest_chain);
CREATE INDEX IF NOT EXISTS idx_accounting_events_rep ON accounting_events(rep_id);
