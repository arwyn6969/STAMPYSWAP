'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname,'../public/wallet.js'),'utf8')
new vm.Script(source)
const start = source.indexOf('window.stampySignForChain = async function')
const end = source.indexOf('\n  async function connectDeposit',start)
function dispatch() {
  const seen = [], context = {window:{},signSolanaMessage:async m=>{seen.push(['solana',m]);return 'solana-signature'},signEvmMessage:async m=>{seen.push(['evm',m]);return 'evm-signature'}}
  vm.runInNewContext(source.slice(start,end),context)
  return {sign:context.window.stampySignForChain,seen}
}
for(const chain of ['solana-mainnet','base-mainnet','ethereum-mainnet']) {
  test(chain+' authorization uses the correct wallet family and exact server challenge',async()=>{
    const f=dispatch(), family=chain==='solana-mainnet'?'solana':'evm'
    assert.equal(await f.sign(chain,'exact-versioned-challenge'),family+'-signature')
    assert.deepEqual(f.seen,[[family,'exact-versioned-challenge']])
  })
}
test('unknown chain cannot silently select a different signing wallet',async()=>{
  const f=dispatch();await assert.rejects(f.sign('unknown-mainnet','challenge'),/unsupported chain/);assert.equal(f.seen.length,0)
})
