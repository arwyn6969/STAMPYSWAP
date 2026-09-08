// StampySwap — EVM mint authority as a SAFE (Gnosis Safe) M-of-N multisig, the production upgrade
// from the single Emblem-managed EVM signer. Built ALONGSIDE Emblem (non-destructive): the Safe
// owns the ERC-20 rep contracts; a mint is a Safe transaction that M-of-N owners sign (off-chain,
// EIP-712) and anyone executes. Owners need NO gas (only the executor pays). Base/Eth Sepolia.
const { ethers } = require('ethers')
const Safe = require('@safe-global/protocol-kit').default || require('@safe-global/protocol-kit')
const fs = require('fs')
const path = require('path')
const erc20Artifact = require('./erc20-artifact.json')

const RPCS = { base: process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org', ethereum: process.env.ETH_SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com' }
const OWNERS_PATH = path.join(__dirname, '.safe-owners.json')  // N owner keys (server-side, 600)
const STATE_PATH = path.join(__dirname, '.safe-state.json')    // { base: <safeAddr>, ethereum: <safeAddr> }
const DEPLOYER_PATH = path.join(__dirname, '.evm-deployer.json')
const THRESHOLD = parseInt(process.env.SAFE_THRESHOLD || '2', 10)
const N_OWNERS = parseInt(process.env.SAFE_OWNERS || '3', 10)

function deployerKey() { const k = JSON.parse(fs.readFileSync(DEPLOYER_PATH, 'utf8')); return k.privateKey || k }
function loadOwners() {
  if (fs.existsSync(OWNERS_PATH)) return JSON.parse(fs.readFileSync(OWNERS_PATH, 'utf8'))
  const owners = Array.from({ length: N_OWNERS }, () => ethers.Wallet.createRandom().privateKey)
  fs.writeFileSync(OWNERS_PATH, JSON.stringify(owners), { mode: 0o600 })
  return owners
}
function ownerAddrs() { return loadOwners().map(pk => new ethers.Wallet(pk).address) }
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) } catch (_) { return {} } }
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s), { mode: 0o600 }) }
function provider(chain) { return new ethers.JsonRpcProvider(RPCS[chain]) }

// Deploy a Safe on `chain` with the owners + threshold (idempotent — reuses the stored address).
async function ensureSafe(chain = 'base') {
  const st = loadState()
  if (st[chain]) return st[chain]
  const owners = ownerAddrs()
  const deployer = deployerKey()
  const salt = '0x' + Buffer.from(`stampyswap:${chain}`).toString('hex').padEnd(64, '0').slice(0, 64)
  const kit = await Safe.init({ provider: RPCS[chain], signer: deployer, predictedSafe: {
    safeAccountConfig: { owners, threshold: THRESHOLD }, safeDeploymentConfig: { saltNonce: BigInt(salt).toString() },
  } })
  const safeAddress = await kit.getAddress()
  const deployTx = await kit.createSafeDeploymentTransaction()
  const wallet = new ethers.Wallet(deployer, provider(chain))
  const resp = await wallet.sendTransaction({ to: deployTx.to, value: deployTx.value || '0', data: deployTx.data })
  await resp.wait()
  st[chain] = safeAddress; saveState(st)
  return safeAddress
}
function safeAddress(chain = 'base') { return loadState()[chain] || null }

async function info(chain = 'base') {
  const addr = safeAddress(chain)
  let deployerBal = '0'
  try { deployerBal = ethers.formatEther(await provider(chain).getBalance(new ethers.Wallet(deployerKey()).address)) } catch (_) {}
  return {
    chain, configured: !!addr, safe: addr, threshold: THRESHOLD, owners: ownerAddrs(),
    executor_deployer: new ethers.Wallet(deployerKey()).address, deployer_eth: deployerBal,
    model: addr ? `safe ${THRESHOLD}-of-${N_OWNERS} multisig` : 'not deployed', network: chain === 'base' ? 'base-sepolia' : 'eth-sepolia',
  }
}

// Mint `amountToken` (whole units, 18dp) of a rep ERC-20 (owned by the Safe) to `recipient`, via a
// Safe transaction: build mint() call → each owner signs (off-chain) → executor submits.
async function mintViaSafe({ chain = 'base', rep, amountToken, recipient }) {
  const safeAddr = await ensureSafe(chain)
  const owners = loadOwners()
  const deployer = deployerKey()
  const iface = new ethers.Interface(erc20Artifact.abi)
  const data = iface.encodeFunctionData('mint', [recipient, ethers.parseUnits(String(amountToken), 18)])

  // executor-connected kit builds + executes; owner-connected kits sign
  const execKit = await Safe.init({ provider: RPCS[chain], signer: deployer, safeAddress: safeAddr })
  let safeTx = await execKit.createTransaction({ transactions: [{ to: rep, value: '0', data }] })
  for (let i = 0; i < THRESHOLD; i++) {
    const ownerKit = await Safe.init({ provider: RPCS[chain], signer: owners[i], safeAddress: safeAddr })
    safeTx = await ownerKit.signTransaction(safeTx) // accumulate owner signatures (off-chain)
  }
  const exec = await execKit.executeTransaction(safeTx)
  const receipt = await (exec.transactionResponse && exec.transactionResponse.wait ? exec.transactionResponse.wait() : Promise.resolve(exec))
  const txHash = (receipt && (receipt.hash || receipt.transactionHash)) || exec.hash
  return { safe: safeAddr, txHash, authority_model: `safe ${THRESHOLD}-of-${N_OWNERS}`, explorer: `https://sepolia.basescan.org/tx/${txHash}` }
}

// Deploy a rep ERC-20 whose OWNER is the Safe (so only the Safe can mint it). Deployer pays gas.
async function deployRep({ chain = 'base', name, symbol, srcOrigin }) {
  const safeAddr = await ensureSafe(chain)
  const wallet = new ethers.Wallet(deployerKey(), provider(chain))
  const f = new ethers.ContractFactory(erc20Artifact.abi, erc20Artifact.bytecode, wallet)
  const c = await f.deploy(name, String(symbol).slice(0, 11), 18, srcOrigin || `stampy:${symbol}`, safeAddr)
  await c.waitForDeployment()
  return c.getAddress()
}

module.exports = { ensureSafe, safeAddress, info, mintViaSafe, deployRep, ownerAddrs }
