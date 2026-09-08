// StampySwap — Solana mint authority as a SQUADS v4 MULTISIG (threshold M-of-N), the production
// upgrade from the single Emblem-managed signer. Built ALONGSIDE Emblem (non-destructive): the
// multisig is its own mint authority (the vault PDA); mints go through propose → approve (M-of-N)
// → execute. Devnet. Member keypairs are server-side (not web-served). For the demo the protocol
// holds all members; in production they are independent parties (one can be the Emblem vault).
const { Connection, Keypair, PublicKey, TransactionMessage, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js')
const { createMint, getOrCreateAssociatedTokenAccount, createMintToInstruction, getMint } = require('@solana/spl-token')
const multisig = require('@sqds/multisig')
const { Permissions } = multisig.types
const fs = require('fs')
const path = require('path')

const RPC = process.env.SOLANA_DEVNET_RPC || 'https://api.devnet.solana.com'
const connection = new Connection(RPC, 'confirmed')
const MEMBERS_PATH = path.join(__dirname, '.squads-members.json') // N member keypairs (server-side)
const STATE_PATH = path.join(__dirname, '.squads-state.json')      // { createKey, multisigPda }
const FEEPATH = path.join(__dirname, '.protocol-keypair.json')     // fee payer (gas)
const THRESHOLD = parseInt(process.env.SQUADS_THRESHOLD || '2', 10)
const N_MEMBERS = parseInt(process.env.SQUADS_MEMBERS || '3', 10)

function loadFeePayer() { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(FEEPATH, 'utf8')))) }
function loadMembers() {
  if (fs.existsSync(MEMBERS_PATH)) return JSON.parse(fs.readFileSync(MEMBERS_PATH, 'utf8')).map(s => Keypair.fromSecretKey(Uint8Array.from(s)))
  const members = Array.from({ length: N_MEMBERS }, () => Keypair.generate())
  fs.writeFileSync(MEMBERS_PATH, JSON.stringify(members.map(k => Array.from(k.secretKey))), { mode: 0o600 })
  return members
}
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s), { mode: 0o600 }) }
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) } catch (_) { return null } }

const feePayer = loadFeePayer()
const members = loadMembers()

// Members are real participants — they pay rent for the proposal/tx accounts they create. Keep
// each topped up with a little devnet SOL from the fee payer (they'd self-fund in production).
async function fundMembers(minSol = 0.02, topUpSol = 0.05) {
  for (const m of members) {
    let bal = 0; try { bal = (await connection.getBalance(m.publicKey)) / LAMPORTS_PER_SOL } catch (_) {}
    if (bal >= minSol) continue
    try {
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: m.publicKey, lamports: Math.round(topUpSol * LAMPORTS_PER_SOL) }))
      await sendAndConfirmTransaction(connection, tx, [feePayer])
    } catch (_) {}
  }
}

// Create the multisig on devnet (idempotent — reuses the stored one).
async function ensureMultisig() {
  const st = loadState()
  if (st && st.multisigPda) { await fundMembers(); return st }
  await fundMembers()
  const createKey = Keypair.generate()
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey })
  const programConfigPda = multisig.getProgramConfigPda({})[0]
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda)
  const sig = await multisig.rpc.multisigCreateV2({
    connection, createKey, creator: feePayer, multisigPda,
    configAuthority: null, timeLock: 0, threshold: THRESHOLD,
    members: members.map(m => ({ key: m.publicKey, permissions: Permissions.all() })),
    rentCollector: null, treasury: programConfig.treasury,
    sendOptions: { skipPreflight: false },
  })
  await connection.confirmTransaction(sig, 'confirmed')
  const state = { createKey: Array.from(createKey.secretKey), multisigPda: multisigPda.toBase58(), threshold: THRESHOLD, members: members.map(m => m.publicKey.toBase58()) }
  saveState(state)
  return state
}

function multisigPubkey() { const st = loadState(); return st ? new PublicKey(st.multisigPda) : null }
// The vault PDA (index 0) — this is the mint AUTHORITY controlled by the M-of-N members.
function vaultAddress() { const pk = multisigPubkey(); if (!pk) return null; return multisig.getVaultPda({ multisigPda: pk, index: 0 })[0].toBase58() }

