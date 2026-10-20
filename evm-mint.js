// EVM identities are explicit: base/ethereum remain Sepolia. Mainnet reads use
// the reproducible OpenZeppelin artifact; writes await independent signing.
const { ethers } = require('ethers')
const evmSigner = require('./evm-signer')
const networks = require('./network-config')
const testArtifact = require('./erc20-artifact.json')
const mainnetArtifact = require('./erc20-mainnet-artifact.json')
const CHAINS = networks.EVM_CHAINS
function isSupported(chain) { return Object.hasOwn(CHAINS, chain) }
function artifactFor(chain) {
  if (!isSupported(chain)) throw new Error('unsupported EVM chain identity')
  return CHAINS[chain].mainnet ? mainnetArtifact : testArtifact
}
function expectedMainnetRuntime(artifact = mainnetArtifact) {
  // The generator checks the complete compiler AST for exactly one immutable:
  // StampyRep._decimals (uint8). Its fixed value is 18, never an arbitrary wildcard.
  const binding = artifact && artifact.immutableBinding
  if (!binding || Object.keys(binding).sort().join(',') !== 'astId,contract,name,type' || !Number.isSafeInteger(binding.astId) || binding.astId <= 0 ||
      binding.contract !== 'StampyRep' || binding.name !== '_decimals' || binding.type !== 'uint8') throw new Error('invalid mainnet immutable declaration binding')
  const bytecode = artifact.deployedBytecode
  if (typeof bytecode !== 'string' || !/^0x(?:[a-f0-9]{2})+$/i.test(bytecode)) throw new Error('missing or malformed mainnet runtime bytecode')
  const immutableReferences = artifact.immutableReferences
  if (!immutableReferences || typeof immutableReferences !== 'object' || Array.isArray(immutableReferences) ||
      Object.keys(immutableReferences).length !== 1 || Object.keys(immutableReferences)[0] !== String(binding.astId)) throw new Error('mainnet immutable references do not match the sole declaration')
  const refs = immutableReferences[String(binding.astId)]
  if (!Array.isArray(refs) || !refs.length) throw new Error('missing mainnet immutable locations')
  const runtime = Buffer.from(bytecode.slice(2), 'hex')
  const decimals = Buffer.from((18n).toString(16).padStart(64, '0'), 'hex')
  let end = 0
  for (const ref of refs) {
    if (!ref || Object.keys(ref).sort().join(',') !== 'length,start' || !Number.isSafeInteger(ref.start) || ref.start < Math.max(1, end) || ref.length !== 32 ||
        ref.start + ref.length > runtime.length || runtime[ref.start - 1] !== 0x7f || runtime.subarray(ref.start, ref.start + ref.length).some(byte => byte !== 0))
      throw new Error('invalid mainnet immutable location, width, order or placeholder')
    decimals.copy(runtime, ref.start)
    end = ref.start + ref.length
  }
  return '0x' + runtime.toString('hex')
}
async function checkedProvider(chain) {
  networks.evmChain(chain)
  const rpc = evmSigner.provider(chain)
  await networks.assertEvmNetwork(rpc, chain)
  return rpc
}
async function validateRepresentation({ chain, address, provider, expectedOwner, expectedOrigin }) {
  if (!ethers.isAddress(address) || address === ethers.ZeroAddress) throw new Error('invalid representation address')
  const code = await provider.getCode(address)
  if (typeof code !== 'string' || !/^0x[0-9a-f]+$/i.test(code) || code === '0x0') throw new Error('representation has no deployed code')
  if (CHAINS[chain].mainnet && code.toLowerCase() !== expectedMainnetRuntime().toLowerCase()) throw new Error('mainnet representation runtime bytecode differs from the reviewed artifact with 18 decimals')
  const token = new ethers.Contract(address, artifactFor(chain).abi, provider)
  const owner = await token.owner()
  if (!ethers.isAddress(owner) || owner === ethers.ZeroAddress || (expectedOwner && owner.toLowerCase() !== expectedOwner.toLowerCase()))
    throw new Error('representation owner does not match the configured authority')
  if (BigInt(await token.decimals()) !== 18n) throw new Error('representation decimals do not match the registered 18 decimals')
  // Both checked-in artifacts expose srcOrigin. Unknown interfaces fail closed.
  const origin = await token.srcOrigin()
  if (typeof origin !== 'string' || !origin || (expectedOrigin && origin !== expectedOrigin)) throw new Error('representation source origin mismatch')
  if (CHAINS[chain].mainnet && !expectedOrigin) throw new Error('mainnet representation requires an explicit source origin binding')
  return { owner, origin }
}
async function readAuthorityInfo(chain) {
  const c = CHAINS[chain]; if (!c) return null
  const provider = await checkedProvider(chain)
  if (c.mainnet) return { address: null, authority_model: 'independent-signing-required', gas_deployer: null, balance: null, network: c.name, chainId: c.chainId, explorer: c.explorer, writes_enabled: false }
  const vault = await evmSigner.emblemAddress(chain)
  const balance = vault ? ethers.formatEther(await provider.getBalance(vault)) : null
  return { address: vault, authority_model: vault ? 'emblem-managed (vault EVM)' : 'unavailable',
    gas_deployer: evmSigner.address, balance, network: c.name, chainId: c.chainId, explorer: c.explorer }
}
async function authorityInfo(chain) {
  try { return await readAuthorityInfo(chain) }
  catch (_) { const error = new Error('EVM authority status unavailable'); error.code = 'EVM_STATUS_UNAVAILABLE'; throw error }
}

