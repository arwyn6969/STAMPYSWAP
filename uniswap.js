// Uniswap V2 reads and public-owner static preflights on Base mainnet. Automatic
// protocol-funded writes remain closed pending an independent signing workflow.
const { ethers } = require('ethers')
const evmSigner = require('./evm-signer')
const networks = require('./network-config')

// Verified live on-chain 2026-09-14 (Factory.allPairsLength ~3.05M). Base MAINNET canonical V2.
const UNI = {
  'base-mainnet': {
    factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
    router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
    weth: '0x4200000000000000000000000000000000000006',
    explorer: 'https://basescan.org',
  },
}
const FACTORY_ABI = ['function getPair(address,address) view returns (address)', 'function createPair(address,address) returns (address)', 'function allPairsLength() view returns (uint256)']
const ROUTER_ABI = ['function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)', 'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])', 'function getAmountsOut(uint256,address[]) view returns (uint256[])']
const PAIR_ABI = ['function getReserves() view returns (uint112,uint112,uint32)', 'function token0() view returns (address)', 'function token1() view returns (address)', 'function totalSupply() view returns (uint256)']
const ERC20_ABI = ['function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)']

// The Emblem-managed signer does NOT auto-estimate gas — it defaults to 21000 (plain-transfer
// gas), which reverts contract calls as "intrinsic gas too low". So we set explicit generous
// limits on every contract call. Base gas is pennies, so headroom is free.
const GAS = { approve: 80000n, addLiquidity: 600000n, swap: 400000n }
function cfg(chain) { if (!Object.hasOwn(UNI, chain)) throw new Error('uniswap V2 not configured for ' + chain); return UNI[chain] }
function isSupported(chain) { return Object.hasOwn(UNI, chain) }
function deadline() { return Math.floor(Date.now() / 1000) + 1200 } // 20 min

async function getPair(chain, tokenA, tokenB) {
  const c = cfg(chain)
  const f = new ethers.Contract(c.factory, FACTORY_ABI, evmSigner.provider(chain))
  const pair = await f.getPair(tokenA, tokenB)
  return pair === ethers.ZeroAddress ? null : pair
}

async function _dec(chain, token) { return new ethers.Contract(token, ERC20_ABI, evmSigner.provider(chain)).decimals() }

// Mint-to-vault → vault approves router → addLiquidity (auto-creates the pair if new). Vault signs
// (Emblem, no raw key) and pays gas. `preflight` runs the calls with callStatic first (no spend).
async function addLiquidity(chain, tokenA, tokenB, amountAWhole, amountBWhole, { preflight = false, from = null } = {}) {
  if (preflight) {
    if (!ethers.isAddress(from) || from === ethers.ZeroAddress) throw new Error('read-only liquidity preflight requires an explicit public from address')
    const c = cfg(chain), rpc = evmSigner.provider(chain)
    await networks.assertEvmNetwork(rpc, chain)
    const decA = await _dec(chain, tokenA), decB = await _dec(chain, tokenB)
    const amtA = ethers.parseUnits(String(amountAWhole), decA), amtB = ethers.parseUnits(String(amountBWhole), decB)
    const router = new ethers.Contract(c.router, ROUTER_ABI, rpc)
    await router.addLiquidity.staticCall(tokenA, tokenB, amtA, amtB, 0, 0, from, deadline(), { from })
    return { preflight: true, ok: true, lp: from }
  }
  networks.requireIndependentSigning(chain)
  return evmSigner.serialize(chain, async () => {
    const c = cfg(chain)
    const signer = await evmSigner.emblemSigner(chain)
    const lp = await signer.getAddress()
    const decA = await _dec(chain, tokenA), decB = await _dec(chain, tokenB)
    const amtA = ethers.parseUnits(String(amountAWhole), decA), amtB = ethers.parseUnits(String(amountBWhole), decB)
    const router = new ethers.Contract(c.router, ROUTER_ABI, signer)
    for (const [t, amt] of [[tokenA, amtA], [tokenB, amtB]]) {
      const erc = new ethers.Contract(t, ERC20_ABI, signer)
      if ((await erc.allowance(lp, c.router)) < amt) await (await erc.approve(c.router, amt, { gasLimit: GAS.approve })).wait()
    }
    // slippage floor (P1 audit): min amounts = 99% of desired (protects when adding to an existing
    // pool; harmless for the first add to a fresh pair, where the router uses the exact amounts).
    const minA = amtA - amtA / 100n, minB = amtB - amtB / 100n
    const tx = await router.addLiquidity(tokenA, tokenB, amtA, amtB, minA, minB, lp, deadline(), { gasLimit: GAS.addLiquidity })
    const r = await tx.wait()
    const pair = await getPair(chain, tokenA, tokenB)
    return { txHash: r.hash, pair, lp, explorer: `${c.explorer}/tx/${r.hash}` }
  })
}