async function info() {
  const st = loadState()
  let feeBal = 0; try { feeBal = (await connection.getBalance(feePayer.publicKey)) / LAMPORTS_PER_SOL } catch (_) {}
  return {
    configured: !!st, multisig: st ? st.multisigPda : null, vault: vaultAddress(),
    threshold: st ? st.threshold : THRESHOLD, members: st ? st.members : members.map(m => m.publicKey.toBase58()),
    fee_payer: feePayer.publicKey.toBase58(), fee_payer_sol: feeBal, network: 'devnet',
    model: st ? `squads-v4 ${st.threshold}-of-${st.members.length} multisig` : 'not created',
  }
}

// Mint via the multisig: propose the mintTo → approve with THRESHOLD members → execute.
// The mint's authority must be the vault PDA (createMint uses it; existing mints must be migrated).
async function mintViaMultisig({ existingMint, amountBase, decimals, recipient }) {
  const st = await ensureMultisig()
  const multisigPda = new PublicKey(st.multisigPda)
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 })
  const amt = BigInt(amountBase)
  if (amt <= 0n) throw new Error('amount below precision')
  if (amt > (1n << 64n) - 1n) throw new Error('amount exceeds SPL u64')
  const owner = new PublicKey(recipient)

  // mint (authority = vault PDA). Fee payer creates/pays; authority is the multisig vault.
  let mint = null
  if (existingMint) { try { mint = new PublicKey(existingMint); await getMint(connection, mint) } catch (_) { mint = null } }
  if (!mint) mint = await createMint(connection, feePayer, vaultPda, vaultPda, decimals)
  const ata = await getOrCreateAssociatedTokenAccount(connection, feePayer, mint, owner)

  const mintIx = createMintToInstruction(mint, ata.address, vaultPda, amt)
  const { blockhash } = await connection.getLatestBlockhash()
  const txMessage = new TransactionMessage({ payerKey: vaultPda, recentBlockhash: blockhash, instructions: [mintIx] })

  // next transaction index
  const msAcct = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda)
  const transactionIndex = BigInt(Number(msAcct.transactionIndex) + 1)

  const memberKps = st.members.map((_, i) => members[i]) // our held members (demo)
  // 1) create the vault transaction (the mintTo). rentPayer = feePayer (members hold no SOL).
  let sig = await multisig.rpc.vaultTransactionCreate({
    connection, feePayer, multisigPda, transactionIndex, creator: memberKps[0].publicKey,
    rentPayer: feePayer.publicKey, vaultIndex: 0, ephemeralSigners: 0, transactionMessage: txMessage,
    memo: 'StampySwap mint', signers: [feePayer, memberKps[0]],
  })
  await connection.confirmTransaction(sig, 'confirmed')
  // 2) create the proposal. NB: proposalCreate's rentPayer is a SIGNER (Keypair), unlike
  // vaultTransactionCreate's rentPayer which is a PublicKey. (Squads SDK inconsistency.)
  sig = await multisig.rpc.proposalCreate({ connection, feePayer, multisigPda, transactionIndex, creator: memberKps[0], rentPayer: feePayer })
  await connection.confirmTransaction(sig, 'confirmed')
  // 3) approve with THRESHOLD members
  for (let i = 0; i < st.threshold; i++) {
    sig = await multisig.rpc.proposalApprove({ connection, feePayer, multisigPda, transactionIndex, member: memberKps[i], signers: [feePayer, memberKps[i]] })
    await connection.confirmTransaction(sig, 'confirmed')
  }
  // 4) execute
  sig = await multisig.rpc.vaultTransactionExecute({ connection, feePayer, multisigPda, transactionIndex, member: memberKps[0].publicKey, signers: [feePayer, memberKps[0]] })
  await connection.confirmTransaction(sig, 'confirmed')

  return {
    mint: mint.toBase58(), signature: sig, ata: ata.address.toBase58(),
    authority: vaultPda.toBase58(), authority_model: `squads-v4 ${st.threshold}-of-${st.members.length}`,
    transaction_index: transactionIndex.toString(),
    explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
  }
}

module.exports = { ensureMultisig, info, vaultAddress, mintViaMultisig, multisigPubkey }
