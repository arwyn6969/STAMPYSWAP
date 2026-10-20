// Adapter-level regression tests. Real SPL MintLayout/getMint decode account bytes;
// all RPC transport, signer, secret-file and transaction effects are inert mocks.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const web3 = require('@solana/web3.js')
const spl = require('@solana/spl-token')
const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const MAX = (1n << 64n) - 1n
const pubkey = n => new web3.PublicKey(Buffer.alloc(32, n)) // public fixture values only
const MINT = pubkey(1), AUTHORITY = pubkey(2), WRONG = pubkey(3), RECIPIENT = pubkey(4), ATA = pubkey(5)
const ROOT = path.join(__dirname, '..')
const SOURCE_ROOT = process.env.STAMPY_MINT_SOURCE_ROOT || ROOT

function fixture(adapter, options = {}) {
  const state = { keyReads: 0, signerAccess: 0, accountReads: 0, mintCreates: 0, atas: 0, signs: 0,
    sends: 0, proposals: [], instructions: [], genesisReads: [], burnReads: [], rpcUrls: [] }
  const data = Buffer.alloc(spl.MINT_SIZE)
  spl.MintLayout.encode({
    mintAuthorityOption: options.noAuthority ? 0 : 1, mintAuthority: options.authority || AUTHORITY,
    supply: options.supply === undefined ? 10n : options.supply, decimals: options.decimals === undefined ? 7 : options.decimals,
    isInitialized: options.initialized !== false, freezeAuthorityOption: options.freezeAuthority ? 1 : 0, freezeAuthority: options.freezeAuthority || AUTHORITY,
  }, data)
  const account = { data: options.malformed ? Buffer.alloc(1) : data, owner: options.program || spl.TOKEN_PROGRAM_ID,
    executable: false, lamports: 1, rentEpoch: 0 }
  class Connection {
    constructor(url) { this.url = url; state.rpcUrls.push(url) }
    async getGenesisHash() {
      state.genesisReads.push(this.url)
      if (options.genesisError) throw Error('RPC timeout')
      return options.genesis || (this.url.includes('mainnet-fixture') ? MAINNET : DEVNET)
    }
    async getAccountInfo(address) {
      assert.equal(address.toBase58(), MINT.toBase58())
      state.accountReads++
      if (options.readError || (options.failFirstRead && state.accountReads === 1)) throw Error(options.readErrorMessage || 'RPC timeout')
      return options.missing ? null : account
    }
    async getBalance() { return 1e9 }
    async getLatestBlockhash() { return { blockhash: 'fixture-blockhash' } }
    async sendRawTransaction() { state.sends++; return 'fixture-signature' }
    async confirmTransaction() { return { value: { err: null } } }
    async getParsedTransaction(txid, config) {
      state.burnReads.push({ txid, config, url: this.url })
      return { meta: { err: options.txError || null }, transaction: { message: { instructions: [{
        parsed: { type: 'burn', info: { mint: (options.burnMint || MINT).toBase58(), amount: options.burnAmount || '1', authority: RECIPIENT.toBase58() } },
        programId: options.burnProgram || spl.TOKEN_PROGRAM_ID,
      }] } } }
    }
  }
  class TransactionMessage {
    constructor(config) { state.instructions.push(...config.instructions); this.config = config }
    compileToV0Message() { return this }
  }
  class VersionedTransaction {
    sign() { state.signs++ }
    static deserialize() { return { serialize: () => Buffer.from([0]) } }
  }
  const stateFile = { multisigPda: pubkey(6).toBase58(), threshold: 2,
    members: [pubkey(7), pubkey(8), pubkey(9)].map(k => k.toBase58()) }
  const fakeFs = {
    existsSync() { return true },
    readFileSync(file) {
      if (file.endsWith('.squads-state.json')) return JSON.stringify(stateFile)
      if (file.endsWith('.squads-members.json')) { state.keyReads++; return '[[0],[0],[0]]' }
      if (file.endsWith('.protocol-keypair.json')) { state.keyReads++; return '[0]' }
      throw Error('unexpected fixture file read')
    },
    writeFileSync() { throw Error('fixture forbids file writes') },
  }
  const rpc = Object.fromEntries(['vaultTransactionCreate', 'proposalCreate', 'proposalApprove', 'vaultTransactionExecute'].map(name => [name, async args => {
    state.proposals.push({ name, ...args }); return 'fixture-proposal-signature'
  }]))
  const dependencies = {
    '@solana/web3.js': { ...web3, Connection, TransactionMessage, VersionedTransaction,
      Keypair: { fromSecretKey: () => ({ publicKey: pubkey(10) }), generate() { throw Error('fixture forbids key generation') } } },
    '@solana/spl-token': { ...spl,
      async createMint() { state.mintCreates++; return MINT },
      async getOrCreateAssociatedTokenAccount(_connection, _payer, mint, owner) {
        state.atas++; assert(mint.equals(MINT)); assert(owner.equals(RECIPIENT)); return { address: ATA }
      },
    },
    '@emblemvault/auth-sdk/signers/solana': { async toSolanaWeb3Signer() {
      state.signerAccess++
      return { publicKey: AUTHORITY.toBase58(), getVaultId: () => 'public-fixture',
        async signTransaction() { state.signs++; return Uint8Array.of(0) } }
    } },
    '@sqds/multisig': { types: { Permissions: {} }, getVaultPda: () => [AUTHORITY], rpc,
      accounts: { Multisig: { async fromAccountAddress() { return { transactionIndex: 9007199254740993n } } } } },
    fs: fakeFs, path,
  }
  const context = { module: { exports: {} }, require(name) {
    if (!(name in dependencies)) throw Error('unmocked dependency: ' + name)
    return dependencies[name]
  }, __dirname: ROOT, process: { env: options.env || {} }, Buffer, Uint8Array, URL,
  setTimeout(callback) { callback() } }
  vm.runInNewContext(fs.readFileSync(path.join(SOURCE_ROOT, adapter + '.js'), 'utf8'), context, { filename: adapter + '.js' })
  const api = context.module.exports
  const mint = extra => api[adapter === 'sol-mint' ? 'mintTokens' : 'mintViaMultisig']({
    existingMint: MINT.toBase58(), amountBase: '1', decimals: 7, recipient: RECIPIENT.toBase58(), ...extra,
  })
  return { api, state, mint }
}

