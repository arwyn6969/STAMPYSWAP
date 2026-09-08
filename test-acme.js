// Live Phase-0 test of the ACME adapter against acme.pics (read-only; composeSend is a dry
// validation that should fail on funds, proving the call shape without moving anything).
const acme = require('./acme')

const VAULT_ISSUER = 'bc1qaxyjeazpx9ncm37kfz4v755tqhpnh9zwemmddy' // ACME issuer, holds ACME
// a real confirmed ACME send (from /assets/ACME/sends): source → destination
const SEND_SRC = 'bc1q3xtez50kpy3qlyljwg08r2us50t7q4lsrkwzz4'
const SEND_DST = 'bc1qp39s0ce2ftx0ayq97lvukfhq40l73wh8pe3lf8'

;(async () => {
  const out = {}

  // 1. lookupAsset — divisible + indivisible
  out.lookup_ACME = await acme.lookupAsset('ACME')
  out.lookup_SOAP = await acme.lookupAsset('SOAP')
  out.lookup_missing = await acme.lookupAsset('NOTAREALTICKER123')

  // 2. base<->whole round-trips (must match counterparty.js semantics)
  out.fromBase_div = acme.fromBase('70292755500000000', 8) // ACME supply → whole
  out.toBase_div = acme.toBase('702927555', 8)
  out.roundtrip_ok = acme.toBase(acme.fromBase('149000000000000000', 8), 8) === '149000000000000000'

  // 3. address balance (issuer holds ACME)
  out.balance_issuer_ACME = await acme.addressBalanceBase(VAULT_ISSUER, 'ACME')

  // 4. deposit check (tiny amount that the issuer clearly holds)
  out.checkDeposit_1_ACME = await acme.checkDeposit(VAULT_ISSUER, 'ACME', '1', 8)

  // 5. attribution — a known real send should resolve true
  out.sentToVault_known = await acme.sentToVault('ACME', SEND_SRC, SEND_DST)
  out.sentToVault_bogus = await acme.sentToVault('ACME', SEND_SRC, VAULT_ISSUER)

  // 6. chain height
  out.chainHeight = await acme.chainHeight()

  // 7. composeSend DRY — expect a validation error (insufficient funds) = correct call shape,
  //    nothing composed/broadcast. Proves redemption path is wired.
  try {
    const r = await acme.composeSend({ from: VAULT_ISSUER, toAddress: SEND_SRC, asset: 'ACME', qtyWhole: '1', dec: 8 })
    out.composeSend = { unexpected_success: !!r }
  } catch (e) {
    out.composeSend = { expected_error: String(e.message) }
  }

  console.log(JSON.stringify(out, null, 2))
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1) })
