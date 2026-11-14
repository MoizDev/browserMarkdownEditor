#!/usr/bin/env node
// The archive is a development input, never a repository asset. A corrupt cache
// is an error, not permission to replace bytes another lane may already use.
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, mkdir, open, readFile, realpath, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const manifestPath = fileURLToPath(new URL('../../../src/pdf/engine/dev/manifest.json', import.meta.url))
const repository = await realpath(fileURLToPath(new URL('../../../', import.meta.url)))
const args = process.argv.slice(2)
const options = new Map()
for (let i = 0; i < args.length; i += 2) {
  if (!['--out-dir', '--archive'].includes(args[i]) || !args[i + 1] || options.has(args[i])) {
    throw new Error('Usage: node verify/pdf/engine/fetch-dev-artefact.mjs --out-dir /scratch/engine [--archive /local/archive.tgz]')
  }
  options.set(args[i], args[i + 1])
}
const output = options.get('--out-dir')
if (!output || !isAbsolute(output)) throw new Error('--out-dir must be an absolute scratch path')
await mkdir(output, { recursive: true })
const outputRoot = await realpath(output)
const relativeOutput = relative(repository, outputRoot)
if (relativeOutput === '' || (!relativeOutput.startsWith(`..${sep}`) && relativeOutput !== '..' && !isAbsolute(relativeOutput))) {
  throw new Error('Engine artefacts must be outside the repository')
}
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0 || !/^[0-9a-f]{64}$/.test(manifest.sha256)
  || manifest.qualification !== 'development' || manifest.buildId !== `dev-${manifest.sha256}`) {
  throw new Error('Invalid pinned development manifest')
}
const url = new URL(manifest.url)
if (url.protocol !== 'https:' || url.username || url.password || url.host !== 'github.com'
  || url.pathname !== '/bblanchon/pdfium-binaries/releases/download/chromium/8152/pdfium-wasm.tgz') {
  throw new Error('The development archive URL must be the pinned public release without credentials')
}
const archive = resolve(outputRoot, `pdfium-${manifest.sha256}.tgz`)
async function verify(path) {
  const info = await stat(path)
  if (!info.isFile() || info.size !== manifest.bytes) throw new Error(`Archive length mismatch: expected ${manifest.bytes}, got ${info.size}`)
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  if (hash.digest('hex') !== manifest.sha256) throw new Error('Archive SHA-256 mismatch')
}
let cached = false
try {
  await verify(archive)
  cached = true
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
if (!cached) {
  const temporary = resolve(dirname(archive), `.pdfium-${randomUUID()}.partial`)
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    const local = options.get('--archive')
    const response = local ? null : await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(120_000) })
    if (response && (!response.ok || !response.body)) throw new Error(`Archive download failed: HTTP ${response.status}`)
    const stream = local ? createReadStream(resolve(local)) : response.body
    let received = 0
    for await (const part of stream) {
      received += part.byteLength
      if (received > manifest.bytes) throw new Error('Archive exceeds pinned length')
      await handle.writeFile(part)
    }
    await handle.sync()
    await handle.close()
    handle = undefined
    await verify(temporary)
    // A hard link publishes only complete verified bytes, and cannot replace a
    // file another simultaneous fetch has already published.
    try { await link(temporary, archive) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      await verify(archive)
    }
  } finally {
    await handle?.close()
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}
const directory = resolve(outputRoot, manifest.sha256)
async function verifyFiles(root) {
  for (const file of Object.values(manifest.files)) {
    if (!/^lib\/pdfium\.(?:js|wasm)$/.test(file.path)) throw new Error('Unexpected engine asset path')
    const path = resolve(root, file.path)
    if (await realpath(path) !== path) throw new Error('Engine assets must not be symlinks')
    const bytes = await readFile(path)
    if (bytes.byteLength !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new Error(`Extracted engine asset does not match the manifest: ${file.path}`)
    }
  }
}
try { await stat(directory) } catch (error) {
  if (error.code !== 'ENOENT') throw error
  const temporary = resolve(outputRoot, `.pdfium-${randomUUID()}.extracting`)
  await mkdir(temporary)
  try {
    // Only the two web assets are unpacked. The complete archive (including all
    // supplied notices) is retained beside them for the local build hand-off.
    await promisify(execFile)('tar', ['-xzf', archive, '-C', temporary, ...Object.values(manifest.files).map(file => file.path)])
    await verifyFiles(temporary)
    try { await rename(temporary, directory) } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
      await verifyFiles(directory)
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
await verifyFiles(directory)
console.log(JSON.stringify({ archive, directory, cached, sha256: manifest.sha256, bytes: manifest.bytes, qualification: manifest.qualification, buildId: manifest.buildId }))