function noMintEffects(state) {
  assert.equal(state.mintCreates, 0)
  assert.equal(state.atas, 0)
  assert.equal(state.signs, 0)
  assert.equal(state.sends, 0)
  assert.equal(state.proposals.length, 0)
}

for (const adapter of ['sol-mint', 'squads']) {
  test(adapter + ': an RPC outage never replaces a stored mint or reaches transaction effects', async () => {
    const f = fixture(adapter, { readError: true })
    await assert.rejects(f.mint(), { code: 'RPC_UNCERTAIN' })
    assert.equal(f.state.accountReads, 4)
    noMintEffects(f.state)
  })
  test(adapter + ': a missing stored mint never deploys a replacement', async () => {
    const f = fixture(adapter, { missing: true })
    await assert.rejects(f.mint(), { code: 'MINT_MISSING' })
    assert.equal(f.state.accountReads, 1)
    noMintEffects(f.state)
  })
  for (const [label, options] of [
    ['different decimals', { decimals: 9 }], ['different authority', { authority: WRONG }],
    ['revoked authority', { noAuthority: true }], ['uninitialized mint', { initialized: false }],
    ['foreign freeze authority', { freezeAuthority: WRONG }],
    ['wrong account owner/token program', { program: spl.TOKEN_2022_PROGRAM_ID }], ['malformed mint bytes', { malformed: true }],
  ]) {
    test(adapter + ': ' + label + ' is rejected before ATA, signing or retries', async () => {
      const f = fixture(adapter, options)
      await assert.rejects(f.mint(), { code: 'MINT_IDENTITY_MISMATCH' })
      assert.equal(f.state.accountReads, 1)
      noMintEffects(f.state)
    })
  }
  test(adapter + ': aggregate supply overflow is rejected before transaction effects', async () => {
    const f = fixture(adapter, { supply: MAX })
    await assert.rejects(f.mint(), { code: 'MINT_SUPPLY_OVERFLOW' })
    noMintEffects(f.state)
  })
  test(adapter + ': the exact u64 boundary retains mint identity and encodes the exact amount', async () => {
    const f = fixture(adapter, { supply: MAX - 1n })
    const result = await f.mint()
    assert.equal(result.mint, MINT.toBase58())
    assert.equal(f.state.mintCreates, 0)
    assert.equal(f.state.atas, 1)
    const decoded = spl.decodeMintToInstruction(f.state.instructions[0])
    assert.equal(decoded.data.amount, 1n)
    assert(decoded.keys.mint.pubkey.equals(MINT))
    assert(decoded.keys.authority.pubkey.equals(AUTHORITY))
    if (adapter === 'squads') assert.equal(f.state.proposals[0].transactionIndex, 9007199254740994n)
    else assert.equal(f.state.sends, 1)
  })
  test(adapter + ': transient read recovery validates the same stored mint', async () => {
    const f = fixture(adapter, { failFirstRead: true })
    assert.equal((await f.mint()).mint, MINT.toBase58())
    assert.equal(f.state.accountReads, 2)
    assert.equal(f.state.mintCreates, 0)
  })
  for (const freezeAuthority of [null, AUTHORITY]) {
    test(adapter + ': interim policy accepts ' + (freezeAuthority ? 'the exact vault' : 'revoked') + ' freeze authority', async () => {
      const f = fixture(adapter, { freezeAuthority })
      assert.equal((await f.mint()).mint, MINT.toBase58())
      assert.equal(f.state.mintCreates, 0)
      assert.equal(f.state.atas, 1)
    })
  }
  test(adapter + ': RPC failure messages cannot expose paid-provider URL credentials', async () => {
    const f = fixture(adapter, { readError: true, readErrorMessage: 'timeout https://provider.invalid/private-secret?api-key=fake-secret' })
    await assert.rejects(f.mint(), error => error.code === 'RPC_UNCERTAIN' && !/private-secret|fake-secret|provider\.invalid/.test(error.message))
    noMintEffects(f.state)
  })
  test(adapter + ': a new representation may create its first mint', async () => {
    const f = fixture(adapter)
    assert.equal((await f.mint({ existingMint: null })).mint, MINT.toBase58())
    assert.equal(f.state.mintCreates, 1)
  })
  test(adapter + ': an explicitly empty stored identity cannot create a first mint', async () => {
    const f = fixture(adapter)
    await assert.rejects(f.mint({ existingMint: '' }), /stored Solana mint address is invalid/)
    noMintEffects(f.state)
  })
  test(adapter + ': unsafe numeric amounts and invalid precision are rejected before effects', async () => {
    const f = fixture(adapter)
    await assert.rejects(f.mint({ amountBase: Number.MAX_SAFE_INTEGER + 1 }), /exact integer/)
    await assert.rejects(f.mint({ decimals: 1.5 }), /decimals/)
    noMintEffects(f.state)
  })
  test(adapter + ': explicit mainnet mint is blocked before any key, signer or RPC access', async () => {
    const f = fixture(adapter)
    await assert.rejects(f.mint({ chain: 'solana-mainnet' }), { code: 'INDEPENDENT_SIGNING_REQUIRED' })
    assert.equal(f.state.keyReads, 0)
    assert.equal(f.state.signerAccess, 0)
    assert.equal(f.state.genesisReads.length, 0)
    noMintEffects(f.state)
  })
  test(adapter + ': substituting mainnet behind a devnet RPC fails before key access', async () => {
    const f = fixture(adapter, { genesis: MAINNET })
    await assert.rejects(f.mint(), { code: 'CHAIN_IDENTITY_MISMATCH' })
    assert.equal(f.state.keyReads, 0)
    assert.equal(f.state.signerAccess, 0)
    noMintEffects(f.state)
  })
}

