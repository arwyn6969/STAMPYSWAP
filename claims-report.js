'use strict'

// Read-only accounting evidence. This deliberately does not certify chain holdings,
// payout settlement, ownership of legacy deposits, or a complete customer-claims total.
const MAX_ROWS = 10000
const MAX_ASSETS = 256
const CHAINS = ['solana-mainnet', 'base-mainnet', 'ethereum-mainnet', 'solana', 'base', 'ethereum']
const TABLES = {
  canonical_assets: ['id', 'exact_ticker', 'source_protocol', 'decimals', 'max_supply'],
  representations: ['id', 'canonical_id', 'dest_chain'],
  accounting_events: ['event_key', 'rep_id', 'delta_base'],
  operations: ['op_key', 'action', 'canonical_id', 'amount', 'chain', 'state', 'tx_id'],
  collateral_ledger: ['id', 'canonical_id', 'direction', 'amount', 'dest_chain', 'btc_txid', 'burn_txid', 'dest_tx', 'status'],
  consumed_burns: ['burn_txid', 'chain', 'canonical_id', 'purpose', 'amount'],
  bridge_ops: ['id', 'src20_tick', 'stamp_asset', 'amount', 'burn_txid', 'status'],
}
// One SELECT/SQLite read snapshot. No independently paginated table reads: they can
// straddle reserved -> event or source debit -> destination credit transitions.
const SNAPSHOT_SQL = `SELECT 'snapshot_meta' AS table_name, json_object('read_uncommitted', (SELECT read_uncommitted FROM pragma_read_uncommitted), ${Object.keys(TABLES).map(table => `'${table}', (SELECT COUNT(*) FROM ${table})`).join(', ')}) AS record_json\nUNION ALL\n` + Object.entries(TABLES).map(([table, columns]) =>
  `SELECT '${table}' AS table_name, json_object(${columns.map(column => `'${column}', ${column}`).join(', ')}) AS record_json FROM ${table}`
).join('\nUNION ALL\n') + '\nLIMIT ?'

