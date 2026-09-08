// StampySwap wallet layer (Phase 1) — CAPABILITY-BASED, not brand-pinned.
//
//  Deposit (Bitcoin, must sign SRC-20)  → Wonder Wallet ONLY.
//      Phantom dropped Ordinals/BRC-20 and never supported SRC-20/Stamps, and no
//      longer protects inscribed sats — so it CANNOT (and must not) sign SRC-20 deposits.
//  Receive (Solana)                     → any Solana wallet: Wonder Wallet OR Phantom.
//      Discovered via the Wallet Standard (covers Phantom, Wonder Wallet, etc.),
//      with an injected-Phantom fallback.
//
// Wonder Wallet can fill BOTH roles from one install.
(function () {
  'use strict'

  // --- correct base58 encode (bitcoin alphabet) to match server bs58.decode ---
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  function bs58encode(source) {
    const bytes = Array.from(source)
    let zeroes = 0; while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes++
    const digits = []
    for (let i = zeroes; i < bytes.length; i++) {
      let carry = bytes[i]
      for (let j = 0; j < digits.length; j++) { carry += digits[j] * 256; digits[j] = carry % 58; carry = (carry / 58) | 0 }
      while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0 }
    }
    let str = ''
    for (let z = 0; z < zeroes; z++) str += '1'
    for (let d = digits.length - 1; d >= 0; d--) str += B58[digits[d]]
    return str
  }
  const short = a => a ? (a.length > 14 ? a.slice(0, 6) + '…' + a.slice(-5) : a) : ''
  const state = { deposit: null, receive: null, evm: null }

  async function verifySolana(address, signature, nonce, wallet) {
    return fetch('api/auth/verify-solana', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, signature, nonce, wallet })
    }).then(r => r.json())
  }

  // ================= Wallet Standard discovery (Solana wallets) =================
  const _std = new Map()
  ;(function initWalletStandard() {
    const api = { register: (...wallets) => {
      let added = false
      wallets.forEach(w => { if (w && w.name) { _std.set(w.name, w); added = true } })
      if (added) { try { render() } catch (_) {} } // re-render when a Solana wallet registers late
      return () => {}
    } }
    window.addEventListener('wallet-standard:register-wallet', (ev) => { try { ev.detail(api) } catch (_) {} })
    try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api })) } catch (_) {}
  })()
  function solanaStandardWallets() {
    return [..._std.values()].filter(w =>
      (w.chains || []).some(c => String(c).startsWith('solana')) &&
      w.features && w.features['solana:signMessage'] && w.features['standard:connect'])
  }
  // Full list of Solana receive options (Wallet Standard + injected Phantom fallback), de-duped by name.
  function receiveOptions() {
    const opts = solanaStandardWallets().map(w => ({ name: w.name, icon: w.icon, kind: 'standard', wallet: w }))
    const injected = (window.phantom && window.phantom.solana && window.phantom.solana.isPhantom) ? window.phantom.solana
      : (window.solana && window.solana.isPhantom ? window.solana : null)
    if (injected && !opts.some(o => /phantom/i.test(o.name))) opts.push({ name: 'Phantom', kind: 'injected', wallet: injected })
    // Recommended (Wonder) first, then Phantom, then the rest — so the list reads as a guided
    // choice, not a flat dump of every installed extension.
    const rank = n => /wonder/i.test(n) ? 0 : /phantom/i.test(n) ? 1 : 2
    opts.sort((a, b) => rank(a.name) - rank(b.name))
    return opts
  }

  async function connectReceive(opt) {
    setSlot('receive', { status: 'connecting' })
    try {
      const { nonce, message } = await fetch('api/auth/nonce?role=receive').then(r => r.json())
      let address, signature
      if (opt.kind === 'standard') {
        const w = opt.wallet
        const res = await w.features['standard:connect'].connect()
        const acct = (res && res.accounts && res.accounts[0]) || (w.accounts && w.accounts[0])
        if (!acct) throw new Error('no account')
        address = acct.address
        const out = await w.features['solana:signMessage'].signMessage({ account: acct, message: new TextEncoder().encode(message) })
        signature = bs58encode((out[0] || out).signature)
      } else {
        const p = opt.wallet
        const resp = await p.connect()
        address = (resp && resp.publicKey ? resp.publicKey : p.publicKey).toString()
        const signed = await p.signMessage(new TextEncoder().encode(message), 'utf8')
        signature = bs58encode(signed.signature || signed)
      }
      const v = await verifySolana(address, signature, nonce, opt.name)
      state.receive = { address, wallet: opt.name, chain: 'solana', verified: !!v.verified }
      try { window.__stampyReceive = v.verified ? address : null } catch (_) {}
      try { window.dispatchEvent(new CustomEvent('stampy:wallet', { detail: { role: 'receive', address, chain: 'solana' } })) } catch (_) {}
      setSlot('receive', { status: 'connected', ...state.receive })
    } catch (e) { setSlot('receive', { status: 'error', error: e.message || 'rejected' }) }
  }

  // ================= Bitcoin deposit wallets =================
  // SRC-20 is ADDRESS/BALANCE-based (not sat-bound like Ordinals). Custody needs no
  // wallet "support" — the indexer credits whatever SRC-20 is sent to the vault address.
  // Depositing = signing a tx that carries the TRANSFER op (WE build the PSBT server-side).
  // So ANY PSBT/message-signing BTC wallet works. Wonder Wallet is SRC-20-aware (shows the
  // token at signing → recommended); Phantom can sign too but as a raw BTC tx.
  function bitcoinOptions() {
    const opts = []
    if (window.wonderWallet) opts.push({ name: 'Wonder Wallet', kind: 'wonder', wallet: window.wonderWallet, aware: true })
    // Leather: SRC-20 holders' primary OFFLOAD source (Leather dropped native SRC-20 support),
    // so it's a first-class deposit wallet even though it no longer displays the token.
    if (window.LeatherProvider) opts.push({ name: 'Leather', kind: 'leather', wallet: window.LeatherProvider, aware: false })
    const pb = window.phantom && window.phantom.bitcoin
    if (pb && pb.isPhantom) opts.push({ name: 'Phantom', kind: 'phantom-btc', wallet: pb, aware: false })
    return opts
  }
  // Sign an arbitrary message with a connected BTC wallet (reused for the auth proof AND the
  // deposit-binding signature). Returns a base64/string signature the server verifies via BIP-322.
  async function signBtcMessage(kind, wallet, address, message) {
    let signature
    if (kind === 'wonder') signature = await wallet.signMessage(message)
    else if (kind === 'leather') { const sr = await wallet.request('signMessage', { message, paymentType: 'p2wpkh' }); signature = sr && sr.result && sr.result.signature }
    else { const s = await wallet.signMessage(address, new TextEncoder().encode(message)); signature = s && (s.signature || s) }
    if (signature && signature.constructor === Uint8Array) signature = btoa(String.fromCharCode.apply(null, signature))
    return signature
  }
  // Exposed for the deposit-binding flow: sign a message with the currently-connected deposit wallet.
  window.stampySignBtc = async function (message) {
    const d = state.depositWallet
    if (!d) throw new Error('connect your Bitcoin (deposit) wallet first')
    return signBtcMessage(d.kind, d.wallet, d.address, message)
  }

  async function connectDeposit(opt) {
    setSlot('deposit', { status: 'connecting' })
    try {
      let address
      if (opt.kind === 'wonder') {
        const r = await opt.wallet.requestAccounts()
        const accounts = r && (r.accounts || r)
        address = Array.isArray(accounts) ? accounts[0] : accounts
        try { opt.wallet.on && opt.wallet.on('accountsChanged', () => { state.deposit = null; render() }) } catch (_) {}
      } else if (opt.kind === 'leather') { // Leather: request('getAddresses') → BTC segwit address
        const resp = await opt.wallet.request('getAddresses')
        const addrs = (resp && resp.result && resp.result.addresses) || []
        const pay = addrs.find(a => a.type === 'p2wpkh') || addrs.find(a => a.symbol === 'BTC') || addrs[0]
        address = pay && pay.address
      } else { // phantom-btc: window.phantom.bitcoin — BtcAccount[] with purpose 'payment'
        const accts = await opt.wallet.requestAccounts()
        const pay = (accts || []).find(a => a.purpose === 'payment') || (accts || [])[0]
        address = pay && pay.address
      }
      if (!address) throw new Error('no address')
      // REAL BIP-322 ownership proof over a single-use server nonce (verified server-side).
      const { nonce, message } = await fetch('api/auth/nonce?role=deposit').then(r => r.json())
      let signature = null
      try { signature = await signBtcMessage(opt.kind, opt.wallet, address, message) } catch (_) {}
      state.depositWallet = { kind: opt.kind, wallet: opt.wallet, address } // reused for deposit-binding sigs
      const v = await fetch('api/auth/verify-bitcoin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, signature, nonce, wallet: opt.name })
      }).then(r => r.json()).catch(() => ({}))
      state.deposit = { address, wallet: opt.name, chain: 'bitcoin', verified: !!v.verified, aware: opt.aware }
      try { window.__stampyBtc = address } catch (_) {}
      try { window.dispatchEvent(new CustomEvent('stampy:wallet', { detail: { role: 'deposit', address, chain: 'bitcoin' } })) } catch (_) {}
      setSlot('deposit', { status: 'connected', ...state.deposit })
    } catch (e) { setSlot('deposit', { status: 'error', error: e.message || 'rejected' }) }
  }

  // ================= EVM receive wallets (Base / Ethereum) =================
  // Any EIP-1193 injected provider (MetaMask, Coinbase, Rabby, Phantom-EVM, …). Used to receive
  // the ERC-20 representation on Base/Ethereum — so the recipient field auto-fills instead of a
  // manual paste. Ownership is proven with personal_sign (verified server-side via ethers).
  function evmOptions() {
    const eth = window.ethereum
    if (!eth) return []
    const raw = (Array.isArray(eth.providers) && eth.providers.length) ? eth.providers : [eth]
    const named = raw.map(p => ({
      name: p.isMetaMask ? 'MetaMask' : p.isCoinbaseWallet ? 'Coinbase' : p.isRabby ? 'Rabby' : (p.isPhantom ? 'Phantom' : 'Injected'),
      provider: p,
    }))
    const seen = new Set()
    return named.filter(o => (seen.has(o.name) ? false : (seen.add(o.name), true)))
  }
  async function connectEvm(opt) {
    setSlot('evm', { status: 'connecting' })
    try {
      const accts = await opt.provider.request({ method: 'eth_requestAccounts' })
      const address = accts && accts[0]
      if (!address) throw new Error('no account')
      const { nonce, message } = await fetch('api/auth/nonce?role=evm').then(r => r.json())
      let verified = false
      try {
        const sig = await opt.provider.request({ method: 'personal_sign', params: [message, address] })
        const v = await fetch('api/auth/verify-evm', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, signature: sig, nonce, wallet: opt.name }) }).then(r => r.json())
        verified = !!v.verified
      } catch (_) {}
      state.evm = { address, wallet: opt.name, chain: 'evm', verified }
      try { window.__stampyEvm = address } catch (_) {}
      try { window.dispatchEvent(new CustomEvent('stampy:wallet', { detail: { role: 'evm', address, chain: 'evm' } })) } catch (_) {}
      setSlot('evm', { status: 'connected', ...state.evm })
    } catch (e) { setSlot('evm', { status: 'error', error: e.message || 'rejected' }) }
  }

  // ================= rendering =================
  function slotEl(role) { return document.querySelector(`#w-${role}`) }
  function setSlot(role, s) { const el = slotEl(role); if (el) { el._s = s; render() } }

  function render() {
    // ---- deposit ----
    const dep = slotEl('deposit')
    if (dep) {
      const s = dep._s || { status: 'idle' }
      let body
      if (s.status === 'connected') {
        body = `<div class="waddr" title="${s.address}">${short(s.address)}</div>
                <span class="wtag">${s.wallet || ''}</span>
                ${s.verified ? '<span class="wbadge ok">✓ BIP-322 verified</span>' : '<span class="wbadge warn">unverified</span>'}
                <button class="wbtn ghost" data-act="disc-deposit">Disconnect</button>`
      } else if (s.status === 'connecting') body = `<span class="wspin"></span> Waiting for wallet…`
      else if (s.status === 'error') body = `<span class="werr">${s.error || 'error'}</span> <button class="wbtn" data-act="rescan-deposit">Retry</button>`
      else {
        const opts = bitcoinOptions()
        if (!opts.length) body = `<span class="wmiss">No Bitcoin wallet detected</span>
          <a class="wbtn ghost" href="https://wonder-wallet.com" target="_blank" rel="noopener">Wonder</a>
          <a class="wbtn ghost" href="https://leather.io" target="_blank" rel="noopener">Leather</a>
          <a class="wbtn ghost" href="https://phantom.app" target="_blank" rel="noopener">Phantom</a>`
        else body = opts.map((o, i) => `<button class="wbtn" data-dep="${i}">Connect ${o.name}${o.aware ? ' <span class="recommend">recommended</span>' : ' <span class="wraw">raw tx</span>'}</button>`).join(' ')
        dep._opts = opts
      }
      dep.innerHTML = `<div class="wtop"><span class="wdot" style="background:var(--btc)"></span>
        <div><div class="wlabel">Deposit wallet</div><div class="wchain">Bitcoin SRC-20 · any signing wallet</div></div></div>
        <div class="wbody">${body}</div>
        <div class="wnote">SRC-20 is address-based — we build the transfer; any BTC wallet that can sign it works. Many SRC-20 holders use Leather; it can sign the deposit even though it no longer displays SRC-20. Wonder Wallet shows the token.</div>`
    }
    // ---- receive ----
    const rec = slotEl('receive')
    if (rec) {
      const s = rec._s || { status: 'idle' }
      let body
      if (s.status === 'connected') {
        body = `<div class="waddr" title="${s.address}">${short(s.address)}</div>
                <span class="wtag">${s.wallet || ''}</span>
                ${s.verified ? '<span class="wbadge ok">✓ verified</span>' : '<span class="wbadge warn">unverified</span>'}
                <button class="wbtn ghost" data-act="disc-receive">Disconnect</button>`
      } else if (s.status === 'connecting') body = `<span class="wspin"></span> Waiting for wallet…`
      else if (s.status === 'error') body = `<span class="werr">${s.error || 'error'}</span> <button class="wbtn" data-act="rescan-receive">Retry</button>`
      else {
        const opts = receiveOptions()
        if (!opts.length) body = `<span class="wmiss">No Solana wallet detected</span>
          <a class="wbtn ghost" href="https://wonder-wallet.com" target="_blank" rel="noopener">Wonder</a>
          <a class="wbtn ghost" href="https://phantom.app" target="_blank" rel="noopener">Phantom</a>`
        else body = opts.map((o, i) => `<button class="wbtn" data-recv="${i}">Connect ${o.name}${/wonder/i.test(o.name) ? ' <span class="recommend">recommended</span>' : ''}</button>`).join(' ')
        rec._opts = opts
      }
      const hasWonder = receiveOptions().some(o => /wonder/i.test(o.name))
      const wonderHint = (s.status === 'connected') ? '' : (hasWonder
        ? 'Wonder Wallet can serve both roles from one install.'
        : '<b style="color:var(--btc)">Wonder Wallet not detected.</b> Any listed Solana wallet works, but <a href="https://wonder-wallet.com" target="_blank" rel="noopener" style="color:var(--btc)">Wonder Wallet</a> is recommended — one install handles both Bitcoin deposits and Solana. Other wallets shown are simply the ones detected in your browser.')
      rec.innerHTML = `<div class="wtop"><span class="wdot" style="background:var(--sol)"></span>
        <div><div class="wlabel">Receive wallet</div><div class="wchain">Solana · Wonder Wallet or Phantom recommended</div></div></div>
        <div class="wbody">${body}</div>
        <div class="wnote">${wonderHint}</div>`
    }
    // ---- evm receive (Base / Ethereum) ----
    const ev = slotEl('evm')
    if (ev) {
      const s = ev._s || { status: 'idle' }
      let body
      if (s.status === 'connected') {
        body = `<div class="waddr" title="${s.address}">${short(s.address)}</div>
                <span class="wtag">${s.wallet || ''}</span>
                ${s.verified ? '<span class="wbadge ok">✓ verified</span>' : '<span class="wbadge warn">connected</span>'}
                <button class="wbtn ghost" data-act="disc-evm">Disconnect</button>`
      } else if (s.status === 'connecting') body = `<span class="wspin"></span> Waiting for wallet…`
      else if (s.status === 'error') body = `<span class="werr">${s.error || 'error'}</span> <button class="wbtn" data-act="rescan-evm">Retry</button>`
      else {
        const opts = evmOptions()
        if (!opts.length) body = `<span class="wmiss">No EVM wallet detected</span>
          <a class="wbtn ghost" href="https://metamask.io" target="_blank" rel="noopener">MetaMask</a>`
        else body = opts.map((o, i) => `<button class="wbtn" data-evm="${i}">Connect ${o.name}</button>`).join(' ')
        ev._opts = opts
      }
      ev.innerHTML = `<div class="wtop"><span class="wdot" style="background:var(--base)"></span>
        <div><div class="wlabel">EVM wallet <span style="font-size:10px;color:var(--muted2)">optional</span></div><div class="wchain">Base / Ethereum · to receive on EVM</div></div></div>
        <div class="wbody">${body}</div>
        <div class="wnote">Only needed if you mint the representation on Base or Ethereum — it auto-fills the EVM recipient. Solana receivers can ignore this.</div>`
    }
    // ---- wire actions ----
    document.querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
      const [act, role] = b.dataset.act.split('-')
      if (act === 'rescan') setSlot(role, { status: 'idle' })
      else if (act === 'disc') { state[role] = null; setSlot(role, { status: 'idle' }) }
    })
    const depEl = slotEl('deposit')
    if (depEl) depEl.querySelectorAll('[data-dep]').forEach(b => b.onclick = () => {
      const opt = (depEl._opts || [])[+b.dataset.dep]; if (opt) connectDeposit(opt)
    })
    const recEl = slotEl('receive')
    if (recEl) recEl.querySelectorAll('[data-recv]').forEach(b => b.onclick = () => {
      const opt = (recEl._opts || [])[+b.dataset.recv]; if (opt) connectReceive(opt)
    })
    const evEl = slotEl('evm')
    if (evEl) evEl.querySelectorAll('[data-evm]').forEach(b => b.onclick = () => {
      const opt = (evEl._opts || [])[+b.dataset.evm]; if (opt) connectEvm(opt)
    })
  }

  // Detect late-injecting wallets (Wonder Wallet's async init; Wallet Standard registrations).
  window.addEventListener('wonder-wallet#initialized', () => { try { render() } catch (_) {} })
  function boot() { render(); setTimeout(render, 500); setTimeout(render, 1500) }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
