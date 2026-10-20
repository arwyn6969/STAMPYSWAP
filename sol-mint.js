// StampySwap — Solana devnet mint with EMBLEM-MANAGED mint authority.
// The mint authority (who controls minting — the security-critical role) is the Emblem
// vault, signed via Emblem's API using EMBLEM_API_KEY. NO raw private key holds the
// authority. A local keypair is kept ONLY to pay gas (fee payer). Devnet.
// Explicit mainnet reads are supported; every mainnet signing/migration entry point
// remains closed until an independent approval/signing architecture is implemented.
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, TransactionMessage, VersionedTransaction } = require('@solana/web3.js')
const { createMint, getOrCreateAssociatedTokenAccount, createMintToInstruction, getMint, setAuthority, AuthorityType, createSetAuthorityInstruction, TOKEN_PROGRAM_ID } = require('@solana/spl-token')
const { toSolanaWeb3Signer } = require('@emblemvault/auth-sdk/signers/solana')
const fs = require('fs')
const path = require('path')

const RPC = process.env.SOLANA_DEVNET_RPC || 'https://api.devnet.solana.com'
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const KEYPATH = path.join(__dirname, '.protocol-keypair.json') // fee payer (gas only); server-side, not web-served
const DECIMALS = 9
const U64_MAX = (1n << 64n) - 1n

// getMint's explicit program ID checks the account owner before decoding it. Metadata
// checks run outside the RPC retry loop: a wrong identity is never a transient error.
async function verifiedExistingMint(address, decimals, authority, amount) {
  let mint
  try { mint = new PublicKey(address) } catch (_) { throw new Error('stored Solana mint address is invalid: ' + address) }
  let info
  for (let i = 0; i < 4; i++) {
    try { info = await getMint(connection, mint, 'confirmed', TOKEN_PROGRAM_ID); break }
    catch (e) {
      const detail = String(e && (e.name + ': ' + e.message))
      if (/TokenAccountNotFound|could not find|not found|account does not exist/i.test(detail)) {
        const er = new Error('stored Solana mint is missing — refusing to create a replacement identity'); er.code = 'MINT_MISSING'; throw er
      }
      if (/TokenInvalid|Invalid account owner/i.test(detail)) {
        const er = new Error('stored Solana mint is not a valid SPL Token mint'); er.code = 'MINT_IDENTITY_MISMATCH'; throw er
      }
      if (i < 3) await new Promise(r => setTimeout(r, 200 * (i + 1)))
    }
  }
  if (!info) { const er = new Error('could not verify existing Solana mint — no replacement will be created'); er.code = 'RPC_UNCERTAIN'; throw er }
  // Interim freeze policy: revoked (null) or the same expected vault authority only.
  // Migration to another freeze controller requires a separately reviewed policy.
  if (!info.isInitialized || info.decimals !== decimals || !info.mintAuthority || !info.mintAuthority.equals(authority) ||
      (info.freezeAuthority && !info.freezeAuthority.equals(authority)) || typeof info.supply !== 'bigint' || info.supply < 0n) {
    const er = new Error('stored Solana mint decimals or mint/freeze authority differs from policy'); er.code = 'MINT_IDENTITY_MISMATCH'; throw er
  }
  if (info.supply + amount > U64_MAX) { const er = new Error('existing Solana mint supply plus requested amount exceeds SPL u64 capacity'); er.code = 'MINT_SUPPLY_OVERFLOW'; throw er }
  return mint
}

