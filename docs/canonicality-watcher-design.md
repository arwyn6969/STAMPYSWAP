# Canonicality & Reorg Watcher — DESIGN (offline, detection-only; no server/accounting edits)
Owner: me (review agent), SEPARATE offline candidate. Does NOT touch server.js, accounting mutation, custody, or op/reservation resolution (that is the other agents' receipt-recovery/fencing + full-claims scope). This module only OBSERVES and emits a PAUSE/OK decision + evidence; it never resolves, frees, mints, or releases.

## Purpose
Close the "continuous canonical backing + release verification" gate's DETECTION half: historical `status='confirmed'` rows are not ongoing proof. Persist canonical anchors and continuously re-verify deposits, source-asset validity, vault holdings, mints, burns and releases against synchronized sources; PAUSE on lag/disagreement/missing-history/reorg/unknown protocol. Never substitute a missing read with zero or cached success.

## Scope boundary (explicit, to avoid duplicate edits)
- IN: a pure decision function `evaluate(anchors, observations, policy) -> {status:'ok'|'pause', reasons:[...], evidence:{...}}`; an anchor schema; a multi-source agreement/freshness/pagination checker; a mock-driven test harness.
- OUT (other agents / later): wiring into server.js; pausing the live app; resolving/fencing stuck ops; full-claims accounting; Counterparty/ACME signed-byte validation. This module EMITS a signal; it does not act.

## Anchor record (persisted per tracked effect — proposed, not applied)
`{ effect_id, kind:'deposit'|'burn'|'mint'|'release'|'holding', chain, identity (txid/slot/address), observed_block_hash, observed_height_or_slot, observed_amount_base, source_set:[indexerIds], recorded_at }`
Stored append-only alongside the effect; the watcher compares live re-reads to these.

## Pure decision inputs (no I/O in the core)
- anchors: the recorded canonical anchors above.
- observations: per-source current readings {sourceId, tipHeight/slot, blockHashAt(height), amount, protocolVersion, paginationComplete, historyPresent, networkId}.
- policy: {minConfs per chain (BTC>=6, Eth finalized, Base L1-origin-final, Solana finalized), minSources>=2, maxTipLagSlotsOrBlocks, requireHistory:true}.

## PAUSE conditions (fail-closed; any one trips PAUSE)
1. networkId mismatch vs expected chain identity (genesis/chainId) on ANY source.
2. fewer than policy.minSources healthy sources agree on (blockHash@height / amount).
3. observed block hash at the anchor height differs from the recorded anchor hash → REORG.
4. an anchor's height/slot is no longer canonical / not yet final per policy.
5. tip lag beyond policy.maxTipLag, or tip older than a freshness bound (stale indexer).
6. missing history / incomplete pagination / unknown protocol version.
7. ANY source read error/timeout → treated as missing (NEVER zero/cached-success).
Output on trip: `{status:'pause', reasons:[codes], evidence:{per-source readings}}` — caller (later, other agent) decides to halt issuance/release; the watcher itself does nothing.

## Multi-source design
Require >=2 independent indexers/RPCs per chain; compare, don't trust one. Validate each source's network identity, tip freshness, and pagination completeness before counting it as "healthy". Disagreement = pause, not majority-vote override (conservative).

## Tests (mock-driven, no live calls)
Reorg (hash mismatch), not-yet-final, single-source-only, source-disagreement, stale tip, missing history, read-error-as-missing (not zero), happy-path OK with >=2 agreeing final sources. Pure functions → deterministic unit tests (node --test), no server, no DB.

## Status
DESIGN only. No code written pending ownership confirmation (to avoid colliding with the receipt-recovery/fencing agent). Live-source adapters + persistence + any pause ACTION are explicitly out of this module.
