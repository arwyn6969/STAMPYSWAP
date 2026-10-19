'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { probeScopes, checkFlagFiles } = require('../scripts/staging-scope-preflight.cjs')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
const closed = { ARTIFACT_GROUP: 'stampyswap-staging', DASHBOARD_PORT: '4000', DASHBOARD_TOKEN: 'public-test-fixture', STAMPY_MAINTENANCE: '1', STAMPY_CUSTODY_LIVE: '0', STAMPY_PREVIEW: '0' }
function response(status, json) { return { status, ok: status >= 200 && status < 300, json: async () => json } }
test('rejects a master credential that can query production after a valid staging SELECT', async () => {
  const requests = []
  await assert.rejects(probeScopes(closed, async (url, opts) => {
    requests.push({ url: String(url), opts })
    return response(200, { rows: [{ scope_probe: 1 }], rowCount: 1 })
  }), /credential isolation unproved/)
  assert.equal(requests.length, 2)
  assert.match(requests[1].url, /\/api\/db\/kevmart\/database\/query\?/)
  assert.ok(requests.every(r => r.opts.method === 'GET' && r.opts.redirect === 'error' && new URL(r.url).searchParams.get('sql') === 'SELECT 1 AS scope_probe'))
})
test('requires positive staging permission and explicit production denial', async () => {
  let calls = 0
  const result = await probeScopes(closed, async () => ++calls === 1 ? response(200, { rows: [{ scope_probe: 1 }], rowCount: 1 }) : response(403))
  assert.equal(calls, 2); assert.equal(result.production_query, 'denied'); assert.equal(result.writes_performed, 0)
})
test('refuses wrong group or inherited signing/operator configuration before any request', async () => {
  for (const changed of [{ ARTIFACT_GROUP: 'kevmart' }, { EMBLEM_API_KEY: 'test-signing-credential' }, { OPERATOR_TOKEN: 'test-operator' }, { STAMPY_CUSTODY_LIVE: '1' }]) {
    let calls = 0
    await assert.rejects(probeScopes({ ...closed, ...changed }, async () => { calls++; throw Error('must not be reached') }))
    assert.equal(calls, 0)
  }
})
test('does not interpret missing scope denial or malformed HTTP-200 staging results as success', async () => {
  for (const body of [{ success: false, rows: [{ scope_probe: 1 }] }, { rows: [] }, { rows: [{ scope_probe: 1 }], truncated: true }, { rows: [{ scope_probe: 1 }], rowCount: 2 }]) {
    await assert.rejects(probeScopes(closed, async () => response(200, body)))
  }
  let calls = 0
  await assert.rejects(probeScopes(closed, async () => ++calls === 1 ? response(200, { rows: [{ scope_probe: 1 }] }) : response(404)), /isolation unproved/)
})

test('preflight rejects copied production key/config files without reading their contents', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stampyswap-preflight-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  await fs.writeFile(path.join(dir, 'server.js'), '// harmless tracked source')
  await checkFlagFiles(dir)
  for (const name of ['.protocol-keypair.json', '.evm-deployer.json', '.squads-members.json', '.safe-owners.json', '.operator-token', '.custody-live', '.env', '.env.local']) {
    const file = path.join(dir, name)
    await fs.writeFile(file, 'public-test-fixture-only', { mode: 0 })
    await assert.rejects(checkFlagFiles(dir), /prohibited local authority/)
    await fs.unlink(file)
  }
  await checkFlagFiles(dir)
  await assert.rejects(checkFlagFiles(path.join(dir, 'missing-source')))
})