function loadFeePayer() {
  try { if (fs.existsSync(KEYPATH)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPATH, 'utf8')))) } catch (_) {}
  // FAIL LOUD (audit): never silently generate a new fee-payer key. Restore the file, or opt in.
  if (process.env.STAMPY_ALLOW_KEYGEN !== '1') throw new Error(`FATAL: Solana fee-payer key ${KEYPATH} missing/unreadable — refusing to auto-generate. Restore it, or set STAMPY_ALLOW_KEYGEN=1.`)
  const kp = Keypair.generate()
  try { fs.writeFileSync(KEYPATH, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 }) } catch (_) {}
  return kp
}
const connection = new Connection(RPC, 'confirmed')
let _feePayer = null, _mainnetConnection = null
function feePayerForSigning() { if (!_feePayer) _feePayer = loadFeePayer(); return _feePayer }
function requireSupportedChain(chain) {
  if (chain !== 'solana' && chain !== 'solana-mainnet') throw new Error('unsupported Solana chain')
}
function requireDevnetSigning(chain) {
  requireSupportedChain(chain)
  if (chain === 'solana-mainnet') {
    const e = new Error('mainnet signing requires an independently approved signer flow; the local/Emblem demo signer cannot be activated on mainnet')
    e.code = 'INDEPENDENT_SIGNING_REQUIRED'; throw e
  }
}
async function connectionForRead(chain) {
  requireSupportedChain(chain)
  if (chain === 'solana') {
    let genesis
    try { genesis = await connection.getGenesisHash() } catch (_) { const e = new Error('could not verify Solana devnet genesis'); e.code = 'RPC_UNCERTAIN'; throw e }
    if (genesis !== DEVNET_GENESIS) { const e = new Error('Solana devnet RPC genesis mismatch — refusing network substitution'); e.code = 'CHAIN_IDENTITY_MISMATCH'; throw e }
    return connection
  }
  const configured = String(process.env.SOLANA_MAINNET_RPC || '').trim()
  let url
  try { url = new URL(configured) } catch (_) { throw new Error('SOLANA_MAINNET_RPC must be an explicit HTTPS endpoint without userinfo or fragment') }
  const authority = configured.match(/^https:\/\/([^/?#]*)/i)
  if (url.protocol !== 'https:' || url.username || url.password || configured.includes('#') || (authority && authority[1].includes('@')))
    throw new Error('SOLANA_MAINNET_RPC must be an explicit HTTPS endpoint without userinfo or fragment')
  if (!_mainnetConnection) _mainnetConnection = new Connection(url.toString(), 'finalized')
  let genesis
  try { genesis = await _mainnetConnection.getGenesisHash() } catch (_) { const e = new Error('could not verify Solana mainnet genesis'); e.code = 'RPC_UNCERTAIN'; throw e }
  if (genesis !== MAINNET_GENESIS) { const e = new Error('Solana mainnet RPC genesis mismatch'); e.code = 'CHAIN_IDENTITY_MISMATCH'; throw e }
  return _mainnetConnection
}

let _emblem = null
async function emblem() { if (!_emblem) _emblem = await toSolanaWeb3Signer({ apiKey: process.env.EMBLEM_API_KEY }); return _emblem }
async function authorityPubkey() { return new PublicKey((await emblem()).publicKey) }

async function balanceSol() { try { return (await connection.getBalance(feePayerForSigning().publicKey)) / LAMPORTS_PER_SOL } catch (_) { return 0 } }
async function ensureFunded(minSol = 0.02) {
  const feePayer = feePayerForSigning()
  let bal = await balanceSol()
  if (bal >= minSol) return { funded: true, balance: bal }
  try { const s = await connection.requestAirdrop(feePayer.publicKey, LAMPORTS_PER_SOL); await connection.confirmTransaction(s, 'confirmed') } catch (_) {}
  bal = await balanceSol()
  return { funded: bal >= minSol, balance: bal }
}

async function authorityInfo(chain = 'solana') {
  await connectionForRead(chain)
  if (chain === 'solana-mainnet') return {
    address: null, authority_model: 'independent-signing-required', fee_payer: null, balance: null,
    network: 'mainnet-beta', chain, genesis: MAINNET_GENESIS, rpc_configured: true, decimals: DECIMALS,
    signing_available: false, code: 'INDEPENDENT_SIGNING_REQUIRED',
  }
  const feePayer = feePayerForSigning()
  let vault = null, vaultId = null
  try { const e = await emblem(); vault = e.publicKey; vaultId = e.getVaultId() } catch (_) {}
  return {
    address: vault,                                  // mint authority = Emblem vault (managed)
    authority_model: vault ? `emblem-managed (vault ${vaultId})` : 'unavailable',
    fee_payer: feePayer.publicKey.toBase58(),         // gas only — holds no mint authority
    balance: await balanceSol(),                      // fee-payer gas balance
    network: 'devnet', genesis: DEVNET_GENESIS, rpc_configured: true, decimals: DECIMALS,
  }
}

// Mint `amountBase9` (BigInt base units, 9 dp) of the asset's SPL token to `recipient`.
// Mint authority = Emblem vault (signed via Emblem); fee payer = local key (gas only).
async function mintTokens({ existingMint, amountBase, amountBase9, decimals = DECIMALS, recipient, chain = 'solana' }) {
  requireDevnetSigning(chain) // before key reads, funding, signer access or chain effects
  const rawAmount = amountBase != null ? amountBase : amountBase9 // amountBase9 kept for back-compat
  if (typeof rawAmount === 'number' && !Number.isSafeInteger(rawAmount)) throw new Error('amount must be an exact integer')
  const amt = BigInt(rawAmount)
  let owner
  try { owner = new PublicKey(recipient) } catch (_) { throw new Error('recipient is not a valid Solana address') }
  if (amt <= 0n) throw new Error('amount below mint precision')
  if (amt > U64_MAX) throw new Error('amount exceeds SPL u64 capacity')
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > DECIMALS) throw new Error('Solana decimals must be an integer from 0 to 9')
  await connectionForRead(chain)
  const feePayer = feePayerForSigning()

  const em = await emblem()
  const authority = new PublicKey(em.publicKey)
  const hasExistingMint = existingMint !== undefined && existingMint !== null
  let mint = hasExistingMint ? await verifiedExistingMint(existingMint, decimals, authority, amt) : null
  const fund = await ensureFunded()
  if (!fund.funded) { const e = new Error(`gas fee-payer unfunded on devnet (${fund.balance} SOL). Send devnet SOL to ${feePayer.publicKey.toBase58()}.`); e.code = 'UNFUNDED'; e.authority = feePayer.publicKey.toBase58(); throw e }
  if (!mint) mint = await createMint(connection, feePayer, authority, authority, decimals) // new rep only; decimals sized per asset (u64-safe)

  const ata = await getOrCreateAssociatedTokenAccount(connection, feePayer, mint, owner)

  // mintTo requires the AUTHORITY signature (the vault) → dual-sign: fee payer local, vault via Emblem
  const ix = createMintToInstruction(mint, ata.address, authority, amt)
  const bh = (await connection.getLatestBlockhash()).blockhash
  const msg = new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: bh, instructions: [ix] }).compileToV0Message()
  const tx = new VersionedTransaction(msg)
  tx.sign([feePayer])
  const signedBytes = await em.signTransaction(tx)
  const signed = VersionedTransaction.deserialize(signedBytes instanceof Uint8Array ? signedBytes : Uint8Array.from(signedBytes))
  const signature = await connection.sendRawTransaction(signed.serialize())
  await connection.confirmTransaction(signature, 'confirmed')
  return {
    mint: mint.toBase58(), signature, ata: ata.address.toBase58(),
    explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    mintExplorer: `https://explorer.solana.com/address/${mint.toBase58()}?cluster=devnet`,
  }
}

