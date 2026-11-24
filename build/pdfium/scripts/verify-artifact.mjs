#!/usr/bin/env node
// Offline artifact verifier. A hash is never substituted for a release identity:
// ship verification is intentionally unavailable until the owner supplies and
// pins an offline Sigstore verifier and a repository/workflow/ref trust policy.
import { readFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, relative, isAbsolute } from 'node:path'

const [mode, directory, manifestPath] = process.argv.slice(2)
if (mode !== '--development' || !directory || !manifestPath || process.argv.length !== 5) {
  throw new Error('Usage: node verify-artifact.mjs --development ARTIFACT_DIR TRUSTED_MANIFEST; ship mode requires an owner-pinned offline attestation verifier and trust policy')
}
const root = await realpath(resolve(directory))
const expected = JSON.parse(await readFile(manifestPath, 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const refuse = reason => { throw new Error(`Artifact refused: ${reason}`) }
const get = async spec => {
  if (!spec || typeof spec.path !== 'string' || !/^[0-9a-f]{64}$/.test(spec.sha256) || !Number.isSafeInteger(spec.bytes) || spec.bytes < 1) refuse('invalid trusted file metadata')
  const file = await realpath(resolve(root, spec.path))
  const rel = relative(root, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) refuse('asset path escapes artifact directory')
  const bytes = await readFile(file)
  if (bytes.length !== spec.bytes || hash(bytes) !== spec.sha256) refuse(`hash/length mismatch: ${spec.path}`)
  return bytes
}
if (expected.schemaVersion !== 1 || expected.qualification !== 'development' || expected.shippingAllowed !== false || !/^dev-[a-f0-9]{64}$/.test(expected.buildId)) refuse('not a development manifest')
const inputs = await readFile(resolve(root, 'canonical-inputs.json'))
if (hash(inputs) !== expected.sha256 || expected.buildId !== `dev-${expected.sha256}`) refuse('canonical input identity mismatch')
const [wasm, glue] = await Promise.all([get(expected.files.wasm), get(expected.files.glue)])
if (hash(wasm) !== expected.artifactSha256 || !glue.toString('utf8').includes(`Module["buildId"]="${expected.buildId}"`)) refuse('artifact hash or baked identity mismatch')
await get(expected.abi)
if (expected.sbom) await get(expected.sbom)
await get(expected.notices)
for (const notice of expected.notices.files) await get(notice)
const module = new WebAssembly.Module(wasm) // compile only; never instantiate or execute native API
const actualExports = WebAssembly.Module.exports(module)
const map = JSON.parse(await readFile(new URL('../../../src/pdf/engine/pdfium/exports.json', import.meta.url), 'utf8'))
const nativeNames = map.rows.flatMap(row => row.exports)
const desired = [...nativeNames, ...map.allocatorExports, ...Object.keys(expected.runtimeExports)].sort()
const actual = actualExports.map(item => item.name).sort()
if (new Set(desired).size !== desired.length || JSON.stringify(actual) !== JSON.stringify(desired)) refuse('export set differs from pinned operation map')
if (hash(await readFile(new URL('../../../src/pdf/engine/pdfium/exports.json', import.meta.url))) !== expected.canonicalExportMapSha256) refuse('trusted operation map changed')
const allowedImports = new Set(expected.imports.map(item => `${item.module}:${item.name}:${item.kind}`))
if (WebAssembly.Module.imports(module).some(item => !allowedImports.has(`${item.module}:${item.name}:${item.kind}`))) refuse('unexpected import')
console.log(`${expected.buildId}: development artifacts match trusted manifest; NOT SHIPPABLE`)
