// Shared EVM signer with local nonce management. Many back-to-back testnet txs (mint,
// deploy pair, approves, addLiquidity) in one request race on nonce if each builds a fresh
// provider; a single NonceManager per chain increments locally and serializes them.
const { ethers } = require('ethers')
const { toEthersWallet } = require('@emblemvault/auth-sdk/signers/ethers')
const fs = require('fs')
const path = require('path')

const KEYPATH = path.join(__dirname, '.evm-deployer.json')
const RPC = {
  base: process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org',
  ethereum: process.env.ETH_SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com',
}

function loadWallet() {
  try { if (fs.existsSync(KEYPATH)) return new ethers.Wallet(JSON.parse(fs.readFileSync(KEYPATH, 'utf8')).privateKey) } catch (_) {}
  const w = ethers.Wallet.createRandom()
  try { fs.writeFileSync(KEYPATH, JSON.stringify({ privateKey: w.privateKey, address: w.address }), { mode: 0o600 }) } catch (_) {}
  return new ethers.Wallet(w.privateKey)
}
const baseWallet = loadWallet()
const _providers = {}
const _signers = {}

function provider(chain) {
  if (!_providers[chain]) _providers[chain] = new ethers.JsonRpcProvider(RPC[chain], undefined, { staticNetwork: true })
  return _providers[chain]
}
function signer(chain) {
  if (!_signers[chain]) _signers[chain] = new ethers.NonceManager(baseWallet.connect(provider(chain)))
  return _signers[chain]
}
// Emblem-managed EVM signer (the vault's EVM address, signed via Emblem — no raw key).
// Can sign contract CALLS (mint) but NOT deploys (Emblem ethers signer rejects null `to`).
const _emblem = {}
async function emblemSigner(chain) {
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

module.exports = { provider, signer, emblemSigner, emblemAddress, serialize, address: baseWallet.address, RPC }