async function getReserves(chain, pair) {
  const p = new ethers.Contract(pair, PAIR_ABI, evmSigner.provider(chain))
  const [r0, r1] = await p.getReserves()
  const [t0, t1] = [await p.token0(), await p.token1()]
  const d0 = await _dec(chain, t0), d1 = await _dec(chain, t1)
  return { token0: t0, token1: t1, r0: ethers.formatUnits(r0, d0), r1: ethers.formatUnits(r1, d1) }
}

// Quote (view). path = [tokenIn, tokenOut].
async function quoteOut(chain, amountInWhole, tokenIn, tokenOut) {
  const c = cfg(chain)
  const router = new ethers.Contract(c.router, ROUTER_ABI, evmSigner.provider(chain))
  const decIn = await _dec(chain, tokenIn), decOut = await _dec(chain, tokenOut)
  const outs = await router.getAmountsOut(ethers.parseUnits(String(amountInWhole), decIn), [tokenIn, tokenOut])
  return ethers.formatUnits(outs[1], decOut)
}

async function swap(chain, amountInWhole, tokenIn, tokenOut, { preflight = false, from = null } = {}) {
  if (preflight) {
    if (!ethers.isAddress(from) || from === ethers.ZeroAddress) throw new Error('read-only swap preflight requires an explicit public from address')
    const c = cfg(chain), rpc = evmSigner.provider(chain)
    await networks.assertEvmNetwork(rpc, chain)
    const amtIn = ethers.parseUnits(String(amountInWhole), await _dec(chain, tokenIn))
    const router = new ethers.Contract(c.router, ROUTER_ABI, rpc)
    const outs = await router.getAmountsOut(amtIn, [tokenIn, tokenOut])
    const minOut = outs[1] - outs[1] * 50n / 10000n
    await router.swapExactTokensForTokens.staticCall(amtIn, minOut, [tokenIn, tokenOut], from, deadline(), { from })
    return { preflight: true, ok: true }
  }
  networks.requireIndependentSigning(chain)
  return evmSigner.serialize(chain, async () => {
    const c = cfg(chain)
    const signer = await evmSigner.emblemSigner(chain)
    const to = await signer.getAddress()
    const decIn = await _dec(chain, tokenIn)
    const amtIn = ethers.parseUnits(String(amountInWhole), decIn)
    const router = new ethers.Contract(c.router, ROUTER_ABI, signer)
    const erc = new ethers.Contract(tokenIn, ERC20_ABI, signer)
    if ((await erc.allowance(to, c.router)) < amtIn) await (await erc.approve(c.router, amtIn, { gasLimit: GAS.approve })).wait()
    // slippage floor (P1 audit): minOut = quote − 50 bps, instead of 0 (which would accept any output)
    const outs = await router.getAmountsOut(amtIn, [tokenIn, tokenOut])
    const minOut = outs[1] - outs[1] * 50n / 10000n
    const tx = await router.swapExactTokensForTokens(amtIn, minOut, [tokenIn, tokenOut], to, deadline(), { gasLimit: GAS.swap })
    const r = await tx.wait()
    return { txHash: r.hash, explorer: `${c.explorer}/tx/${r.hash}` }
  })
}

async function lpAddress(chain) {
  if (!Object.hasOwn(networks.EVM_CHAINS, chain)) throw new Error('unsupported EVM chain identity')
  return networks.EVM_CHAINS[chain].mainnet ? null : evmSigner.emblemAddress(chain)
}
module.exports = { isSupported, getPair, addLiquidity, getReserves, quoteOut, swap, UNI, lpAddress }