// Verify a real on-chain BURN of `mintAddr` for a cross-chain move: the tx must contain a
// burn/burnChecked of the canonical token program for EXACTLY the requested base
// units. Read the mint's immutable decimals rather than trusting registry metadata.
async function verifyBurn(txid, mintAddr, amountBase9, chain = 'solana', expectedDecimals = null) {
  try {
    const connection = await connectionForRead(chain)
    if (typeof amountBase9 === 'number' && !Number.isSafeInteger(amountBase9)) return { valid: false, reason: 'burn amount must be an exact integer' }
    const want = BigInt(amountBase9)
    if (want <= 0n || want > U64_MAX) return { valid: false, reason: 'burn amount outside SPL u64 capacity' }
    const mint = new PublicKey(mintAddr)
    const mintInfo = await getMint(connection, mint, 'finalized', TOKEN_PROGRAM_ID)
    if (!mintInfo.isInitialized || !Number.isInteger(mintInfo.decimals) || mintInfo.decimals < 0 || mintInfo.decimals > DECIMALS)
      return { valid: false, reason: 'mint metadata is not supported' }
    if (expectedDecimals !== null && mintInfo.decimals !== expectedDecimals)
      return { valid: false, reason: 'on-chain mint decimals differ from the requested decimals', decimals: mintInfo.decimals }
    // audit R06: query at FINALIZED (irreversible) — a burn must be final before it authorizes a
    // real Bitcoin release; 'confirmed' can still be rolled back.
    const tx = await connection.getParsedTransaction(txid, { maxSupportedTransactionVersion: 0, commitment: 'finalized' })
    if (!tx) return { valid: false, reason: 'tx not found or not yet FINALIZED' }
    if (!tx.meta || tx.meta.err !== null) return { valid: false, reason: 'tx failed or execution result unavailable' }
    const ixs = [...(tx.transaction.message.instructions || []), ...((tx.meta && tx.meta.innerInstructions) || []).flatMap(i => i.instructions)]
    for (const ix of ixs) {
      let canonicalProgram = false
      try { canonicalProgram = new PublicKey(ix.programId).equals(TOKEN_PROGRAM_ID) } catch (_) {}
      if (canonicalProgram && ix.parsed && (ix.parsed.type === 'burn' || ix.parsed.type === 'burnChecked')) {
        const info = ix.parsed.info || {}
        if (info.mint === mintAddr) {
          const amt = BigInt((info.amount != null ? info.amount : (info.tokenAmount && info.tokenAmount.amount)) || '0')
          // owner = the burn authority (who signed the burn) — audit: bind authorization to the burner.
          if (amt === want) return { valid: true, burned: amt.toString(), owner: info.authority || null, chain,
            finalized: true, decimals: mintInfo.decimals, token_program: TOKEN_PROGRAM_ID.toBase58() }
        }
      }
    }
    return { valid: false, reason: 'no matching burn of that mint/amount' }
  } catch (e) {
    // Provider errors may embed credentials in an RPC URL. Expose only our own
    // bounded identity/error codes, never a provider's raw message or URL.
    const code = e.code === 'RPC_UNCERTAIN' || e.code === 'CHAIN_IDENTITY_MISMATCH' ? e.code : null
    return { valid: false, reason: 'could not verify finalized Solana burn/mint state', ...(code ? { code } : {}) }
  }
}

