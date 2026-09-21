// StampySwap — durable-recovery decision logic (audit R05 / F06 / F07).
//
// This module holds the PURE, side-effect-free decisions that make deposit→mint and cross-chain move
// crash-safe and resumable. It is deliberately I/O-free so it can be unit-tested in CI WITHOUT booting
// the server or touching the database (the historical blocker for "runtime prevention tests" was that
// this logic lived inside Express handlers that need a live DB + signers to reach). server.js requires
// these helpers; test/recovery.test.js exercises every branch.
//
// Model: an operation's durable identity is the DEPOSIT (ledgerKey) or the BURN (normalized txid) —
// NOT the recipient — so one deposit/burn can never mint to two addresses. The `operations` row's
// `state` is the source of truth for "did the mint finish": completed = done, reserved/reconcile =
// on-chain outcome unknown (never auto-retry → reconcile), absent = safe to (re)drive.

// Deterministic op keys. Keyed on the value's identity, not the target address.
function depositOpKey(ledgerKey) { return `deposit-mint:${ledgerKey}` }
function moveOpKey(normBurnTxid) { return `move-mint:${normBurnTxid}` }

// Decide what a deposit→mint retry should do given the prior op row (or null) and the retry's target.
//  - 'done'      : op completed → idempotent success, do not mint again.
//  - 'retarget'  : op is in-flight but was claimed for a DIFFERENT recipient → reject (deposit spoken for).
//  - 'reconcile' : op reserved/reconcile (on-chain outcome unknown) → never auto-retry; operator resolves.
//  - 'proceed'   : no op yet → safe to (re)drive the mint (idempotent via opReserve).
function resolveDepositOp(priorOp, receiveAddress) {
  if (!priorOp) return { action: 'proceed' }
  if (priorOp.state === 'completed') return { action: 'done' }
  if (priorOp.recipient && priorOp.recipient !== receiveAddress) return { action: 'retarget' }
  return { action: 'reconcile' }
}

// Decide what a move retry should do given the consumed-burn row (or null) for this burn.
//  - 'reject' : burn consumed by a redeem, or by a move of a DIFFERENT asset → not reusable here.
//  - 'resume' : burn already consumed by a move of THIS asset → source already decremented, re-drive
//               ONLY the destination mint (op-guarded).
//  - 'start'  : burn not consumed → first attempt (consume + decrement + mint).
function resolveMoveBurn(existingBurn, canonicalId) {
  if (!existingBurn) return { action: 'start' }
  if (existingBurn.purpose !== 'move' || existingBurn.canonical_id !== canonicalId) return { action: 'reject' }
  return { action: 'resume' }
}

module.exports = { depositOpKey, moveOpKey, resolveDepositOp, resolveMoveBurn }