function invalid() { const error = new Error('claims report unavailable: incomplete or invalid accounting evidence'); error.code = 'CLAIMS_EVIDENCE_INVALID'; throw error }
function text(value, max = 512) { if (typeof value !== 'string' || !value.length || value.length > max) invalid(); return value }
function id(value) { if (!Number.isSafeInteger(value) || value <= 0) invalid(); return value }
function quantity(value, signed = false) {
  if (typeof value !== 'string' || !(signed ? /^-?\d{1,96}$/ : /^\d{1,30}(?:\.\d{1,18})?$/).test(value)) invalid()
  if (signed) return BigInt(value)
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'))
}
function normalizeBurn(chain, burn) { return chain === 'solana' || chain === 'solana-mainnet' ? burn : burn.toLowerCase() }
function blankBuckets() {
  return { circulating_event_base: 0n, issuance_reserved_without_event_base: 0n, completed_issuance_missing_event_base: 0n,
    matched_deposit_residual_base: 0n, debited_move_unreserved_remainder_base: 0n, potential_unpaid_redeem_after_debit_base: 0n,
    unallocated_accepted_deposit_base: 0n, accepted_deposit_awaiting_delivery_base: 0n,
    recorded_move_awaiting_delivery_base: 0n, recorded_pending_redeem_base: 0n, pending_redeem_included_in_circulation_base: 0n }
}
function parseSnapshot(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS + 1 || !rows[0] || rows[0].table_name !== 'snapshot_meta' || typeof rows[0].record_json !== 'string' || rows[0].record_json.length > 8192) invalid()
  let counts
  try { counts = JSON.parse(rows[0].record_json) } catch (_) { invalid() }
  if (!counts || Array.isArray(counts) || counts.read_uncommitted !== 0 || Object.keys(counts).sort().join(',') !== [...Object.keys(TABLES), 'read_uncommitted'].sort().join(',') ||
      Object.values(counts).some(count => !Number.isSafeInteger(count) || count < 0) || Object.values(counts).reduce((sum, count) => sum + count, 0) > MAX_ROWS) invalid()
  const tables = Object.fromEntries(Object.keys(TABLES).map(table => [table, []]))
  for (const row of rows.slice(1)) {
    if (!row || !Object.hasOwn(TABLES, row.table_name) || typeof row.record_json !== 'string' || row.record_json.length > 8192) invalid()
    let record
    try { record = JSON.parse(row.record_json) } catch (_) { invalid() }
    if (!record || Array.isArray(record) || typeof record !== 'object' || Object.keys(record).sort().join(',') !== [...TABLES[row.table_name]].sort().join(',')) invalid()
    tables[row.table_name].push(record)
  }
  for (const [table, records] of Object.entries(tables)) if (records.length !== counts[table]) invalid()
  return tables
}
function indexed(rows, key, check) {
  const map = new Map()
  for (const row of rows) { const value = check(row[key]); if (map.has(value)) invalid(); map.set(value, row) }
  return map
}
function buildClaimsReport(snapshot) {
  const t = parseSnapshot(snapshot)
  if (t.canonical_assets.length > MAX_ASSETS) invalid()
  const assets = new Map(), reps = indexed(t.representations, 'id', id), events = indexed(t.accounting_events, 'event_key', value => text(value, 4096))
  const ops = indexed(t.operations, 'op_key', value => text(value, 4096)), ledger = indexed(t.collateral_ledger, 'id', id)
  const consumed = new Map(), repSums = new Map(), matchedOps = new Set(), matchedBurns = new Set()
  const matchedEvents = new Set(), repIdentities = new Set(), mintOpsByTx = new Map(), mintReceiptLinks = new Set()
  for (const row of t.canonical_assets) {
    if (assets.has(id(row.id))) invalid()
    const asset = { id: row.id, ticker: text(row.exact_ticker), protocol: text(row.source_protocol, 64), decimals: row.decimals,
      registry_source_supply_base: row.max_supply == null ? null : quantity(row.max_supply),
      buckets: blankBuckets(), chains: new Map(CHAINS.map(chain => [chain, blankBuckets()])), findings: new Map(),
      ledger_confirmed_deposit_base: 0n, ledger_nonfailed_redeem_base: 0n }
    assets.set(row.id, asset)
  }
  function assetFor(canonicalId) { const asset = assets.get(id(canonicalId)); if (!asset) invalid(); return asset }
  function gap(asset, code, amount = null) {
    const finding = asset.findings.get(code) || { code, records: 0, quantity_base: 0n, quantity_complete: true }
    finding.records++
    if (amount == null) finding.quantity_complete = false
    else finding.quantity_base += amount
    asset.findings.set(code, finding)
  }
  function chainFor(asset, chain) {
    text(chain, 64)
    if (!asset.chains.has(chain)) {
      if (asset.chains.size >= 32) invalid()
      asset.chains.set(chain, blankBuckets()); gap(asset, 'unrecognized_chain_identity')
    }
    return asset.chains.get(chain)
  }
  function add(asset, bucket, amount, chain = null) {
    if (amount < 0n) invalid()
    asset.buckets[bucket] += amount
    if (chain != null) chainFor(asset, chain)[bucket] += amount
  }
  function eventFor(key, canonicalId, chain, expectedDelta) {
    const event = events.get(key)
    if (!event) return null
    const rep = reps.get(event.rep_id)
    if (!rep || rep.canonical_id !== canonicalId || rep.dest_chain !== chain || event.delta !== expectedDelta) invalid()
    matchedEvents.add(key)
    return event
  }
  for (const asset of assets.values()) {
    if (!Number.isSafeInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 18) gap(asset, 'source_precision_unverified')
    if (!['src-20', 'counterparty', 'acme'].includes(asset.protocol)) gap(asset, 'source_protocol_unverified')
    if (asset.registry_source_supply_base == null) gap(asset, 'registry_source_supply_unrecorded')
  }
  for (const rep of reps.values()) {
    const asset = assetFor(rep.canonical_id); chainFor(asset, rep.dest_chain)
    const identity = JSON.stringify([rep.canonical_id, rep.dest_chain])
    if (repIdentities.has(identity)) invalid()
    repIdentities.add(identity); repSums.set(rep.id, 0n)
  }
  for (const event of events.values()) {
    const rep = reps.get(id(event.rep_id)); if (!rep) invalid()
    event.delta = quantity(event.delta_base, true)
    repSums.set(rep.id, repSums.get(rep.id) + event.delta)
  }
  for (const rep of reps.values()) add(assetFor(rep.canonical_id), 'circulating_event_base', repSums.get(rep.id), rep.dest_chain)
  for (const op of ops.values()) {
    const asset = assetFor(op.canonical_id); chainFor(asset, op.chain)
    op.base = quantity(op.amount); text(op.action, 64); text(op.state, 64)
    if (op.tx_id != null) text(op.tx_id, 4096)
    if (op.action === 'representation-deploy') { if (op.base !== 0n) invalid(); continue }
    if (op.action !== 'mint') { gap(asset, 'unclassified_operation_action', op.base); continue }
    if (op.base <= 0n) invalid()
    op.event = eventFor('mint:' + op.op_key, op.canonical_id, op.chain, op.base)
    if (op.tx_id != null) {
      const identity = JSON.stringify([op.canonical_id, op.chain, op.tx_id])
      const matches = mintOpsByTx.get(identity) || []
      matches.push(op); mintOpsByTx.set(identity, matches)
    }
    if (!['reserved', 'reconcile', 'completed'].includes(op.state)) gap(asset, 'unclassified_mint_state', op.base)
    if (!op.event) {
      add(asset, op.state === 'completed' ? 'completed_issuance_missing_event_base' : 'issuance_reserved_without_event_base', op.base, op.chain)
      if (op.state === 'completed') gap(asset, 'completed_mint_missing_accounting_event', op.base)
    }
  }
  for (const row of ledger.values()) {
    assetFor(row.canonical_id); row.base = quantity(row.amount); text(row.direction, 64)
    if (row.status != null) text(row.status, 64)
    for (const field of ['btc_txid', 'burn_txid', 'dest_tx']) if (row[field] != null) text(row[field], 4096)
  }
  for (const burn of t.consumed_burns) {
    const asset = assetFor(burn.canonical_id); chainFor(asset, burn.chain)
    text(burn.purpose, 64); text(burn.burn_txid, 4096)
    burn.base = burn.amount == null ? null : quantity(burn.amount)
    const key = burn.chain + ':' + normalizeBurn(burn.chain, burn.burn_txid)
    if (consumed.has(key)) invalid()
    consumed.set(key, burn)
  }
  function matchBurn(row, purpose) {
    const txid = purpose === 'move' ? row.btc_txid : row.burn_txid
    if (!txid || !row.dest_chain) { gap(assetFor(row.canonical_id), 'burn_identity_not_recorded', row.base); return }
    const key = row.dest_chain + ':' + normalizeBurn(row.dest_chain, txid), burn = consumed.get(key)
    if (!burn) { gap(assetFor(row.canonical_id), 'consumed_burn_record_missing', row.base); return }
    if (matchedBurns.has(key) || burn.canonical_id !== row.canonical_id || burn.purpose !== purpose || (burn.base != null && burn.base !== row.base)) invalid()
    matchedBurns.add(key)
    if (burn.base == null) gap(assetFor(row.canonical_id), 'consumed_burn_quantity_unrecorded', row.base)
  }
  for (const row of ledger.values()) {
    const asset = assetFor(row.canonical_id)
    const statuses = { deposit: ['confirmed', 'pending', 'detected', 'failed'], 'move-out': ['pending', 'decremented', 'aborted', null], redeem: ['pending', 'reconcile', 'released', 'failed', null], mint: ['minted', 'simulated', null] }
    if (Object.hasOwn(statuses, row.direction) && !statuses[row.direction].includes(row.status)) gap(asset, 'unclassified_collateral_ledger_status', row.base)
    if (Number.isSafeInteger(asset.decimals) && asset.decimals >= 0 && asset.decimals <= 18 && row.direction !== 'mint' && row.base % (10n ** BigInt(18 - asset.decimals)))
      gap(asset, 'recorded_claim_exceeds_source_payment_precision', row.base)
    if (row.direction === 'deposit') {
      if (row.status !== 'confirmed') { gap(asset, 'unconfirmed_deposit_receipt_and_ownership_unverified', row.base); continue }
      asset.ledger_confirmed_deposit_base += row.base
      const op = row.btc_txid ? ops.get('deposit-mint:' + row.btc_txid) : null
      if (!op) {
        add(asset, 'unallocated_accepted_deposit_base', row.base)
        gap(asset, 'accepted_deposit_delivery_or_legacy_overlap_unverified', row.base)
        continue
      }
      if (op.action !== 'mint' || op.canonical_id !== row.canonical_id || op.base > row.base || matchedOps.has(op.op_key)) invalid()
      matchedOps.add(op.op_key)
      add(asset, 'matched_deposit_residual_base', row.base - op.base, op.chain)
      add(asset, 'accepted_deposit_awaiting_delivery_base', row.base - (op.event ? op.base : 0n), op.chain)
      if (row.base > op.base) gap(asset, 'deposit_rounding_residual_owner_and_disposition_unrecorded', row.base - op.base)
    } else if (row.direction === 'move-out') {
      if (!row.dest_chain) { gap(asset, 'move_source_chain_unrecorded', row.base); continue }
      chainFor(asset, row.dest_chain)
      if (row.status === 'aborted') { gap(asset, 'aborted_move_burn_entitlement_unverified', row.base); continue }
      matchBurn(row, 'move')
      const normalized = row.btc_txid ? normalizeBurn(row.dest_chain, row.btc_txid) : null
      const debit = normalized ? eventFor(`move-out:${normalized}:${asset.id}`, asset.id, row.dest_chain, -row.base) : null
      const op = normalized ? ops.get('move-mint:' + normalized) : null
      if (op && (op.action !== 'mint' || op.canonical_id !== row.canonical_id || op.base > row.base || matchedOps.has(op.op_key))) invalid()
      if (op) matchedOps.add(op.op_key)
      if (!debit) {
        gap(asset, 'move_burn_not_reflected_by_exact_source_debit', row.base)
        if (op) gap(asset, 'destination_operation_without_source_debit', op.base)
      } else {
        add(asset, 'debited_move_unreserved_remainder_base', row.base - (op ? op.base : 0n), op ? op.chain : null)
        if (!op) gap(asset, 'debited_move_destination_intent_unrecorded', row.base)
        else if (op.base < row.base) gap(asset, 'move_rounding_residual_owner_and_disposition_unrecorded', row.base - op.base)
      }
      add(asset, 'recorded_move_awaiting_delivery_base', row.base - (op && op.event ? op.base : 0n), op ? op.chain : row.dest_chain)
    } else if (row.direction === 'redeem') {
      if (!row.dest_chain) { gap(asset, 'redeem_source_chain_unrecorded', row.base); continue }
      chainFor(asset, row.dest_chain)
      if (row.status === 'failed') { gap(asset, 'failed_redeem_burn_and_payout_outcome_unverified', row.base); continue }
      asset.ledger_nonfailed_redeem_base += row.base
      matchBurn(row, 'redeem')
      const releaseDebit = eventFor('release:' + row.id, asset.id, row.dest_chain, -row.base)
      const legacyDebit = eventFor('legacy-redeem:' + row.id, asset.id, row.dest_chain, -row.base)
      if (releaseDebit && legacyDebit) invalid()
      const debit = releaseDebit || legacyDebit
      gap(asset, 'redeem_recipient_and_canonical_protocol_payout_proof_unrecorded', row.base)
      if (debit) add(asset, 'potential_unpaid_redeem_after_debit_base', row.base, row.dest_chain)
      else {
        add(asset, 'pending_redeem_included_in_circulation_base', row.base, row.dest_chain)
        if (row.status === 'released' || row.status == null) gap(asset, 'released_redeem_missing_exact_accounting_debit', row.base)
      }
      if (row.status === 'pending' || row.status === 'reconcile') add(asset, 'recorded_pending_redeem_base', row.base, row.dest_chain)
    } else if (row.direction === 'mint') {
      if (!row.dest_chain) { gap(asset, 'mint_receipt_destination_chain_unrecorded', row.base); continue }
      chainFor(asset, row.dest_chain)
      if (!row.dest_tx) { gap(asset, 'mint_receipt_accounting_or_legacy_overlap_unverified', row.base); continue }
      const identity = JSON.stringify([row.canonical_id, row.dest_chain, row.dest_tx])
      const candidates = mintOpsByTx.get(identity) || []
      // A receipt is evidence of possible issuance, not a second additive claim.
      // Require one exact operation/event, or the legacy direct transaction event.
      // Baseline overlap is deliberately not inferred from matching aggregate sums.
      const direct = eventFor('mint:tx:' + row.dest_tx, row.canonical_id, row.dest_chain, row.base)
      if (candidates.length > 1) { gap(asset, 'mint_receipt_operation_link_ambiguous', row.base); continue }
      const candidate = candidates[0]
      if (candidate && candidate.base !== row.base) invalid()
      if (direct && candidate && candidate.event && direct !== candidate.event) invalid()
      const exactEvent = candidate ? candidate.event : direct
      if (!exactEvent || row.status !== 'minted') {
        gap(asset, 'mint_receipt_accounting_or_legacy_overlap_unverified', row.base)
        continue
      }
      const link = candidate ? 'operation:' + candidate.op_key : 'event:' + exactEvent.event_key
      if (mintReceiptLinks.has(link)) invalid()
      mintReceiptLinks.add(link)
    } else gap(asset, 'unclassified_collateral_ledger_direction', row.base)
  }
  for (const op of ops.values()) if (op.action === 'mint' && /^(deposit-mint:|move-mint:)/.test(op.op_key) && !matchedOps.has(op.op_key))
    gap(assetFor(op.canonical_id), 'mint_operation_has_no_exact_origin_claim_link', op.base)
  for (const [key, burn] of consumed) if (!matchedBurns.has(key)) gap(assetFor(burn.canonical_id), 'orphan_or_unclassified_consumed_burn', burn.base)
  // Forward row -> event checks alone miss a recorded debit after its origin row
  // disappears, or a materialized mint with no surviving operation/receipt link.
  // Keep those exact amounts visible as overlapping origin-evidence findings;
  // they are not a newly proved customer-claims total. Historical baselines remain
  // circulation evidence without inventing a corresponding customer receipt.
  for (const event of events.values()) {
    const validBaseline = event.event_key === `baseline:${event.rep_id}` && event.delta >= 0n
    if (matchedEvents.has(event.event_key) || validBaseline) continue
    const asset = assetFor(reps.get(event.rep_id).canonical_id)
    gap(asset, event.delta < 0n ? 'accounting_debit_origin_unmatched' : 'accounting_credit_origin_unmatched', event.delta < 0n ? -event.delta : event.delta)
  }
  const bridges = indexed(t.bridge_ops, 'id', id)
  const bridgeClaims = []
  for (const row of bridges.values()) {
    text(row.src20_tick); text(row.stamp_asset); text(row.burn_txid, 4096); text(row.status, 64)
    bridgeClaims.push({ ledger_id: row.id, source_ticker: row.src20_tick, stamp_asset: row.stamp_asset, amount_base: quantity(row.amount).toString(),
      status: row.status, canonical_id: null, source_protocol: null, customer_paid_verified: false,
      gap: 'bridge_rows_lack_canonical_identity_and_canonical_protocol_payout_proof' })
  }
  function stringifyBuckets(buckets) { return Object.fromEntries(Object.entries(buckets).map(([name, amount]) => [name, amount.toString()])) }
  return {
    report_version: 1, read_only: true, accounting_snapshot_complete: true, amount_scale: 18,
    full_customer_claims_verified: false, full_customer_claims_base: null, chain_reconciled: false, release_ready: false,
    scope: 'all registered assets; all three mainnets and historical recorded chains; one bounded accounting snapshot',
    overlap_policy: 'circulation and unmaterialized issuance are disjoint; matched deposit/move remainders exclude both; awaiting-delivery and pending-redeem fields are informational overlaps, never additive totals',
    coverage_gaps: ['actual_chain_supplies_and_spendable_collateral_not_observed', 'host_snapshot_isolation_and_writer_topology_not_certified_by_report', 'unrecorded_deposits_burns_or_offledger_dust_cannot_be_enumerated',
      'no_canonical_protocol_payout_or_persisted_redeem_recipient_proof', 'legacy_deposit_delivery_overlap_not_inferable_from_backing_totals', 'no_complete_persisted_customer_ownership_and_dust_claim_registry'],
    assets: [...assets.values()].sort((a, b) => a.id - b.id).map(asset => ({
      canonical_id: asset.id, ticker: asset.ticker, source_protocol: asset.protocol, source_decimals: asset.decimals,
      registry_source_supply_base: asset.registry_source_supply_base == null ? null : asset.registry_source_supply_base.toString(),
      ledger_confirmed_deposit_base: asset.ledger_confirmed_deposit_base.toString(), ledger_nonfailed_redeem_base: asset.ledger_nonfailed_redeem_base.toString(),
      observed_chain_supply_base: null, observed_spendable_collateral_base: null, full_customer_claims_base: null,
      classification_complete: asset.findings.size === 0, buckets: stringifyBuckets(asset.buckets),
      chains: [...asset.chains].map(([chain, buckets]) => ({ chain, ...stringifyBuckets(buckets) })),
      findings: [...asset.findings.values()].map(finding => ({ code: finding.code, records: finding.records, quantity_base: finding.quantity_complete ? finding.quantity_base.toString() : null })),
    })),
    unallocated_stamp_bridge_claims: bridgeClaims,
    record_counts: Object.fromEntries(Object.entries(t).map(([table, rows]) => [table, rows.length])),
  }
}
async function readClaimsReport(query) { return buildClaimsReport(await query(SNAPSHOT_SQL, [MAX_ROWS + 2])) }
module.exports = { SNAPSHOT_SQL, MAX_ROWS, MAX_ASSETS, buildClaimsReport, readClaimsReport }