// One-time: hand an existing raw-key-authority mint over to the Emblem vault authority.
async function migrateAuthority(mintAddr, chain = 'solana') {
  requireDevnetSigning(chain)
  await connectionForRead(chain)
  const feePayer = feePayerForSigning()
  const mint = new PublicKey(mintAddr)
  const info = await getMint(connection, mint)
  const vault = await authorityPubkey()
  if (info.mintAuthority && info.mintAuthority.equals(vault)) return { already: true }
  if (!info.mintAuthority || !info.mintAuthority.equals(feePayer.publicKey)) return { skipped: 'current authority is not the local key' }
  await setAuthority(connection, feePayer, mint, feePayer, AuthorityType.MintTokens, vault)
  return { migrated: true, mint: mintAddr, newAuthority: vault.toBase58() }
}

// One-time: hand an existing EMBLEM-vault-authority mint over to a new authority (the Squads
// multisig vault). The current authority is the Emblem vault, so it must sign the setAuthority —
// dual-sign: fee payer (gas) + Emblem (authority), same pattern as mintTo.
async function setMintAuthority(mintAddr, newAuthorityStr, chain = 'solana') {
  requireDevnetSigning(chain)
  await connectionForRead(chain)
  const feePayer = feePayerForSigning()
  const em = await emblem()
  const currentAuth = new PublicKey(em.publicKey) // Emblem vault
  const mint = new PublicKey(mintAddr)
  const info = await getMint(connection, mint)
  if (info.mintAuthority && info.mintAuthority.equals(new PublicKey(newAuthorityStr))) return { already: true }
  if (!info.mintAuthority || !info.mintAuthority.equals(currentAuth)) return { skipped: 'current mint authority is not the Emblem vault', current: info.mintAuthority ? info.mintAuthority.toBase58() : null }
  const ix = createSetAuthorityInstruction(mint, currentAuth, AuthorityType.MintTokens, new PublicKey(newAuthorityStr))
  const bh = (await connection.getLatestBlockhash()).blockhash
  const msg = new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: bh, instructions: [ix] }).compileToV0Message()
  const tx = new VersionedTransaction(msg)
  tx.sign([feePayer])
  const signedBytes = await em.signTransaction(tx)
  const signed = VersionedTransaction.deserialize(signedBytes instanceof Uint8Array ? signedBytes : Uint8Array.from(signedBytes))
  const signature = await connection.sendRawTransaction(signed.serialize())
  await connection.confirmTransaction(signature, 'confirmed')
  return { migrated: true, mint: mintAddr, newAuthority: newAuthorityStr, signature }
}

module.exports = { authorityInfo, mintTokens, migrateAuthority, setMintAuthority, verifyBurn, DECIMALS }
