# Canonicality & reorg CHECKER — DESIGN v4 (pure detection-only; NOT a live enforced watchdog)
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