test('Squads mainnet ensure/status cannot load locally held members or create a multisig', async () => {
  const f = fixture('squads')
  await assert.rejects(f.api.ensureMultisig('solana-mainnet'), { code: 'INDEPENDENT_SIGNING_REQUIRED' })
  assert.equal((await f.api.info('solana-mainnet')).signing_available, false)
  assert.equal(f.state.keyReads, 0)
  noMintEffects(f.state)
})

test('Solana mainnet authority migrations cannot bypass the signing hold', async () => {
  const f = fixture('sol-mint')
  await assert.rejects(f.api.migrateAuthority(MINT.toBase58(), 'solana-mainnet'), { code: 'INDEPENDENT_SIGNING_REQUIRED' })
  await assert.rejects(f.api.setMintAuthority(MINT.toBase58(), AUTHORITY.toBase58(), 'solana-mainnet'), { code: 'INDEPENDENT_SIGNING_REQUIRED' })
  assert.equal(f.state.keyReads, 0)
  assert.equal(f.state.signerAccess, 0)
  noMintEffects(f.state)
})

test('mainnet burn reads require an explicit HTTPS endpoint and exact genesis', async () => {
  for (const env of [{}, ...[
    'http://mainnet-fixture.invalid', 'https://user:password@mainnet-fixture.invalid',
    'https://@mainnet-fixture.invalid', 'https://mainnet-fixture.invalid/#fragment', 'https://mainnet-fixture.invalid/#',
  ].map(SOLANA_MAINNET_RPC => ({ SOLANA_MAINNET_RPC }))]) {
    const f = fixture('sol-mint', { env })
    assert.equal((await f.api.verifyBurn('fixture', MINT.toBase58(), '1', 'solana-mainnet')).valid, false)
    assert.equal(f.state.burnReads.length, 0)
    assert.equal(f.state.keyReads, 0)
  }
  const f = fixture('sol-mint', { env: { SOLANA_MAINNET_RPC: 'https://mainnet-fixture.invalid' }, genesis: DEVNET })
  const result = await f.api.verifyBurn('fixture', MINT.toBase58(), '1', 'solana-mainnet')
  assert.equal(result.valid, false)
  assert.equal(result.code, 'CHAIN_IDENTITY_MISMATCH')
  assert.equal(f.state.burnReads.length, 0)
})

