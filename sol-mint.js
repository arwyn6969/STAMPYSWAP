// StampySwap — Solana devnet mint with EMBLEM-MANAGED mint authority.
// The mint authority (who controls minting — the security-critical role) is the Emblem
// vault, signed via Emblem's API using EMBLEM_API_KEY. NO raw private key holds the
// authority. A local keypair is kept ONLY to pay gas (fee payer). Devnet.
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, TransactionMessage, VersionedTransaction } = require('@solana/web3.js')
const { createMint, getOrCreateAssociatedTokenAccount, createMintToInstruction, getMint, setAuthority, AuthorityType, createSetAuthorityInstruction } = require('@solana/spl-token')
const { toSolanaWeb3Signer } = require('@emblemvault/auth-sdk/signers/solana')
const fs = require('fs')
const path = require('path')

const RPC = process.env.SOLANA_DEVNET_RPC || 'https://api.devnet.solana.com'
const KEYPATH = path.join(__dirname, '.protocol-keypair.json') // fee payer (gas only); server-side, not web-served
const DECIMALS = 9

function loadFeePayer() {
  try { if (fs.existsSync(KEYPATH)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPATH, 'utf8')))) } catch (_) {}
  const kp = Keypair.generate()
  try { fs.writeFileSync(KEYPATH, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 }) } catch (_) {}
  return kp
}
const feePayer = loadFeePayer()
const connection = new Connection(RPC, 'confirmed')

let _emblem = null
async function emblem() { if (!_emblem) _emblem = await toSolanaWeb3Signer({ apiKey: process.env.EMBLEM_API_KEY }); return _emblem }
async function authorityPubkey() { return new PublicKey((await emblem()).publicKey) }

async function balanceSol() { try { return (await connection.getBalance(feePayer.publicKey)) / LAMPORTS_PER_SOL } catch (_) { return 0 } }
async function ensureFunded(minSol = 0.02) {
  let bal = await balanceSol()
  if (bal >= minSol) return { funded: true, balance: bal }
  try { const s = await connection.requestAirdrop(feePayer.publicKey, LAMPORTS_PER_SOL); await connection.confirmTransaction(s, 'confirmed') } catch (_) {}
  bal = await balanceSol()
  return { funded: bal >= minSol, balance: bal }
}

async function authorityInfo() {
  let vault = null, vaultId = null
  try { const e = await emblem(); vault = e.publicKey; vaultId = e.getVaultId() } catch (_) {}
  return {
    address: vault,                                  // mint authority = Emblem vault (managed)
    authority_model: vault ? `emblem-managed (vault ${vaultId})` : 'unavailable',
    fee_payer: feePayer.publicKey.toBase58(),         // gas only — holds no mint authority
    balance: await balanceSol(),                      // fee-payer gas balance
    network: 'devnet', rpc: RPC, decimals: DECIMALS,
  }
}

// Mint `amountBase9` (BigInt base units, 9 dp) of the asset's SPL token to `recipient`.
// Mint authority = Emblem vault (signed via Emblem); fee payer = local key (gas only).
async function mintTokens({ existingMint, amountBase, amountBase9, decimals = DECIMALS, recipient }) {
  const amt = BigInt(amountBase != null ? amountBase : amountBase9) // amountBase9 kept for back-compat
  let owner
  try { owner = new PublicKey(recipient) } catch (_) { throw new Error('recipient is not a valid Solana address') }
  if (amt <= 0n) throw new Error('amount below mint precision')
  if (amt > (1n << 64n) - 1n) throw new Error('amount exceeds SPL u64 capacity')
  const fund = await ensureFunded()
  if (!fund.funded) { const e = new Error(`gas fee-payer unfunded on devnet (${fund.balance} SOL). Send devnet SOL to ${feePayer.publicKey.toBase58()}.`); e.code = 'UNFUNDED'; e.authority = feePayer.publicKey.toBase58(); throw e }

  const em = await emblem()
  const authority = new PublicKey(em.publicKey)
  let mint = null
  if (existingMint) { try { mint = new PublicKey(existingMint); await getMint(connection, mint) } catch (_) { mint = null } }
  if (!mint) mint = await createMint(connection, feePayer, authority, authority, decimals) // decimals sized per asset (u64-safe)

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
// burn/burnChecked of the mint for ≥ amountBase9 base units. Read-only, deterministic.
async function verifyBurn(txid, mintAddr, amountBase9) {
  try {
    const tx = await connection.getParsedTransaction(txid, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
    if (!tx) return { valid: false, reason: 'tx not found' }
    if (tx.meta && tx.meta.err) return { valid: false, reason: 'tx failed' }
    const ixs = [...(tx.transaction.message.instructions || []), ...((tx.meta && tx.meta.innerInstructions) || []).flatMap(i => i.instructions)]
    for (const ix of ixs) {
      if (ix.parsed && (ix.parsed.type === 'burn' || ix.parsed.type === 'burnChecked')) {
        const info = ix.parsed.info || {}
        if (info.mint === mintAddr) {
          const amt = BigInt((info.amount != null ? info.amount : (info.tokenAmount && info.tokenAmount.amount)) || '0')
          if (amt >= BigInt(amountBase9)) return { valid: true, burned: amt.toString() }
        }
      }
    }
    return { valid: false, reason: 'no matching burn of that mint/amount' }
  } catch (e) { return { valid: false, reason: String(e.message || e) } }
}

// One-time: hand an existing raw-key-authority mint over to the Emblem vault authority.
async function migrateAuthority(mintAddr) {
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
async function setMintAuthority(mintAddr, newAuthorityStr) {
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
