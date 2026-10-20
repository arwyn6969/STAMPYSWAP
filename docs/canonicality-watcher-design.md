# Canonicality & reorg CHECKER — DESIGN v5 (current) (pure detection-only; NOT a live enforced watchdog)
Owner: review agent. Isolated branch codex/2026-10-20-canonicality-watcher. Disjoint from server.js/accounting/custody/CP-ACME/fencing. Emits {status,reasons,evidence}; no I/O; never resolves/fences/mints/releases. Only policy THROWS; all data conditions PAUSE. Operator-group independence is a config attestation, not proof.

## v4 closes the 6 v3 false-greens (Codex)
1. BASE58 CASE-SENSITIVE: hex (evm/btc) compares case-insensitively; base58 (Solana) compares EXACTLY. Distinct-case base58 are distinct 32-byte values and no longer equated.
2. DECODE, not regex: base58 is decoded and required to be EXACTLY 32 bytes (hash/pubkey) or 64 bytes (signature) AND canonical (encode(decode(x))===x). '1'*44 / '1'*88 / a 64-byte value as a hash are rejected.
3. NO JSON.stringify of untrusted input: anchors/observations compared field-by-field; bigint/cyclic fields PAUSE (supplied_anchor_mismatch / malformed_anchor), never throw.
4. ORDER-INDEPENDENT CONTRADICTION: every trusted same-chain observation is scanned; ANY disagreeing/omitting qualified source → trusted_source_disagreement → pause regardless of order or whether a quorum otherwise matched. (first-wins removed.)
5. OMISSION = DISAGREEMENT: a healthy, authorized, completeness-complete same-chain source that OMITS an expected effect is an explicit disagreement (it attests the effect absent), not a silent skip.
6. BOUNDED/VERSIONED/SCALAR POLICY: version===1; minIndependentSources int[2,64]; bounded now/maxObsAgeMs; chains config must be plain objects with non-empty SCALAR networkId/protocolVersion (empty string / boolean / array rejected); expectedAnchors size [1,256]; provider chains bounded; anchors/sources arrays bounded. No broad catch-to-success.
7. CONTENT PINNED IN POLICY: policy.expectedAnchors is the TRUSTED manifest (kind/chain/identity/assetId/height/blockHash/amountBase) per effect. Supplied anchors must equal the manifest; labels alone (effect_id) do NOT pin content.

## Policy
{ version:1, minIndependentSources:int[2,64], now:int(ms), maxObsAgeMs:int(0,86400000],
  chains:{<chain>:{ networkId:scalar, protocolVersion:scalar, idForm, hashForm, minConfirmations? }},
  trustedProviders:{<id>:{ operatorGroup, chains:[authorized...] }},
  expectedAnchors:{<effect_id>:{ kind, chain, identity, assetId, height, blockHash, amountBase(string) }} }
idForm/hashForm ∈ { evm, btc, sol-sig(64B), sol-hash(32B) }.

## Match rule (per manifest effect)
qualified = healthy sources on the effect's chain (provider authorized). EVERY qualified source must positively attest and exactly match the manifest (kind+chain+identity+assetId+height+blockHash+amount, finalized within minConfirmations, 0<=height<=finalized<=tip); any omission/mismatch → disagreement → pause. Then require >= minIndependentSources distinct operator groups agreeing. Supplied anchor must equal the manifest. 21/21 adversarial tests (6 defect classes + order invariance both directions + content-pin + positives).

## Caveats
Pure logic. Provider/operator-group mappings and the manifest are trusted configuration supplied by a reviewed integrator, not cryptographic proof of independence; the integrator must supply trustworthy observations and enforce any pause. This is detection evidence, not a live watchdog.

## v5 — strict bounded own-data JSON schema at entry (narrow fixes, v4 regressions preserved)
- strictRecord(): every record (policy top-level, chain cfg, provider entry, source, effect, anchor) must be a PLAIN OWN-DATA object — prototype Object.prototype|null, no inherited fields, no accessor/getter properties (read via getOwnPropertyDescriptor, never invoked), only whitelisted known fields, bounded field count. Unknown fields rejected (exact unknown-field policy).
- Collection bounds everywhere: chains <=64, providers <=256, provider chains <=64, expectedAnchors <=256, effects-per-source <=256, anchors/sources arrays <=1024, fields-per-record <=32, per-field string/byte bounds (base58 decode + form validators).
- observedAt must be a NON-NEGATIVE integer (negative no longer passes freshness).
- Entry discipline: POLICY validation throws (outside any catch); OBSERVATION/ANCHOR validation exceptions are converted to FIXED pause reasons (source:<code>/anchor:<code>) — Object.create(validRecord) and throwing getters pause, never crash evaluate.
32/32 adversarial tests (all prior v1–v4 regressions + nested/unknown/oversized bounds + negative timestamp + inherited-field + throwing-getter + policy-throws-despite-bad-observations).

## v5.1 — policy-contract hardening (manifest + map keys)
- validatePolicy now returns a SANITIZED null-proto policy snapshot that evaluate() uses consistently (no accessor/inherited value re-read at evaluation time).
- Every chain cfg, provider entry, and expectedAnchors entry is strictRecord()'d (plain own-data, known fields only, no accessor/inherited). chains/providers/expectedAnchors maps must be plain own-data maps with bounded key names (chains key <=64, providers/manifest key <=128). Unknown manifest fields, Object.create(validEntry) entries, oversized unused keys, and accessor entries are all rejected (THROW — it's policy). Valid null-proto policy maps are accepted.
39/39 adversarial tests.
