// StampySwap — on-chain provenance labels (audit: canonical cross-protocol identity).
//
// Pure, I/O-free, unit-tested. Kept OUT of recovery.js on purpose so the durable-recovery commit
// under independent re-verification stays byte-frozen.
//
// A representation's srcOrigin is written into the ERC-20 contract (and shown in trust views) as the
// asset's Bitcoin-native provenance. It MUST name the real source protocol — a protocol whose entire
// thesis is "one canonical identity across chains" cannot label an ACME or Counterparty asset as
// `bitcoin:src-20:...`. SRC-20 anchors provenance on its deploy transaction; Counterparty/ACME assets
// have no deploy tx (provenance = asset name + issuer), and their stored deploy_tx is already the
// synthetic `${protocol}:${tick}` key — so we don't append it (would double up, e.g. acme:acme:TREES).
function srcOriginFor(asset) {
  const proto = (asset && asset.source_protocol) || 'src-20'
  const tick = (asset && asset.exact_ticker) || ''
  if (proto === 'src-20') return `bitcoin:src-20:${tick}:${(asset && asset.deploy_tx) || ''}`
  return `bitcoin:${proto}:${tick}`
}

module.exports = { srcOriginFor }
