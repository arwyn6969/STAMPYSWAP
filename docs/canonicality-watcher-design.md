# Canonicality & reorg CHECKER — DESIGN v3 (pure detection-only; NOT a live enforced watchdog)
Owner: review agent. Isolated branch codex/2026-10-20-canonicality-watcher. Disjoint from server.js, accounting, custody, CP/ACME validation, receipt-recovery/fencing (other agents). Emits {status,reasons,evidence}; no I/O; never resolves/fences/mints/releases. Operator-group independence is a CONFIG ATTESTATION, not proof. A separate reviewed integrator must supply trustworthy observations and enforce any pause.

## v3 closes 16 false-green classes (found by Codex in v2)
1-2. PROTOTYPE POLLUTION: all map lookups are own-property only (Object.prototype.hasOwnProperty); providerId "__proto__" / chain "__proto__" no longer resolve to inherited objects.
3. source.error RE-HONORED: an errored/cached-with-timeout source is unhealthy → excluded (never silently counted).
4. CROSS-CHAIN BINDING: an effect counts only if source.chain === effect.chain === anchor.chain AND the provider is policy-authorized for that chain; operator-group dedup is PER CHAIN (valid multi-chain observations are not globally rejected).
5. HEIGHT ORDERING: 0 <= anchor.height <= finalizedHeight <= tipHeight enforced; finalized>tip = impossible_finality; per-chain minConfirmations (finalized-height+1 >= minConfirmations).
6. AMOUNTS: amountBase must be an actual bounded decimal STRING (/^\d{1,40}$/); numbers are rejected, never String()-coerced.
7. CHAIN-SPECIFIC IDENTITY: idForm (tx/sig) validated SEPARATELY from hashForm (blockhash). Solana tx signature (64-byte base58, 64–90 chars) is distinct from a 32-byte blockhash/pubkey (32–45). evm/btc = 32-byte hex.
8. EFFECT KIND included in matching + anchor dedupe signature.
9-10. VERSIONED, BOUNDED POLICY: version===1; minIndependentSources int>=2; bounded now+maxObsAgeMs; non-empty chains/trustedProviders; trustedProviders authorize only known chains; expectedEffectIds = unique bounded non-empty strings. Malformed policy THROWS.
11. EXACT COVERAGE: any anchor whose effect_id is not in the inventory → unexpected_anchor; every inventory id must be present (omitted → missing_expected_anchor).
12. MALFORMED OBSERVATIONS/ANCHORS PAUSE, never crash (defensive guards; only policy throws).
13. DISAGREEMENT AFTER QUORUM: any present-but-different trusted same-chain source → trusted_source_disagreement → pause even if the match count reached quorum.
14. PROVIDER↔CHAIN AUTHORIZATION: a source on a chain its provider is not authorized for → provider_not_authorized_for_chain.
15-16. positive multi-chain + confirmation-depth paths verified.

## Policy (authoritative; validate-or-THROW)
{ version:1, minIndependentSources:int>=2, now:int(ms), maxObsAgeMs:int>0,
  chains:{<chain>:{ networkId, protocolVersion, idForm, hashForm, minConfirmations? }},
  trustedProviders:{<id>:{ operatorGroup, chains:[authorized...] }},
  expectedEffectIds:[unique bounded strings] }
idForm/hashForm ∈ { evm, btc, sol-sig, sol-hash }.

## Anchor / effect (exact identity)
anchor { effect_id, kind, chain, identity, assetId, height, blockHash, amountBase(string) }
effect { kind, chain, identity, assetId, height, blockHash, amountBase(string) }
Match requires kind + chain(bound to source) + identity + assetId + height + blockHash + amount(BigInt) ALL equal, finalized and >= minConfirmations, by >= minIndependentSources distinct operator groups on that chain, with no disagreeing trusted same-chain source.

## Caveats
Pure logic only. Operator-group/provider mappings are configuration attestations, not cryptographic proof of independence; a reviewed integrator must supply trustworthy observations and enforce the pause. 22/22 adversarial tests (all 16 classes + positives + multi-chain + confirmation depth).
