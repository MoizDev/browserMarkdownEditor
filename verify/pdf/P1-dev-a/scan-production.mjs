#!/usr/bin/env node
// BLD-DEV-G1 reads bytes received from the served app, never a dist directory.
import { chromium } from 'playwright'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const base = process.argv[2]
const output = process.argv[3]
const identityPath = process.argv[4]
if (process.argv.length !== 5 || !base || !output || !identityPath) throw new Error('Usage: scan-production.mjs <preview-url> <scratch-output-dir> <build-served-identity.json>')
const url = new URL(base)
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('A loopback preview URL is required')
const distance = relative(root, output)
if (!isAbsolute(output) || (!distance.startsWith(`..${sep}`) && distance !== '..' && !isAbsolute(distance))) throw new Error('Output must be outside the repository')
const expected = JSON.parse(await readFile(identityPath, 'utf8'))
if (!/^[a-f0-9]{40}$/.test(expected.buildCommit) || !expected.files?.['index.html']) throw new Error('Missing expected build identity')
for (const file of Object.values(expected.files)) {
  if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('Invalid expected artifact hash/length')
}
const pin = JSON.parse(await readFile(resolve(root, 'verify/browser-pin.json'), 'utf8'))
const manifest = JSON.parse(await readFile(resolve(root, 'src/pdf/engine/dev/manifest.json'), 'utf8'))
const driver = JSON.parse(await readFile(resolve(root, 'node_modules/playwright/package.json'), 'utf8'))
if (driver.version !== '1.63.0') throw new Error('Pinned Playwright driver required')
const forbiddenHashes = new Set([manifest.sha256, ...Object.values(manifest.files).map(file => file.sha256)])
const executablePath = resolve(process.env.BME_CHROME_ROOT ?? '/Users/adham/Developer/bme-impl/scratch/browsers', pin.version, pin.executable)
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath })
try {
  if (browser.version() !== pin.version) throw new Error('Unexpected browser identity')
  const page = await browser.newPage()
  const received = []
  const networkErrors = []
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== new URL(base).origin) return route.abort()
    try {
      // CDP getResponseBody re-encoded a fetched CSS body on this Chrome (+4
      // bytes despite identical HTTP bytes). APIResponse preserves raw decoded
      // bytes: capture those, then fulfil the browser with the exact same body.
      const response = await route.fetch()
      const body = await response.body()
      const headers = { ...response.headers() }
      const text = /javascript|json|html|css|text/.test(headers['content-type'] ?? '') ? body.toString('utf8') : ''
      received.push({
        url: response.url(), status: response.status(), bytes: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
        devBuildId: /dev-[a-f0-9]{64}/.test(text), developmentQualification: /["']development["']/.test(text),
      })
      delete headers['content-encoding']
      delete headers['content-length']
      delete headers['transfer-encoding']
      await route.fulfill({ status: response.status(), headers, body })
    } catch (error) {
      networkErrors.push(String(error))
      await route.abort()
    }
  })
  await page.goto(base)
  await page.getByRole('button', { name: 'Open Vault', exact: true }).waitFor()
  // The scratch build config emits this inventory from Rollup's output graph.
  // Each entry is then fetched through the browser, so unvisited lazy chunks and
  // unreferenced emitted assets cannot escape a network-log scan.
  const inventory = await page.evaluate(async () => {
    const response = await fetch('./__p1_bundle_inventory.json', { cache: 'no-store' })
    if (!response.ok) throw new Error('Missing served build inventory')
    return response.json()
  })
  if (inventory.buildCommit !== expected.buildCommit || JSON.stringify(inventory.sourceMutation) !== JSON.stringify(expected.sourceMutation)
    || !Array.isArray(inventory.files) || !inventory.files.includes('index.html')) throw new Error('Build identity/inventory mismatch')
  const required = [...inventory.files, '__p1_bundle_inventory.json'].sort()
  if (JSON.stringify(required) !== JSON.stringify(Object.keys(expected.files).sort())) throw new Error('Expected artifact list differs from the served inventory')
  await page.evaluate(async files => {
    for (const name of files) {
      if (name.startsWith('/') || name.split('/').includes('..')) throw new Error('Unsafe build inventory path')
      const response = await fetch('./' + name, { cache: 'no-store' })
      if (!response.ok) throw new Error(`Served build file missing: ${name}`)
      await response.arrayBuffer()
    }
  }, inventory.files)
  // Each fetch resolves only after its routed body has been awaited and logged.
  if (networkErrors.length) throw new Error(`Network body collection failed: ${networkErrors.join('; ')}`)
  for (const name of required) {
    const responses = received.filter(item => new URL(item.url).pathname === new URL(name, base).pathname)
    const wanted = expected.files[name]
    if (!responses.length || responses.some(item => item.status !== 200 || item.sha256 !== wanted.sha256 || item.bytes !== wanted.bytes)) throw new Error(`Missing or wrong served artifact bytes: ${name}; expected=${JSON.stringify(wanted)}; observed=${JSON.stringify(responses)}`)
  }
  const violations = received.filter(item => forbiddenHashes.has(item.sha256) || item.devBuildId || item.developmentQualification)
  const report = {
    gate: 'BLD-DEV-G1', status: violations.length ? 'failed' : 'passed', browser: browser.version(), driver: driver.version,
    buildCommit: inventory.buildCommit, sourceMutation: inventory.sourceMutation ?? null,
    expectedIdentitySha256: createHash('sha256').update(await readFile(identityPath)).digest('hex'),
    runnerSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
    witness: { welcomePainted: true, fetchedBuildFiles: inventory.files.length, networkResponses: received.length },
    violations, network: received,
    falsePass: 'Only opening the welcome screen misses unvisited lazy chunks and unreferenced emitted assets; every output-graph entry is fetched.',
    loss: 'Finite served build inventory; route.fetch interception changes HTTP caching (decoded bodies are fulfilled unchanged). Does not prove production initialization refusal (BLD-DEV-G2) or artifact provenance.',
  }
  await page.screenshot({ path: resolve(output, 'production.png') })
  await writeFile(resolve(output, 'G1.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ gate: report.gate, status: report.status, files: inventory.files.length, violations }))
  if (violations.length) process.exitCode = 1
} finally { await browser.close() }
