# STAMPYSWAP next repair handoff to Emblem

Please use the independent audit of **30 September 2026** as the current release assessment. Baseline: **`9689964dac19f4b45c5532a744bd3fd8dfe0daea`**. [Full report](AUDIT.md).

The latest nine commits include verified improvements, and the clean install, lint and 23 project tests pass. Public custody remains **not ready to reopen**. The attached independent suite completes 18 checks: 12 reproduce remaining failures and six verify selected fixes. An OPEN test passing means the defect is present.

Please retain one implementation owner and deliver reviewable commits with runnable evidence. Do not treat the previous note that only a small SRC-20 semantic check remains as a current release conclusion. The old edited React workspace is separate from the audited server.

## First provide the release baseline

Return the following without credentials, secret keys or seed phrases:

1. Latest pushed source revision and any work since `9689964`. Identify unpublished changes explicitly.
2. Intended first-release assets, source protocols, destination networks and enabled actions. Distinguish existing token trading, testnet wrapping and real mainnet custody.
3. Deployed revision and a staging URL. Report effective maintenance, preview and custody flags, including whether `.custody-live` exists; confirm the actual number of application workers/instances.
4. Schema and index definitions, migration history, and counts of reserved/reconcile operations, pending/reconcile redemptions, pending/aborted moves and uncertain stamp releases.
5. Whether the database interface supports atomic multi-statement transactions, and what guarantees it gives after a response timeout.
6. Signer policy relevant to Bitcoin fee/intent checking, transaction identity recovery and approval/authority control.
7. A gate-by-gate effort estimate and dependencies. Please base the date on a named release scope and acceptance evidence.

These are requests for evidence. The local audit did not independently verify the live deployment or balances.

## Batch 1 Make external effects and accounting recoverable

Findings: **B01–B05**, overlapping A01/A03/A05 and R05.

The central invariant is that confirmed issuance plus all issuance that may have happened must never exceed confirmed eligible collateral. A failed HTTP response does not establish that the underlying operation failed.

Implement:

- A durable reservation of backing before mint submission, retained across crashes and uncertain chain responses. Other operation keys must account for that reservation.
- A unique accounting event for each logical mint/debit, with atomic state changes or a rigorously recoverable alternative. An unknown database response must be resolved by that event identity; do not blindly repeat a delta.
- Coordination that survives a slow signer and lease expiry. An old holder must not issue after its authority expires or another holder takes over. Simply lengthening the lease is not adequate evidence.
- Correct representation creation failure handling. A generic database failure is not necessarily a uniqueness race. Verify accounting before returning or caching completed success.
- Truthful release and move phases. Failed accounting must remain visible and resumable; do not mark it terminal/decremented and discard a failed result.
- A mint-operation reconciliation action with immutable request binding and chain evidence. Listing unresolved operations is not enough to repair them.
- Recoverable transaction identity and reliable operation-completion persistence. Existing in-process locks alone do not resolve uncertain external execution.

If the current database service cannot support the required atomicity, state the limitation and propose the necessary storage/interface change. Do not label a sequence of unrelated HTTP writes transactional.

Acceptance must cover these exact schedules:

| Scenario | Required result |
|---|---|
| Worker A pauses after checking backing, its lease expires, B proceeds, then A resumes | At most one allocation/effect against the same remaining backing |
| Database commits a debit but loses its response | Exactly one debit, including after retries/restart |
| First destination representation insert fails after a mint | No completed success without accounting; backing stays reserved; recovery accounts for the existing mint |
| Mint is accepted but its RPC response is lost; another operation key is submitted | No second use of the uncertain issuance's backing |
| Circulation writes fail persistently during redeem or move | No false successful accounting phase; repair inventory retains the incomplete work |
| Process stops at every external-effect/accounting boundary | No duplicate external effect, missing liability or unrecoverable terminal row |

Add these as prevention tests that fail on the current defects. Run the whole server against database fixtures, not only isolated arithmetic helpers.

## Batch 2 Align schema, migration and recovery dispositions

Findings: **B06–B07**.

- Commit versioned fresh-install and upgrade schema definitions even if the live platform applies DDL separately.
- Verify the complete unique constraints used by the implementation, including `asset_locks.asset_id` and representation identity. Reject partial unique indexes that do not cover all relevant operation states.
- Define historical NULL redemption statuses. Preserve burns for released/unknown outcomes; respect explicit failed/retryable resolutions.
- Ensure aborted moves stay retryable after migration and that a later legitimate retry can progress its existing row correctly.
- Make burn release, ledger disposition and accounting changes safe under restart, lost responses and competing workers.
- Reconcile real historical rows and source/chain evidence before release; do not solve uncertainty by deleting reservations.