test('public Solana status omits credential-bearing provider URLs on both networks', async () => {
  for (const chain of ['solana', 'solana-mainnet']) {
    const f = fixture('sol-mint', { env: {
      SOLANA_DEVNET_RPC: 'https://devnet-fixture.invalid/private-secret?api-key=fake-secret',
      SOLANA_MAINNET_RPC: 'https://mainnet-fixture.invalid/private-secret?api-key=fake-secret',
    } })
    const status = await f.api.authorityInfo(chain)
    assert.equal(status.rpc_configured, true)
    assert(!/private-secret|fake-secret|fixture\.invalid|api-key/.test(JSON.stringify(status)))
    assert.equal(Object.hasOwn(status, 'rpc'), false)
  }
})

test('mainnet burn/status uses its own verified endpoint, finalized reads and no local keys', async () => {
  const f = fixture('sol-mint', { env: { SOLANA_MAINNET_RPC: 'https://mainnet-fixture.invalid' } })
  const burn = await f.api.verifyBurn('fixture', MINT.toBase58(), '1', 'solana-mainnet', 7)
  assert.equal(burn.valid, true)
  assert.equal(burn.chain, 'solana-mainnet')
  assert.equal(burn.finalized, true)
  assert.equal(burn.decimals, 7)
  assert.equal(f.state.burnReads[0].config.commitment, 'finalized')
  assert.equal(f.state.burnReads[0].url, 'https://mainnet-fixture.invalid/')
  const status = await f.api.authorityInfo('solana-mainnet')
  assert.equal(status.signing_available, false)
  assert.equal(status.genesis, MAINNET)
  assert.equal(f.state.keyReads, 0)
  assert.equal(f.state.signerAccess, 0)
  noMintEffects(f.state)
})

for (const [label, options] of [
  ['noncanonical token program', { burnProgram: spl.TOKEN_2022_PROGRAM_ID }],
  ['different mint', { burnMint: WRONG }], ['larger burn', { burnAmount: '2' }],
  ['smaller burn', { burnAmount: '0' }], ['failed transaction', { txError: { InstructionError: [0, 'fixture'] } }],
  ['mint account with wrong token program', { program: spl.TOKEN_2022_PROGRAM_ID }],
]) {
  test('burn verifier rejects ' + label + ' without key or signer access', async () => {
    const f = fixture('sol-mint', options)
    assert.equal((await f.api.verifyBurn('fixture', MINT.toBase58(), '1', 'solana', 7)).valid, false)
    assert.equal(f.state.keyReads, 0)
    assert.equal(f.state.signerAccess, 0)
    noMintEffects(f.state)
  })
}

test('burn verification refuses registry/on-chain decimal disagreement before reading the burn', async () => {
  const f = fixture('sol-mint')
  const result = await f.api.verifyBurn('fixture', MINT.toBase58(), '1', 'solana', 9)
  assert.equal(result.valid, false)
  assert.equal(result.decimals, 7)
  assert.equal(f.state.burnReads.length, 0)
  assert.equal(f.state.keyReads, 0)
})