async function deployAndMint({ chain, existingContract, name, symbol, srcOrigin, amountToken, recipient }) {
  const artifact = artifactFor(chain), c = CHAINS[chain]
  networks.requireIndependentSigning(chain)
  if (!ethers.isAddress(recipient) || recipient === ethers.ZeroAddress) { const e = new Error('recipient is not a valid nonzero EVM address'); e.code = 'BADADDR'; throw e }
  if (typeof srcOrigin !== 'string' || !srcOrigin) throw new Error('source origin is required')
  const amount = ethers.parseUnits(String(amountToken), 18)
  if (amount <= 0n || amount > ethers.MaxUint256) throw new Error('mint amount outside uint256 bounds')
  const provider = await checkedProvider(chain)
  const vaultAddr = await evmSigner.emblemAddress(chain)
  if (!vaultAddr || !ethers.isAddress(vaultAddr) || vaultAddr === ethers.ZeroAddress) throw new Error('Emblem EVM signer unavailable')
  return evmSigner.serialize(chain, async () => {
    await networks.assertEvmNetwork(provider, chain)
    let contractAddr = existingContract, deployed = false
    if (!contractAddr) {
      if ((await provider.getBalance(evmSigner.address)) === 0n) { const e = new Error(`deploy gas key unfunded on ${c.name}`); e.code = 'UNFUNDED'; e.authority = evmSigner.address; throw e }
      const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, evmSigner.signer(chain))
      // Both artifacts take (name, symbol, uint8 decimals, srcOrigin, owner).
      const inst = await factory.deploy(name, symbol, 18, srcOrigin, vaultAddr)
      await inst.waitForDeployment()
      contractAddr = await inst.getAddress(); deployed = true
    }
    const identity = await validateRepresentation({ chain, address: contractAddr, provider, expectedOwner: vaultAddr, expectedOrigin: srcOrigin })
    if ((await provider.getBalance(vaultAddr)) === 0n) { const e = new Error(`mint authority unfunded on ${c.name}`); e.code = 'UNFUNDED'; e.authority = vaultAddr; throw e }
    const token = new ethers.Contract(contractAddr, artifact.abi, await evmSigner.emblemSigner(chain))
    const receipt = await (await token.mint(recipient, amount)).wait()
    if (!receipt || receipt.status !== 1) throw new Error('mint transaction did not succeed')
    return { contract: contractAddr, deployed, owner: identity.owner, minted_via: 'emblem-managed',
      chainId: c.chainId, txHash: receipt.hash, explorer: `${c.explorer}/tx/${receipt.hash}`, contractExplorer: `${c.explorer}/token/${contractAddr}` }
  })
}

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')
const ZERO_TOPIC = '0x' + '0'.repeat(64)
async function verifyBurn(chain, txid, contractAddr, amountToken, expectedOrigin = null) {
  try {
    const provider = await checkedProvider(chain)
    if (CHAINS[chain].mainnet) await validateRepresentation({ chain, address: contractAddr, provider, expectedOrigin })
    const rcpt = await provider.getTransactionReceipt(txid)
    if (!rcpt) return { valid: false, reason: 'tx not found' }
    if (rcpt.status !== 1) return { valid: false, reason: 'tx failed' }
    let finalized = false
    if (CHAINS[chain].mainnet) {
      const [canonical, finalHead] = await Promise.all([provider.getBlock(rcpt.blockNumber), provider.getBlock('finalized')])
      if (!/^0x[0-9a-f]{64}$/i.test(rcpt.blockHash || '') || !canonical || canonical.hash !== rcpt.blockHash)
        return { valid: false, reason: 'burn receipt is not bound to its canonical block' }
      if (!finalHead || !Number.isSafeInteger(finalHead.number) || finalHead.number < rcpt.blockNumber)
        return { valid: false, reason: 'burn block is not finalized' }
      finalized = true
    }
    const head = await provider.getBlockNumber()
    const confirmations = Number.isSafeInteger(head) && Number.isSafeInteger(rcpt.blockNumber) ? Math.max(0, head - rcpt.blockNumber + 1) : 0
    const want = ethers.parseUnits(String(amountToken), 18)
    if (want <= 0n) return { valid: false, reason: 'burn amount must be positive' }
    for (const log of rcpt.logs) {
      if (log.address.toLowerCase() === contractAddr.toLowerCase() && log.topics[0] === TRANSFER_TOPIC && log.topics[2] === ZERO_TOPIC) {
        const value = BigInt(log.data)
        if (value === want) return { valid: true, burned: value.toString(), owner: ethers.getAddress('0x' + log.topics[1].slice(-40)), chain, chainId: CHAINS[chain].chainId, confirmations, finalized, blockNumber: rcpt.blockNumber, blockHash: rcpt.blockHash }
      }
    }
    return { valid: false, reason: 'no matching exact burn (Transfer→0x0) of that contract/amount' }
  } catch (_) { return { valid: false, reason: 'burn verification failed: RPC or representation evidence unavailable' } }
}

