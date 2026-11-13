#!/usr/bin/env node
// BLD-DEV-G1 reads bytes received from the served app, never a dist directory.
import { chromium } from 'playwright'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const base = process.argv[2]
const output = process.argv[3]
const expectedCommit = process.argv[4]
if (!base || !output || !expectedCommit) throw new Error('Usage: scan-production.mjs <preview-url> <scratch-output-dir> <expected-build-commit>')
const pin = JSON.parse(await readFile(resolve(root, 'verify/browser-pin.json'), 'utf8'))
const manifest = JSON.parse(await readFile(resolve(root, 'src/pdf/engine/dev/manifest.json'), 'utf8'))
const driver = JSON.parse(await readFile(resolve(root, 'node_modules/playwright/package.json'), 'utf8'))
if (driver.version !== '1.63.0') throw new Error('Pinned Playwright driver required')
const forbiddenHashes = new Set([manifest.sha256, ...Object.values(manifest.files).map(file => file.sha256)])
const executablePath = resolve(process.env.BME_CHROME_ROOT ?? '/Users/adham/Developer/bme-impl/scratch/browsers', pin.version, pin.executable)
const browser = await chromium.launch({ headless: true, executablePath })
await mkdir(output, { recursive: true })
try {
  if (browser.version() !== pin.version) throw new Error('Unexpected browser identity')
  const page = await browser.newPage()
  const received = []
  const pending = []
  page.on('response', response => {
    if (new URL(response.url()).origin !== new URL(base).origin) return
    pending.push((async () => {
      const body = await response.body()
      const type = response.headers()['content-type'] ?? ''
      const text = /javascript|json|html|css|text/.test(type) ? body.toString('utf8') : ''
      received.push({
        url: response.url(), status: response.status(), bytes: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
        devBuildId: /dev-[a-f0-9]{64}/.test(text), developmentQualification: /["']development["']/.test(text),
      })
    })())
  })
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort())
  await page.goto(base)
  await page.getByRole('button', { name: 'Open Vault', exact: true }).waitFor()
  // The scratch build config emits this inventory from Rollup's output graph.
  // Each entry is then fetched through the browser, so unvisited lazy chunks and
  // unreferenced emitted assets cannot escape a network-log scan.
  const inventory = await page.evaluate(async () => {
    const response = await fetch('./__p1_bundle_inventory.json')
    if (!response.ok) throw new Error('Missing served build inventory')
    return response.json()
  })
  if (inventory.buildCommit !== expectedCommit || !Array.isArray(inventory.files) || !inventory.files.includes('index.html')) throw new Error('Build identity/inventory mismatch')
  await page.evaluate(async files => {
    for (const name of files) {
      if (name.startsWith('/') || name.split('/').includes('..')) throw new Error('Unsafe build inventory path')
      const response = await fetch('./' + name)
      if (!response.ok) throw new Error(`Served build file missing: ${name}`)
      await response.arrayBuffer()
    }
  }, inventory.files)
  await Promise.all(pending)
  if (inventory.files.some(name => !received.some(item => new URL(item.url).pathname === new URL(name, base).pathname))) throw new Error('A build file was not observed on the network')
  const violations = received.filter(item => forbiddenHashes.has(item.sha256) || item.devBuildId || item.developmentQualification)
  const report = {
    gate: 'BLD-DEV-G1', status: violations.length ? 'failed' : 'passed', browser: browser.version(), driver: driver.version,
    buildCommit: inventory.buildCommit, sourceMutation: inventory.sourceMutation ?? null,
    witness: { welcomePainted: true, fetchedBuildFiles: inventory.files.length, networkResponses: received.length },
    violations, network: received,
    falsePass: 'Only opening the welcome screen misses unvisited lazy chunks and unreferenced emitted assets; every output-graph entry is fetched.',
    loss: 'Finite served build inventory; does not prove production initialization refusal (BLD-DEV-G2) or artifact provenance.',
  }
  await page.screenshot({ path: resolve(output, 'production.png') })
  await writeFile(resolve(output, 'G1.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ gate: report.gate, status: report.status, files: inventory.files.length, violations }))
  if (violations.length) process.exitCode = 1
} finally { await browser.close() }
