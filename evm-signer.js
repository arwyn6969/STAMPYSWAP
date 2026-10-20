// Shared EVM signer with local nonce management. Many back-to-back testnet txs (mint,
// deploy pair, approves, addLiquidity) in one request race on nonce if each builds a fresh
// provider; a single NonceManager per chain increments locally and serializes them.
const { ethers } = require('ethers')
const { toEthersWallet } = require('@emblemvault/auth-sdk/signers/ethers')
const fs = require('fs')
const path = require('path')
const networks = require('./network-config')

const KEYPATH = path.join(__dirname, '.evm-deployer.json')
const RPC = Object.fromEntries(Object.entries(networks.EVM_CHAINS).map(([chain, config]) => [chain, process.env[config.rpcEnv] || config.defaultRpc]))

function loadWallet() {
  try { if (fs.existsSync(KEYPATH)) return new ethers.Wallet(JSON.parse(fs.readFileSync(KEYPATH, 'utf8')).privateKey) } catch (_) {}
  // FAIL LOUD (audit): never silently generate a NEW deployer key — a lost/unrestored key file
  // would strand funds at the old address. Set STAMPY_ALLOW_KEYGEN=1 only to intentionally init.
  if (process.env.STAMPY_ALLOW_KEYGEN !== '1') throw new Error(`FATAL: EVM deployer key ${KEYPATH} missing/unreadable — refusing to auto-generate a new key. Restore it, or set STAMPY_ALLOW_KEYGEN=1 to initialize a fresh one.`)
  const w = ethers.Wallet.createRandom()
  try { fs.writeFileSync(KEYPATH, JSON.stringify({ privateKey: w.privateKey, address: w.address }), { mode: 0o600 }) } catch (_) {}
  return new ethers.Wallet(w.privateKey)
}
let baseWallet
function wallet() { if (!baseWallet) baseWallet = loadWallet(); return baseWallet }
const _providers = {}
const _signers = {}

function provider(chain) {
  if (!_providers[chain]) _providers[chain] = new networks.CheckedEvmProvider(chain)
  return _providers[chain]
}
function signer(chain) {
  networks.requireIndependentSigning(chain)
  if (!_signers[chain]) _signers[chain] = new ethers.NonceManager(wallet().connect(provider(chain)))
  return _signers[chain]
}
// Emblem-managed EVM signer (the vault's EVM address, signed via Emblem — no raw key).
// Can sign contract CALLS (mint) but NOT deploys (Emblem ethers signer rejects null `to`).
const _emblem = {}
async function emblemSigner(chain) {
  networks.requireIndependentSigning(chain)
  await networks.assertEvmNetwork(provider(chain), chain)
  if (!_emblem[chain]) _emblem[chain] = await toEthersWallet({ apiKey: process.env.EMBLEM_API_KEY }, provider(chain))
  return _emblem[chain]
}
async function emblemAddress(chain) { try { return await (await emblemSigner(chain)).getAddress() } catch (_) { return null } }
// Serialize all EVM writes per chain so nonces are assigned in order even across modules.
// On error, reset the NonceManager so a failed/dropped tx doesn't desync later nonces.
const _chains = {}
function serialize(chain, fn) {
  const prev = _chains[chain] || Promise.resolve()
  const next = prev.catch(() => {}).then(fn).catch(err => {
    try { _signers[chain] && _signers[chain].reset() } catch (_) {}
    throw err
  })
  _chains[chain] = next.catch(() => {})
  return next
}

async function checkedProvider(chain) { const rpc = provider(chain); await networks.assertEvmNetwork(rpc, chain); return rpc }
module.exports = { provider, checkedProvider, signer, emblemSigner, emblemAddress, serialize, get address() { return wallet().address }, RPC }