async function transferOwnershipTo(chain, contractAddr, newOwner, expectedOrigin = null) {
  networks.requireIndependentSigning(chain)
  if (!ethers.isAddress(newOwner) || newOwner === ethers.ZeroAddress) throw new Error('invalid new authority')
  const provider = await checkedProvider(chain)
  return evmSigner.serialize(chain, async () => {
    const vault = await evmSigner.emblemAddress(chain)
    if (!vault) throw new Error('Emblem EVM signer unavailable')
    const identity = await validateRepresentation({ chain, address: contractAddr, provider, expectedOrigin })
    if (identity.owner.toLowerCase() === newOwner.toLowerCase()) return { already: true, contract: contractAddr }
    if (identity.owner.toLowerCase() !== vault.toLowerCase()) throw new Error('current owner is not the Emblem vault')
    const c = new ethers.Contract(contractAddr, artifactFor(chain).abi, await evmSigner.emblemSigner(chain))
    const r = await (await c.transferOwnership(newOwner)).wait()
    if (!r || r.status !== 1) throw new Error('ownership transaction did not succeed')
    return { migrated: true, contract: contractAddr, newOwner, txHash: r.hash }
  })
}
module.exports = { authorityInfo, deployAndMint, isSupported, verifyBurn, transferOwnershipTo, validateRepresentation, artifactFor, expectedMainnetRuntime, get deployerAddress() { return evmSigner.address }, CHAINS }
