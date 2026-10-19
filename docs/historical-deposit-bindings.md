# Historical deposit binding review copies

Historical Counterparty credits use balance-based `xcp:<asset>:<amount>` identities. Their real sends must never become second collateral credits or another mint. `scripts/prepare-deposit-bindings.py` prepares additive consumed-deposit aliases in a **new private database copy** for review. It neither installs that copy nor removes the application's asset-wide reconciliation gates. The Solana identity holds also stay in place. This is no production reconciliation command.

Use an immutable, closed, application-only snapshot that has already passed the migration-copy checks. Keep authentication tables, private keys and sessions out. Review the exact public send evidence and proposal first; independently record the proposal's SHA256 and the existing source-copy SHA256. A matching proposal hash pins what was reviewed; the preparer does not query a chain or verify proof of source ownership itself.

The proposal has `evidence_sha256` and a nonempty `claims` list. Each claim supplies `legacy_ledger_id`, `canonical_id`, `asset`, `legacy_key`, `claim_key` (`xcp:` plus the lowercase 64-character `tx_hash`), `tx_hash`, `source_chain` (`bitcoin`), `source_protocol` (`counterparty`), `source_address`, `vault_address`, decimal-string `amount`, integer `source_decimals`, integer-string `quantity_base`, positive `block_index`, and `preserve_original_row: true`. Source/evidence provenance and the choice of legacy-to-real-send mapping require independent review; they are not inferred from aggregate vault balance.

Run in private scratch, with real reviewed hashes supplied explicitly:

```sh
python3 scripts/prepare-deposit-bindings.py \
  immutable-migrated-copy.db reviewed-proposal.json new-bound-review-copy.db \
  --source-sha256 "$REVIEWED_SOURCE_SHA256" \
  --proposal-sha256 "$REVIEWED_PROPOSAL_SHA256"
```

The tool refuses existing destinations, symlinks, active journal sidecars, auth/unexpected tables, missing gates, mismatched canonical/credit/vault/precision/amount fields, duplicate/conflicting mappings, pre-existing real-send collateral or operations, and partially covered synthetic credits for an affected asset. It opens the source read-only and changes only the new copy in one transaction. New files are private (`0600`). It checks every alias by readback, all original table rows/schema/sequence values, indexes/triggers, integrity, foreign keys and seven uniqueness gates. The source hash is checked again before committing. A failed output is removed. Repeating from a successfully bound copy with the same proposal preserves the existing aliases and all accounting.

The separate `consumed_deposits` namespace uniquely binds each real claim and each legacy ledger row, with foreign keys, exact evidence/proposal hashes and triggers rejecting updates/deletions. It does not use `consumed_burns`, fabricate a mint operation, or claim that all historical deposited units were minted. No production mutation or gate removal follows automatically. Runtime adoption requires a separate reviewed change that rejects every aliased send before credit/mint, covers every confirmed synthetic row, and passes multi-worker/fault staging checks.

Updated snapshot/manifest preparers recognize this optional namespace and require its exact immutability triggers. A capture built from an old schema export refuses acceptance if it would omit any existing approved application table, including an alias or migration registry. Always export the complete current approved table/index/trigger schema. Lossless application snapshot restore retains aliases, migration checksums, triggers, indexes and sequences. Keep the original eleven-table snapshot unchanged. Do not run the old snapshot helpers against a bound copy, and do not assume a table-only platform manifest preserves triggers: the platform backup/restore procedure must independently prove this before being used. No manifest is installed by these tools.

Local tests cover source/accounting preservation, repeated preparation, two-connection uniqueness and immutability, proposal/source hash failures, identity/precision/vault/amount mismatches, existing real credit/operations, partial coverage, post-insert rollback, destination/symlink protection, auth/journal exclusion, conflicting aliases, and lossless snapshot round trips with counters above current row IDs. These are private-copy tests, not a host DB API, signing or staging journey result.
