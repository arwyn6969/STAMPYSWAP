'use strict'
// Private review helper: SELECT 1 probes only. Does not provision or start a worker.
const { readdir } = require('node:fs/promises')
const path = require('node:path')
const EXPECTED_GROUP = 'stampyswap-staging'
function configuration(env) {
  if (env.ARTIFACT_GROUP !== EXPECTED_GROUP) throw Error('explicit staging group required')
  const port = Number(env.DASHBOARD_PORT)
  if (!/^\d+$/.test(env.DASHBOARD_PORT || '') || port < 1 || port > 65535) throw Error('explicit Dashboard port required')
  if (!env.DASHBOARD_TOKEN || ['undefined', 'null'].includes(env.DASHBOARD_TOKEN)) throw Error('staging DB credential required')
  if (env.STAMPY_MAINTENANCE !== '1' || env.STAMPY_CUSTODY_LIVE !== '0' || env.STAMPY_PREVIEW !== '0') throw Error('closed staging flags required')
  if (env.EMBLEM_API_KEY || env.OPERATOR_TOKEN || env.EVM_AUTHORITY || env.SOLANA_AUTHORITY || env.VAULT_DEPOSIT_ADDRESS || (env.STAMPY_DEVNET && env.STAMPY_DEVNET !== '0')) throw Error('signer/operator/vault or preview configuration prohibited')
  if (env.STAMPY_ALLOW_KEYGEN && env.STAMPY_ALLOW_KEYGEN !== '0') throw Error('key generation prohibited by this read-only check')
  return { port, token: env.DASHBOARD_TOKEN }
}
async function probeScopes(env, fetcher = fetch) {
  const { port, token } = configuration(env)
  async function query(group) {
    const url = new URL(`http://localhost:${port}/api/db/${group}/database/query`)
    url.searchParams.set('sql', 'SELECT 1 AS scope_probe')
    url.searchParams.set('params', '[]')
    return fetcher(url, { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
  }
  const staging = await query(EXPECTED_GROUP)
  if (!staging.ok) throw Error('staging query not authorized/available')
  const body = await staging.json()
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.error || body.success === false || body.truncated) throw Error('invalid staging query envelope')
  const key = ['rows', 'result', 'data'].find(k => Object.hasOwn(body, k))
  const rows = key && body[key]
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || rows[0].scope_probe !== 1 || (Object.hasOwn(body, 'rowCount') && body.rowCount !== 1)) throw Error('staging SELECT did not return exact probe result')
  const production = await query('kevmart')
  if (![401, 403].includes(production.status)) throw Error('credential isolation unproved: production query must return 401/403')
  return { group: EXPECTED_GROUP, staging_query: 'pass', production_query: 'denied', production_http_status: production.status, signer_configuration: 'absent', writes_performed: 0 }
}
async function checkFlagFiles(sourceDirectory) {
  // Inspect names only. Never open a production key or read its contents.
  const names = await readdir(sourceDirectory)
  const forbidden = new Set(['.custody-live', '.operator-token', '.protocol-keypair.json',
    '.evm-deployer.json', '.squads-members.json', '.squads-state.json',
    '.safe-owners.json', '.safe-state.json', '.solana-authority', '.evm-authority'])
  for (const name of names) {
    if (forbidden.has(name) || /^\.env(?:\.|$)/i.test(name) || /\.(?:key|pem|seed)$/i.test(name))
      throw Error('prohibited local authority/configuration file present')
  }
}
module.exports = { configuration, probeScopes, checkFlagFiles }
if (require.main === module) {
  ;(async () => {
    if (process.argv.length !== 3) throw Error('supply the exact reviewed staging source directory')
    const source = path.resolve(process.argv[2])
    await checkFlagFiles(source)
    const result = await probeScopes(process.env)
    process.stdout.write(JSON.stringify(result) + '\n')
  })().catch(() => { process.stderr.write('Staging preflight failed; no worker started. Check configuration, flag files and scope privately.\n'); process.exitCode = 1 })
}
