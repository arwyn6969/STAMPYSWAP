'use strict'
const { ethers } = require('ethers')

// Registry keys are persistent identities. Never repoint the Sepolia keys to mainnet.
const EVM_CHAINS = Object.freeze({
  base: Object.freeze({ name: 'Base Sepolia', chainId: 84532, mainnet: false, rpcEnv: 'BASE_SEPOLIA_RPC', defaultRpc: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org' }),
  ethereum: Object.freeze({ name: 'Ethereum Sepolia', chainId: 11155111, mainnet: false, rpcEnv: 'ETH_SEPOLIA_RPC', defaultRpc: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io' }),
  'base-mainnet': Object.freeze({ name: 'Base', chainId: 8453, mainnet: true, rpcEnv: 'BASE_MAINNET_RPC', explorer: 'https://basescan.org' }),
  'ethereum-mainnet': Object.freeze({ name: 'Ethereum', chainId: 1, mainnet: true, rpcEnv: 'ETH_MAINNET_RPC', explorer: 'https://etherscan.io' }),
})
function evmChain(chain, env = process.env) {
  if (!Object.hasOwn(EVM_CHAINS, chain)) throw new Error('unsupported EVM chain identity')
  const config = EVM_CHAINS[chain]
  const rpc = Object.hasOwn(env, config.rpcEnv) ? env[config.rpcEnv] : config.defaultRpc
  let endpoint
  try { endpoint = new URL(rpc) } catch (_) { throw new Error(`${config.rpcEnv} must configure an explicit HTTPS RPC endpoint`) }
  if (endpoint.protocol !== 'https:' || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.hash)
    throw new Error(`${config.rpcEnv} must be an HTTPS RPC endpoint without userinfo or fragment`)
  return { ...config, rpc: endpoint.href }
}
function assertChainId(actual, chain) {
  const config = EVM_CHAINS[chain]
  if (!config) throw new Error('unsupported EVM chain identity')
  if (typeof actual !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(actual)) throw new Error('RPC returned an invalid chain ID')
  let chainId
  try { chainId = BigInt(actual) } catch (_) { throw new Error('RPC returned an invalid chain ID') }
  if (chainId !== BigInt(config.chainId)) {
    const error = new Error(`RPC chain ID does not match ${chain} (${config.chainId})`)
    error.code = 'NETWORK_MISMATCH'
    throw error
  }
  return config
}
async function assertEvmNetwork(provider, chain) {
  // A fresh RPC response is required; getNetwork() or staticNetwork metadata may be cached.
  return assertChainId(await provider.send('eth_chainId', []), chain)
}
class CheckedEvmProvider extends ethers.JsonRpcProvider {
  constructor(chain, env = process.env) {
    const config = evmChain(chain, env)
    super(config.rpc, config.chainId, { staticNetwork: false, cacheTimeout: -1 })
    this.chainIdentity = chain
    this.chainProbeId = -1
  }
  async _send(payload) {
    // Gate every transport batch, including direct send() and signer broadcasts. Do not
    // assume that a URL still reaches the network observed when the process started.
    const id = this.chainProbeId--
    const result = await super._send({ jsonrpc: '2.0', id, method: 'eth_chainId', params: [] })
    const response = result.find(item => item.id === id)
    if (!response || response.error) throw new Error('RPC chain identity could not be verified')
    assertChainId(response.result, this.chainIdentity)
    return super._send(payload)
  }
}
function requireIndependentSigning(chain) {
  if (!Object.hasOwn(EVM_CHAINS, chain)) throw new Error('unsupported EVM chain identity')
  if (EVM_CHAINS[chain].mainnet) {
    const error = new Error('mainnet writes require an independently reviewed external signing workflow; local automatic signing is disabled')
    error.code = 'INDEPENDENT_SIGNING_REQUIRED'
    throw error
  }
}
module.exports = { EVM_CHAINS, evmChain, assertChainId, assertEvmNetwork, CheckedEvmProvider, requireIndependentSigning }
