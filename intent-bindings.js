'use strict'

// Pure, deterministic signing intents. Every authorization names one exact transaction
// and action; the server must still verify it on-chain and consume its identity once.
// JSON encoding prevents ticker/address text from injecting or replacing another field.
// There is deliberately no acceptance path for the older, incompletely bound messages.
const CHAINS = new Set(['solana', 'solana-mainnet', 'base', 'base-mainnet', 'ethereum', 'ethereum-mainnet'])
const PROTOCOLS = new Set(['src-20', 'counterparty', 'acme'])
function text(value, field) {
  if (typeof value !== 'string' || !value || value.length > 4096)
    throw new Error(`intent ${field} must be a nonempty exact string`)
  return value
}
function chain(value) {
  if (!CHAINS.has(value)) throw new Error('intent representation chain is unsupported')
  return value
}
function amount(value) {
  if (typeof value !== 'string' || !/^\d{1,30}(\.\d{1,18})?$/.test(value)) throw new Error('intent amount must be an exact positive decimal string')
  const [whole, fraction = ''] = value.split('.')
  const units = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'))
  if (units <= 0n) throw new Error('intent amount must be positive')
  const decimal = fraction.replace(/0+$/, '')
  return BigInt(whole).toString() + (decimal ? '.' + decimal : '')
}
function assetIdentity(asset) {
  if (!asset || !PROTOCOLS.has(asset.source_protocol)) throw new Error('intent source protocol is unsupported')
  return { chain: 'bitcoin-mainnet', protocol: asset.source_protocol,
    ticker: text(asset.exact_ticker, 'asset ticker'), deploy_identity: text(asset.deploy_tx, 'asset deploy identity') }
}
function intent(action, values) {
  return { version: 1, action, domain: { application: 'StampySwap', group: text(values.group, 'group') },
    asset: assetIdentity(values.asset), custody: { chain: 'bitcoin-mainnet', vault: text(values.vault, 'vault') } }
}
function message(value) { return 'StampySwap authorization v1\n' + JSON.stringify(value, null, 2) }
function depositMessage(values) {
  return message({ ...intent('deposit', values),
    source: { chain: 'bitcoin-mainnet', address: text(values.sourceAddress, 'deposit source'), txid: text(values.depositTxid, 'deposit txid') },
    destination: { chain: chain(values.destinationChain), address: text(values.destinationAddress, 'mint recipient') }, amount: amount(values.amount) })
}
function redeemMessage(values) {
  return message({ ...intent('redeem', values),
    source: { chain: chain(values.sourceChain), representation: text(values.representation, 'burn representation'), txid: text(values.burnTxid, 'burn txid') },
    destination: { chain: 'bitcoin-mainnet', address: text(values.destinationAddress, 'release recipient') }, amount: amount(values.amount) })
}
function moveMessage(values) {
  const sourceChain = chain(values.sourceChain), destinationChain = chain(values.destinationChain)
  if (sourceChain === destinationChain) throw new Error('intent move chains must differ')
  return message({ ...intent('move', values),
    source: { chain: sourceChain, representation: text(values.representation, 'burn representation'), txid: text(values.burnTxid, 'burn txid') },
    destination: { chain: destinationChain, address: text(values.destinationAddress, 'mint recipient') }, amount: amount(values.amount) })
}

module.exports = { depositMessage, redeemMessage, moveMessage }
