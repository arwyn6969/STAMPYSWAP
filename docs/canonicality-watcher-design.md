# Canonicality & reorg CHECKER — DESIGN v2 (pure detection-only; NOT a live enforced watchdog)
Owner: review agent. Isolated branch codex/2026-10-20-canonicality-watcher. Disjoint from server.js, accounting, custody, CP/ACME validation, and receipt-recovery/fencing (other agents). Emits {status,reasons,evidence}; does no I/O and never resolves/fences/mints/releases. A separate integrator supplies real observations and acts on the signal.

## v2 fixes (false-greens found in v1 by Codex)
- CE1 (empty args + minIndependentSources:0 → ok): POLICY is now STRICTLY VALIDATED and THROWS (non-bypassable) on anything malformed — quorum must be an integer >= 2; bounded freshness (now + maxObsAgeMs) required; chains/trustedProviders/expectedEffectIds must be non-empty.
- CE2 (provider-asserted/omitted expected values silently pass): ALL expected values now live in POLICY, never in observations. Expected networkId/protocolVersion/hashForm come from policy.chains[chain]; provider→operatorGroup from policy.trustedProviders (a CONFIG ATTESTATION, not proof of real independence). Observations carry only ACTUALS and are compared to policy. A source asserting its own expected values/fingerprint cannot pass.

## Authoritative policy (caller-supplied, validated or THROW)
{ minIndependentSources:int>=2, now:int(ms), maxObsAgeMs:int>0,
  chains:{<chain>:{ networkId, protocolVersion, hashForm:'evm'|'btc'|'solana' }},  // expected identity HERE
  trustedProviders:{<providerId>:{ operatorGroup }},                              // pin provider→operator HERE
  expectedEffectIds:[...] }   // REQUIRED inventory — empty/omitted can NEVER mean healthy

## Expected anchor (one per inventory effect)
{ effect_id, chain, identity(txid/sig), assetId, height, blockHash, amountBase(base-unit integer STRING) }

## Source observation (ACTUALS only; never trusted for expected values)
{ providerId(must be pinned in policy), chain, networkId, protocolVersion, historyComplete(===true),
  paginationComplete(===true), tipHeight, finalizedHeight, observedAt,
  effects:{ <effect_id>:{ chain, identity, assetId, height, blockHash, amountBase } } }

## Decision (fail-closed)
1. Each source healthy only if: provider pinned in policy; chain known; networkId & protocolVersion EQUAL policy; historyComplete & paginationComplete EXPLICITLY true; tip/finalized/observedAt are safe ints; observedAt not in the future and within maxObsAgeMs. Independence counted per distinct operatorGroup (config attestation, noted; relabeled same provider/group collapses to one).
2. Dedupe anchors; same effect_id with different content → duplicate_anchor_conflict.
3. For EVERY expectedEffectId: the anchor must be present (omitted → missing_expected_anchor) and well-formed (chain/identity/assetId/height/hash-form/amount-precision), then matched EXACTLY (chain+identity+assetId+height+blockHash+amount as BigInt) by >= minIndependentSources distinct operator groups whose finalizedHeight >= anchor.height. A present-but-different observation = conflict. Matching is on the full tx/asset/effect/amount/block identity, NOT a bare height→hash.
4. status 'ok' only if policy valid, enough independent healthy sources, and every expected anchor fully matched; else 'pause' with reasons.

## Chain-specific forms
evm 0x+64hex; btc 64hex; solana base58 (32–88). Extensible per chain in policy.

## Caveats (explicit)
Labels/fingerprints/operator-group mappings are CONFIGURATION ATTESTATIONS, not cryptographic proof of provider independence. This is pure logic — a separate, reviewed integrator must supply trustworthy observations and enforce the pause. 24/24 tests incl both counterexamples + malformed-policy/unsafe-amount/future-timestamp/duplicate/omitted/identity-mismatch negatives.
