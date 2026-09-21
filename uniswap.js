// Uniswap V2 integration for MAINNET liquidity (Base). On mainnet we do NOT run our own AMM —
// we mint the backed reps, then provide liquidity + swap on Uniswap's audited, battle-tested V2
// contracts. All value-moving actions are signed by the Emblem-managed vault (no raw keys); the
// deployer key only pays gas. Serialized per chain via evm-signer to keep nonces ordered.
const { ethers } = require('ethers')
const evmSigner = require('./evm-signer')

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
function cfg(chain) { const c = UNI[chain]; if (!c) throw new Error('uniswap V2 not configured for ' + chain); return c }
function isSupported(chain) { return chain in UNI }
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
async function addLiquidity(chain, tokenA, tokenB, amountAWhole, amountBWhole, { preflight = false } = {}) {
  return evmSigner.serialize(chain, async () => {
    const c = cfg(chain)
    const signer = await evmSigner.emblemSigner(chain)
    const lp = await signer.getAddress()
    const decA = await _dec(chain, tokenA), decB = await _dec(chain, tokenB)
    const amtA = ethers.parseUnits(String(amountAWhole), decA), amtB = ethers.parseUnits(String(amountBWhole), decB)
    const router = new ethers.Contract(c.router, ROUTER_ABI, signer)
    // approvals (skip in preflight — approve is itself a spend; we just validate liquidity math)
    if (!preflight) {
      for (const [t, amt] of [[tokenA, amtA], [tokenB, amtB]]) {
        const erc = new ethers.Contract(t, ERC20_ABI, signer)
        if ((await erc.allowance(lp, c.router)) < amt) await (await erc.approve(c.router, amt, { gasLimit: GAS.approve })).wait()
      }
    }
    if (preflight) {
      // static-simulate (no state change) to surface a revert before we ever spend
      await router.addLiquidity.staticCall(tokenA, tokenB, amtA, amtB, 0, 0, lp, deadline())
      return { preflight: true, ok: true, lp }
    }
    const tx = await router.addLiquidity(tokenA, tokenB, amtA, amtB, 0, 0, lp, deadline(), { gasLimit: GAS.addLiquidity })
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

async function swap(chain, amountInWhole, tokenIn, tokenOut, { preflight = false, slippageBps = 50 } = {}) {
  return evmSigner.serialize(chain, async () => {
    const c = cfg(chain)
    const signer = await evmSigner.emblemSigner(chain)
    const to = await signer.getAddress()
    const decIn = await _dec(chain, tokenIn)
    const amtIn = ethers.parseUnits(String(amountInWhole), decIn)
    const router = new ethers.Contract(c.router, ROUTER_ABI, signer)
    const quoted = await router.getAmountsOut(amtIn, [tokenIn, tokenOut])
    const minOut = quoted[1] * BigInt(10000 - slippageBps) / 10000n
    if (!preflight) {
      const erc = new ethers.Contract(tokenIn, ERC20_ABI, signer)
      if ((await erc.allowance(to, c.router)) < amtIn) await (await erc.approve(c.router, amtIn, { gasLimit: GAS.approve })).wait()
    }
    if (preflight) { await router.swapExactTokensForTokens.staticCall(amtIn, minOut, [tokenIn, tokenOut], to, deadline()); return { preflight: true, ok: true, minOut: minOut.toString() } }
    const tx = await router.swapExactTokensForTokens(amtIn, minOut, [tokenIn, tokenOut], to, deadline(), { gasLimit: GAS.swap })
    const r = await tx.wait()
    return { txHash: r.hash, explorer: `${c.explorer}/tx/${r.hash}` }
  })
}

module.exports = { isSupported, getPair, addLiquidity, getReserves, quoteOut, swap, UNI, lpAddress: (chain) => evmSigner.emblemAddress(chain) }
