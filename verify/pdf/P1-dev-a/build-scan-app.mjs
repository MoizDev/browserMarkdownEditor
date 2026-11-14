#!/usr/bin/env node
// Run through bme-lock build. This prepares production-config clean/mutant apps
// in scratch; it never changes the lane, shares node_modules or scans dist.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const scratch = process.argv[2]
const mutant = process.argv[3] === '--mutant'
if (!scratch || !isAbsolute(scratch) || process.argv.length !== (mutant ? 4 : 3)) throw new Error('Usage: build-scan-app.mjs <new-absolute-scratch-dir> [--mutant]')
const distance = relative(root, scratch)
if (!distance.startsWith(`..${sep}`) && distance !== '..' && !isAbsolute(distance)) throw new Error('Builds must be outside the repository')
if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Commit the supplier/gates before recording build identity')
const buildCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
await mkdir(scratch)
const app = resolve(scratch, 'app')
await mkdir(app)
const archive = execFileSync('git', ['archive', 'HEAD'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
execFileSync('tar', ['-xf', '-', '-C', app], { input: archive })
let sourceMutation = null
if (mutant) {
  const loader = resolve(app, 'src/pdf/engine/dev/loader.ts')
  const originalLoader = await readFile(loader, 'utf8')
  const condition = 'import.meta.env.DEV || __BME_BENCH__'
  if (originalLoader.split(condition).length - 1 !== 3) throw new Error('Loader mutant no longer matches its three guards')
  const changedLoader = originalLoader.replaceAll(condition, 'true')
  await writeFile(loader, changedLoader)
  const plugin = resolve(app, 'build/pdfiumDevAssets.ts')
  const originalPlugin = await readFile(plugin, 'utf8')
  const servingGuard = "return !env.isPreview && (env.command === 'serve' || env.mode === 'benchmark')"
  if (originalPlugin.split(servingGuard).length !== 2) throw new Error('Asset mutant no longer matches the production guard')
  const changedPlugin = originalPlugin.replace(servingGuard, 'return true')
  await writeFile(plugin, changedPlugin)
  // Until P3 supplies the real importer, this scratch-only reachability scaffold
  // ensures the deliberately forced-on loader is actually in the output graph.
  const entry = resolve(app, 'src/main.tsx')
  const originalEntry = await readFile(entry, 'utf8')
  if (originalEntry.includes('P1_FORCED_DEV_IMPORT')) throw new Error('Reachability scaffold already exists')
  const scaffold = '\n// P1_FORCED_DEV_IMPORT: scratch mutant only\nimport("./pdf/engine/dev/loader").then(module => console.info(module.devPdfiumAssets()))\n'
  await writeFile(entry, originalEntry + scaffold)
  sourceMutation = {
    name: 'forced-development-loader-and-assets',
    sha256: createHash('sha256').update(changedLoader).update(changedPlugin).update(scaffold).digest('hex'),
    loss: 'Uses a scratch importer scaffold while the product engine zone is dark; repeat on P3\'s real importer when it lands.',
  }
}
async function publicFiles(directory, prefix = '') {
  const names = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) names.push(...await publicFiles(resolve(directory, entry.name), prefix + entry.name + '/'))
    else if (entry.isFile()) names.push(prefix + entry.name)
    else throw new Error('Unsupported public asset entry')
  }
  return names
}
const publicNames = await publicFiles(resolve(app, 'public'))
const publicIdentity = {}
for (const name of publicNames) {
  const bytes = await readFile(resolve(app, 'public', name))
  publicIdentity[name] = { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
}
const config = resolve(scratch, 'vite.config.mjs')
await writeFile(config, `import original from ${JSON.stringify(resolve(app, 'vite.config.ts'))};
import { developmentPdfiumAssets } from ${JSON.stringify(resolve(app, 'build/pdfiumDevAssets.ts'))};
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const hasPlugin = original.plugins.some(plugin => plugin && plugin.name === 'development-pdfium-assets');
export default {
  ...original, root: ${JSON.stringify(app)}, cacheDir: ${JSON.stringify(resolve(scratch, 'vite-cache'))},
  build: { ...original.build, outDir: ${JSON.stringify(resolve(scratch, 'dist'))}, emptyOutDir: true },
  plugins: [...original.plugins, ...(hasPlugin ? [] : [developmentPdfiumAssets()]), {
    name: 'p1-served-output-inventory',
    generateBundle: { order: 'post', handler(_options, bundle) {
      this.emitFile({ type: 'asset', fileName: '__p1_bundle_inventory.json', source: JSON.stringify({
        buildCommit: ${JSON.stringify(buildCommit)}, sourceMutation: ${JSON.stringify(sourceMutation)}, files: [...new Set([...Object.keys(bundle), ...${JSON.stringify(publicNames)}])],
      }) });
    } },
    writeBundle(_options, bundle) {
      const files = ${JSON.stringify(publicIdentity)};
      for (const [name, output] of Object.entries(bundle)) {
        const bytes = Buffer.from(output.type === 'chunk' ? output.code : output.source);
        files[name] = { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
      }
      writeFileSync(${JSON.stringify(resolve(scratch, 'served-identity.json'))}, JSON.stringify({
        buildCommit: ${JSON.stringify(buildCommit)}, sourceMutation: ${JSON.stringify(sourceMutation)}, files,
      }, null, 2) + '\\n');
    },
  }],
};\n`)
execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: app, stdio: 'inherit' })
execFileSync(resolve(app, 'node_modules/.bin/vite'), ['build', '--config', config], { cwd: app, stdio: 'inherit', env: process.env })
console.log(JSON.stringify({ buildCommit, app, config, sourceMutation, preview: `${resolve(app, 'node_modules/.bin/vite')} preview --config ${config} --port <seat-port> --strictPort` }))