Acceptance:

- A lock table without an asset primary/unique key keeps writes closed.
- `UNIQUE(op_key) WHERE state='completed'` does not satisfy reservation uniqueness.
- Two reservations for one logical operation cannot both be fresh.
- Restart cannot reconsume a deliberately aborted move burn.
- A historical NULL-status redeemed burn cannot be reused.
- Repeated migration is safe, incomplete migration keeps writes closed, and uncertain legacy rows have an explicit repair outcome.

The malformed-schema and NULL-status tests establish conditional risks. Supply actual production schema/history evidence rather than assuming those exact fixtures exist live.

## Batch 3 Validate complete Bitcoin signing intent

Finding: **B09** and the retained signing/UTXO requirements.

The current SRC-20 output caps permit a PSBT with a 1,000,000-satoshi declared input, 546 satoshis of vault change, no transfer payload and a 999,454-satoshi implied miner fee to reach the signer.

- Independently establish the selected inputs, ownership and values.
- Enforce both an absolute fee limit and a fee-rate policy.
- Decode and match protocol, asset, amount, recipient and allowed outputs to the authorized operation.
- Validate requested signing flags and input selection.
- Coordinate UTXOs across the supported deployment model and persist enough identity to recover accepted broadcasts.
- Retain fail-closed parsing and the existing non-vault output caps.

Provide sanitized real composition samples and offline tests for valid transfers, altered amount/asset/recipient, missing payload, excessive fees, wrong inputs, malformed data and unexpected signing flags. Explain any additional Emblem signer-side protection with evidence. The audit's signer was mocked; it did not prove what the live signer would accept.

## Batch 4 Complete the chosen product scope and release gate

Finding: **B08**, mainnet build/network gaps and operational requirements.

- Implement withdrawal and move wallet flows with burn transaction identity and exact owner-bound signatures. The current form functions return 401 when tested against enabled eligible handlers.
- Present explicit supported asset/network routes. Do not show a usable mainnet wrapping path when the mint adapter only supports testnets.
- Make the mainnet contract build reproducible from the locked install, including pinned OpenZeppelin sources and artifact checks.
- Verify actual Solana mint metadata and preserve existing mint identity on transient RPC errors. Define and test per-chain finality/reorg treatment for the chosen release.
- Add current-application CI for installation, lint, deterministic tests, schema/upgrade fixtures and contract generation. Pin the test/runtime environment.
- Triage the saved dependency advisories by runtime reachability and safe remediation; record justified residual risks.
- Demonstrate deposit → issuance → burn → withdrawal, move where supported, retry, maintenance and recovery through the actual staging UI.
- Supply reconciliation of source deposits, on-chain supply, vault assets, releases and all uncertain operations, plus monitoring and incident/recovery procedures.
- Verify authority/approval controls and the actual deployment configuration against the intended release.

A narrow first launch may explicitly disable unfinished routes. It must still satisfy the accounting and recovery requirements for every enabled path.

## Delivery and re-audit

For every B finding, return: status, repair commit, source location, prevention test name, command/output, migration/deployment prerequisite and residual limitation. Include CI results for the exact proposed release revision.

Keep historical evidence unchanged. The independent harness is pinned to `9689964`; it should reject different source. To test fixes, port the scenarios into the project's prevention suite, or intentionally pin a separate verification harness to the repaired revision. Do not remove pinning and reuse green OPEN assertions as proof of repair.

To reproduce the current report in an isolated copy:

```sh
git clone https://github.com/arwyn6969/STAMPYSWAP.git /tmp/stampyswap-9689964-review
git -C /tmp/stampyswap-9689964-review checkout --detach 9689964dac19f4b45c5532a744bd3fd8dfe0daea
cd /tmp/stampyswap-9689964-review
npm ci --ignore-scripts --no-audit --no-fund
npm run lint
npm test
STAMPY_AUDIT_SOURCE=/tmp/stampyswap-9689964-review node --experimental-sqlite --test /path/to/unpacked-audit/release-readiness.test.cjs
```

Use an available runtime with `node:sqlite`; the independent checks ran on Node v23.3.0. The audit files must remain together beside their source-hash manifest. No production credentials or funded wallets are needed. The tests use loopback HTTP, real local SQLite and fixed test keys with mocked chain effects.

Please deliver the accounting and schema design first, then implementation and evidence. After the repair gates and staged product checks pass, freeze a release candidate for independent review. This handoff has been prepared for the project owner to send; no message has been sent automatically.
