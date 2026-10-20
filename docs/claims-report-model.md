# Read-only customer-claims accounting report

`GET /api/claims` requires the existing operator credential, accepts no query parameters and returns `Cache-Control: no-store`. It performs no database write, RPC query, signer access, configuration change or financial action. All mainnet release holds remain closed. This report advances accounting observability; it does **not** finish the full customer-claims software or external reconciliation gates.

## Snapshot and integer guarantees

`claims-report.js` reads the actual fields in `canonical_assets`, `representations`, `accounting_events`, `operations`, `collateral_ledger`, `consumed_burns` and `bridge_ops` using one SQLite SELECT. A metadata row in that same statement carries every table count and `read_uncommitted`. Count mismatches, omitted/truncated rows, dirty-read mode, malformed envelopes, inconsistent quantity/event links and duplicate identities refuse the whole report. There is no catch-to-zero or partial-success response.

The report is bounded to 10,000 total source records, 256 assets, 32 observed chain identities per asset and 8,192 bytes per decoded source record. Hitting a bound returns 503 rather than a partial set of liabilities. A larger deployment needs a separately reviewed consistent snapshot/export path. Quantity inputs are bounded decimal/integer strings; all arithmetic uses BigInt. Output quantities are exact strings in an explicit **18-decimal common accounting scale**, never JS numbers or rounded display strings. The three mainnet and three historical devnet/Sepolia chain identities are included for every asset; additional recorded chains are visible with an unrecognized-identity finding.

One-statement SQLite behavior and a refused dirty-read setting reduce inconsistent-read risk, but this endpoint cannot independently certify the host's connection management, isolation, writer inventory or transport implementation. Those remain host acceptance evidence.

## How overlapping states are separated

The following state buckets refer to recorded accounting evidence. They are not a complete or chain-verified claim valuation.

| Bucket | Rule and overlap |
| --- | --- |
| `circulating_event_base` | Sum every signed accounting event per representation, then aggregate by exact asset/chain. A negative per-representation sum is invalid, even if another representation is positive. Display supply caches are not read. |
| `issuance_reserved_without_event_base` | Mint operation amount while its exact `mint:<op_key>` event is absent. A materialized mint event removes it from this bucket even if operation completion persistence is delayed. |
| `completed_issuance_missing_event_base` | A completed mint operation without its event remains potential unaccounted issuance; it is not silently treated as paid or zero. |
| `matched_deposit_residual_base` | Exact confirmed deposit minus its exact deterministic deposit-mint operation amount. The operation amount is already in event circulation or the issuance bucket, so it is excluded here. Any residue has unrecorded ownership/disposition and remains a finding. |
| `debited_move_unreserved_remainder_base` | Source move amount minus the destination mint operation amount, but only when the exact source-debit event exists. With no destination operation, the full debited amount is retained and the missing destination intent is explicit. With a reservation, that reservation covers its portion; with a destination event, circulation covers it. |
| `potential_unpaid_redeem_after_debit_base` | Redemption amount removed by the exact release/legacy-debit event whose actual protocol payout has not been independently proved. This includes rows marked `released`: database status and a txid do not prove customer settlement. These quantities may already have been paid on-chain and must remain conditional evidence. |
| `unallocated_accepted_deposit_base` | Confirmed deposits with no exact deterministic operation link. A legacy deposit might already back a baseline event, or a new credit might await delivery. Its amount is shown separately and must **not** simply be added to circulation/reservations. |

`accepted_deposit_awaiting_delivery_base`, `recorded_move_awaiting_delivery_base`, `recorded_pending_redeem_base` and `pending_redeem_included_in_circulation_base` are **informational overlapping views**, not additional summands. A pending redemption without a debit remains in the event accounting model; adding its entire amount again would double-count. A phase-only `decremented` move with no exact debit produces a finding and does not manufacture a successful debit.

The API deliberately emits **no single confident customer-claims total, collateral observation, headroom or solvent verdict**. `full_customer_claims_base` and observed on-chain supply/spendable collateral are null; `full_customer_claims_verified`, `chain_reconciled` and `release_ready` are false. Asset `classification_complete` describes whether these recorded rows had classification findings; it never overrides those global unknowns. Registry supply and historical deposit/redeem totals are labeled database quantities, not current source supply or actual backing.

## Current schema gaps exposed, not guessed

- Confirmed deposits do not persist a complete owner/delivery/refund linkage. Matching current rows by timestamp, aggregate backing, ticker alone or current owner would invent evidence. Legacy-format operation keys and unmatched origin operations remain reconciliation findings.
- Redeem inserts do not durably persist the intended Bitcoin recipient. A caller-supplied `release_txid` cannot reconstruct the original signed intent or prove the exact source-protocol recipient/asset/quantity was paid. Every such payout remains unverified regardless of row status.
- Source-debit and destination-mint events can establish a recorded move partition; they do not supply a missing destination intent or canonical burn proof. Orphan consumed burns, unrecorded burn quantities, phase/debit disagreement, failed redeems and aborted moves remain explicit findings.
- Deposit/move residues can be measured where exact operation links exist, but the schema has no complete customer-owned dust registry, refund state or settled-disposition proof. Off-ledger dust and claims never recorded in the database cannot be enumerated by this report.
- `bridge_ops` has ticker/name fields but no canonical asset ID/source protocol or verified payout record. Those quantities appear separately as `unallocated_stamp_bridge_claims`, with null identity and `customer_paid_verified:false`. No collided ticker is guessed into an asset ID.
- The endpoint does not observe Bitcoin collateral, source-indexer canonicality, destination supplies, signed-but-unrecorded work or protocol payout finality. Completing those requires the independent signer journal, durable original intents, receipt/canonicality verification and actual host/provider evidence described in `mainnet-release-gates.md`.

Alongside this report, both authoritative circulation readers and `applyCirculatingDelta` reject negative event balances. An overdrawn delta never reports success or rewrites the display cache to zero; its invalid ledger evidence remains visible and further financial decisions fail closed.

## Local validation scope

The dedicated fixture suite uses real local SQLite and HTTP routing with mocked chains/signers. It tests auth/no-input bounds, one-query/no-write behavior, reservation-to-event interleavings, exact deposit/move partitions, retained dust, unverified released redeems, legacy overlap, orphan and stamp claims, completed operations missing events, all-asset/three-mainnet/historical scope, quantities beyond Number precision, malformed quantities, query failures/redaction, truncation/count mismatches, dirty-read refusal, record caps and negative/overdrawn event balances. None of these checks asserts production deployment, live holdings or readiness to open mainnet.
