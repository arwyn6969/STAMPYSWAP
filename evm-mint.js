// StampySwap — EVM testnet representations (Base + Ethereum Sepolia) with EMBLEM-MANAGED
// mint authority. Contracts are owned by the Emblem vault's EVM address; mint() is signed
// via Emblem (no raw key). Deploys are done by a local key (the Emblem ethers signer can't
// deploy — no `to`), which hands ownership straight to the vault at construction.
const { ethers } = require('ethers')
const evmSigner = require('./evm-signer')

const artifact = require('./erc20-artifact.json')
const CHAINS = {
  base: { name: 'Base Sepolia', chainId: 84532, explorer: 'https://sepolia.basescan.org' },
  ethereum: { name: 'Ethereum Sepolia', chainId: 11155111, explorer: 'https://sepolia.etherscan.io' },
}
function isSupported(chain) { return chain in CHAINS }

async function authorityInfo(chain) {
  const c = CHAINS[chain]; if (!c) return null
  const vault = await evmSigner.emblemAddress(chain)
  let balance = '0'
  try { if (vault) balance = ethers.formatEther(await evmSigner.provider(chain).getBalance(vault)) } catch (_) {}
  return { address: vault, authority_model: vault ? 'emblem-managed (vault EVM)' : 'unavailable',
    gas_deployer: evmSigner.address, balance, network: c.name, chainId: c.chainId, explorer: c.explorer }
}

// Deploy (first time, via local key, owner = vault) + mint (via Emblem for vault-owned,
// or the local key for legacy raw-owned contracts). Serialized per chain.
async function deployAndMint({ chain, existingContract, name, symbol, srcOrigin, amountToken, recipient }) {
  const c = CHAINS[chain]; if (!c) throw new Error('unsupported chain')
  if (!ethers.isAddress(recipient)) { const e = new Error('recipient is not a valid EVM address'); e.code = 'BADADDR'; throw e }
  const provider = evmSigner.provider(chain)
  const vaultAddr = await evmSigner.emblemAddress(chain)
  if (!vaultAddr) throw new Error('Emblem EVM signer unavailable')

  return evmSigner.serialize(chain, async () => {
    let contractAddr = existingContract, deployed = false, owner = vaultAddr
    if (!contractAddr) {
      // deploy with the LOCAL key (pays deploy gas), owner set to the vault
      if ((await provider.getBalance(evmSigner.address)) === 0n) { const e = new Error(`deploy gas key unfunded on ${c.name}. Send testnet ETH to ${evmSigner.address}.`); e.code = 'UNFUNDED'; e.authority = evmSigner.address; throw e }
      const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, evmSigner.signer(chain))
      const inst = await factory.deploy(name, symbol, 18, srcOrigin, vaultAddr)
      await inst.waitForDeployment()
      contractAddr = await inst.getAddress(); deployed = true
    } else {
      try { owner = await new ethers.Contract(contractAddr, artifact.abi, provider).owner() } catch (_) { owner = null }
    }

    // pick the mint signer by who owns the contract
    const useEmblem = owner && owner.toLowerCase() === vaultAddr.toLowerCase()
    const minter = useEmblem ? vaultAddr : evmSigner.address
    if ((await provider.getBalance(minter)) === 0n) { const e = new Error(`mint authority (${useEmblem ? 'Emblem vault' : 'legacy key'}) unfunded on ${c.name}. Send testnet ETH to ${minter}.`); e.code = 'UNFUNDED'; e.authority = minter; throw e }
    const signer = useEmblem ? await evmSigner.emblemSigner(chain) : evmSigner.signer(chain)
    const token = new ethers.Contract(contractAddr, artifact.abi, signer)
    const receipt = await (await token.mint(recipient, ethers.parseUnits(String(amountToken), 18))).wait()
    return { contract: contractAddr, deployed, owner, minted_via: useEmblem ? 'emblem-managed' : 'legacy-key',
      txHash: receipt.hash, explorer: `${c.explorer}/tx/${receipt.hash}`, contractExplorer: `${c.explorer}/token/${contractAddr}` }
  })
}

// Verify a real ERC-20 BURN (Transfer to 0x0) of `contractAddr` for ≥ amountToken (18dp),
// for a cross-chain move. Read-only.
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')
const ZERO_TOPIC = '0x' + '0'.repeat(64)
async function verifyBurn(chain, txid, contractAddr, amountToken) {
  try {
    const rcpt = await evmSigner.provider(chain).getTransactionReceipt(txid)
    if (!rcpt) return { valid: false, reason: 'tx not found' }
    if (rcpt.status !== 1) return { valid: false, reason: 'tx failed' }
    const want = ethers.parseUnits(String(amountToken), 18)
    for (const log of rcpt.logs) {
      if (log.address.toLowerCase() === contractAddr.toLowerCase() && log.topics[0] === TRANSFER_TOPIC && log.topics[2] === ZERO_TOPIC) {
        const value = BigInt(log.data)
        if (value >= want) return { valid: true, burned: value.toString() }
      }
    }
    return { valid: false, reason: 'no matching burn (Transfer→0x0) of that contract/amount' }
  } catch (e) { return { valid: false, reason: String(e.message || e) } }
}

// One-time migration: hand a rep contract owned by the EMBLEM vault over to a new owner (the Safe
// multisig). The current owner (Emblem vault) signs transferOwnership via the Emblem ethers signer.
// Serialized per chain. Legacy contracts without transferOwnership/owner are reported skipped.
async function transferOwnershipTo(chain, contractAddr, newOwner) {
  return evmSigner.serialize(chain, async () => {
    const vault = (await evmSigner.emblemAddress(chain)).toLowerCase()
    const ro = new ethers.Contract(contractAddr, artifact.abi, evmSigner.provider(chain))
    let current; try { current = await ro.owner() } catch (_) { return { skipped: 'no owner() — legacy contract', contract: contractAddr } }
    if (current.toLowerCase() === String(newOwner).toLowerCase()) return { already: true, contract: contractAddr }
    if (current.toLowerCase() !== vault) return { skipped: 'current owner is not the Emblem vault', current, contract: contractAddr }
    const signer = await evmSigner.emblemSigner(chain) // Emblem vault signs (it's the current owner)
    const c = new ethers.Contract(contractAddr, artifact.abi, signer)
    const tx = await c.transferOwnership(newOwner)
    const r = await tx.wait()
    return { migrated: true, contract: contractAddr, newOwner, txHash: r.hash }
  })
}

module.exports = { authorityInfo, deployAndMint, isSupported, verifyBurn, transferOwnershipTo, deployerAddress: evmSigner.address, CHAINS }
