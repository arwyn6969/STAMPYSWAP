// StampySwap — native SRC-20/SRC-20 AMM (Phase 7) on Base/Ethereum testnet.
// Real on-chain constant-product pair between two canonical representations. Uses the
// shared nonce-managed EVM signer as protocol LP (interim). Testnet only.
const { ethers } = require('ethers')
const evmSigner = require('./evm-signer')

const ammArtifact = require('./amm-artifact.json')
const erc20Artifact = require('./erc20-artifact.json')
const EXPLORER = { base: 'https://sepolia.basescan.org', ethereum: 'https://sepolia.etherscan.io' }

async function deployPair(chain, token0, token1) {
  return evmSigner.serialize(chain, async () => {
    const f = new ethers.ContractFactory(ammArtifact.abi, ammArtifact.bytecode, evmSigner.signer(chain))
    const inst = await f.deploy(token0, token1)
    await inst.waitForDeployment()
    return await inst.getAddress()
  })
}

// LP is the Emblem-managed vault (holds the reps, signs approve + addLiquidity via Emblem).
async function addLiquidity(chain, pair, token0, token1, amt0, amt1) {
  return evmSigner.serialize(chain, async () => {
    const s = await evmSigner.emblemSigner(chain)
    const lp = await evmSigner.emblemAddress(chain)
    const a0 = ethers.parseUnits(String(amt0), 18), a1 = ethers.parseUnits(String(amt1), 18)
    const t0 = new ethers.Contract(token0, erc20Artifact.abi, s)
    const t1 = new ethers.Contract(token1, erc20Artifact.abi, s)
    await (await t0.approve(pair, a0)).wait()
    await (await t1.approve(pair, a1)).wait()
    const p = new ethers.Contract(pair, ammArtifact.abi, s)
    const r = await (await p.addLiquidity(a0, a1, lp)).wait()
    return { txHash: r.hash, explorer: `${EXPLORER[chain]}/tx/${r.hash}` }
  })
}
async function lpAddress(chain) { return evmSigner.emblemAddress(chain) }

// Deploy a mock EXTERNAL token (a stand-in "ETH memecoin" we do NOT mint as a rep) and
// seed the LP with it — so we can demo rep/external pools. In production the external token
// already exists on-chain and the LP brings its own liquidity; this is only for testnet demos.
async function deployExternalToken(chain, name, symbol, amountToLp) {
  return evmSigner.serialize(chain, async () => {
    const raw = evmSigner.signer(chain)
    const lp = await evmSigner.emblemAddress(chain)
    const factory = new ethers.ContractFactory(erc20Artifact.abi, erc20Artifact.bytecode, raw)
    const inst = await factory.deploy(name, symbol, 18, `external:${symbol}`, evmSigner.address)
    await inst.waitForDeployment()
    const addr = await inst.getAddress()
    const token = new ethers.Contract(addr, erc20Artifact.abi, raw)
    await (await token.mint(lp, ethers.parseUnits(String(amountToLp), 18))).wait()
    return addr
  })
}
async function tokenBalance(chain, token, owner) {
  const c = new ethers.Contract(token, erc20Artifact.abi, evmSigner.provider(chain))
  try { return ethers.formatUnits(await c.balanceOf(owner), 18) } catch (_) { return '0' }
}
async function getReserves(chain, pair) {
  const p = new ethers.Contract(pair, ammArtifact.abi, evmSigner.provider(chain))
  const [r0, r1] = await p.getReserves()
  return { r0: ethers.formatUnits(r0, 18), r1: ethers.formatUnits(r1, 18), r0raw: r0, r1raw: r1 }
}

// pure constant-product quote (0.30% fee)
function quoteOut(rInStr, rOutStr, amountInStr) {
  const rIn = ethers.parseUnits(String(rInStr), 18), rOut = ethers.parseUnits(String(rOutStr), 18)
  const amountIn = ethers.parseUnits(String(amountInStr), 18)
  if (rIn === 0n || rOut === 0n) return '0'
  const inWithFee = amountIn * 9970n / 10000n
  return ethers.formatUnits(rOut * inWithFee / (rIn + inWithFee), 18)
}

// Swapper is the Emblem-managed vault (holds tokenIn, signs approve + swap via Emblem).
async function swap(chain, pair, tokenIn, amountIn, to) {
  return evmSigner.serialize(chain, async () => {
    const s = await evmSigner.emblemSigner(chain)
    const amt = ethers.parseUnits(String(amountIn), 18)
    const tin = new ethers.Contract(tokenIn, erc20Artifact.abi, s)
    await (await tin.approve(pair, amt)).wait()
    const p = new ethers.Contract(pair, ammArtifact.abi, s)
    const r = await (await p.swap(tokenIn, amt, 0, to)).wait()
    return { txHash: r.hash, explorer: `${EXPLORER[chain]}/tx/${r.hash}` }
  })
}

module.exports = { deployPair, addLiquidity, getReserves, quoteOut, swap, lpAddress, deployExternalToken, tokenBalance, deployerAddress: evmSigner.address, EXPLORER }
