import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
const work = path.resolve(process.env.BME_BUILD_DIR ?? path.dirname(new URL(import.meta.url).pathname))
const b0 = path.resolve(process.env.BME_MATERIAL_ROOT ?? (() => { throw new Error('BME_MATERIAL_ROOT required') })())
const exportMap = process.env.BME_EXPORT_MAP ?? (() => { throw new Error('BME_EXPORT_MAP required') })()
const imageDigest = process.env.BME_CONTAINER_CONFIG_DIGEST ?? (() => { throw new Error('BME_CONTAINER_CONFIG_DIGEST required') })()
if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) throw new Error('Expected immutable container config digest')
const hash = value => createHash('sha256').update(value).digest('hex')
const read = file => readFile(file, 'utf8')
const canonical = obj => JSON.stringify(sort(obj))
function sort(v) { return Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v }
const mapBytes = await read(exportMap)
const map = JSON.parse(mapBytes)
const ops = new Map()
const native = new Set()
for (const row of map.rows) {
  for (const op of row.ops) {
    const entry = ops.get(op) ?? { direct: new Set(), requires: new Set() }
    row.exports.forEach(name => entry.direct.add(name))
    ;(row.requires ?? []).forEach(name => entry.requires.add(name))
    ops.set(op, entry)
  }
  for (const name of row.exports) {
    if (!/^(FPDF|FORM|FSDK|IFSDK)[A-Za-z0-9_]*$/.test(name) || native.has(name)) throw new Error(`Duplicate/invalid canonical export ${name}`)
    native.add(name)
  }
  if (row.feature?.enabledByDefault) throw new Error('Optional char-batch feature must be off in the ordinary build')
}
// This is an operation-name inventory, NOT another op→native map. It records
// the protocol surface in03§5/10§5 independently of the native mapping.
const protocolOps = ['engine.init','doc.open','doc.close','doc.outline','doc.attachment','page.tile','page.text','page.links','page.complexity','page.release','page.emphasisProbe','font.provide','worker.stats','write.inspectAttachments','write.annotated','write.notebook','write.rotate','write.pageDigest','writer.prepareSource','writer.emitInk','writer.stageAnnotated','writer.finishAnnotated','writer.buildNotebook','writer.rotate','writer.inspect','writer.release'].sort()
if (canonical([...ops.keys()].sort()) !== canonical(protocolOps)) throw new Error('Canonical op map does not cover the declared26-op protocol')
const coverage = {}
function resolve(op, stack = []) {
  if (!ops.has(op) || stack.includes(op)) throw new Error(`Unknown/cyclic requires: ${[...stack, op].join(' -> ')}`)
  const result = new Set(ops.get(op).direct)
  for (const req of ops.get(op).requires) for (const name of resolve(req, [...stack, op])) result.add(name)
  return [...result].sort()
}
for (const op of protocolOps) coverage[op] = resolve(op)
if (native.size !== 139 || canonical([...map.allocatorExports].sort()) !== canonical(['free','malloc'])) throw new Error('Expected canonical139 native symbols and only malloc/free allocators')
const headers = (await readdir(`${work}/inputs/headers`)).filter(n => n.endsWith('.h')).sort()
const declarations = new Set()
for (const name of headers) {
  const text = await read(`${work}/inputs/headers/${name}`)
  for (const match of text.matchAll(/\bFPDF_EXPORT\s+[\s\S]*?\bFPDF_CALLCONV\s+(\w+)\s*\(/g)) declarations.add(match[1])
}
for (const name of native) if (!declarations.has(name)) throw new Error(`No pinned public declaration for ${name}`)
const linkerExports = [...native, ...map.allocatorExports].sort().map(n => `_${n}`)
const original = await read(`${work}/inputs/sdk/libcore.js.original`)
if (hash(original) !== 'd5643c2835287e0babfed87cbc058de5f880d947202a7d486956d9a197a492a0') throw new Error('Pinned libcore source drift')
let patched = original
function replace(oldText, newText) {
  if (patched.split(oldText).length !== 2) throw new Error('Emscripten role patch context drift')
  patched = patched.replace(oldText, newText)
}
replace('    {{{ Math.min(MAXIMUM_MEMORY, FOUR_GB - WASM_PAGE_SIZE) }}},', '    Math.min({{{ Math.min(MAXIMUM_MEMORY, FOUR_GB - WASM_PAGE_SIZE) }}}, bmeRoleLimit),')
replace('  $abortOnCannotGrowMemory: (requestedSize) => {', '  $abortOnCannotGrowMemory: (requestedSize) => {\n    err(`heap-limit role=${bmeRole} requested=${requestedSize}`);')
replace('  $growMemory: (size) => {\n    var oldHeapSize', '  $growMemory: (size) => {\n    if (size > bmeRoleLimit) {\n      err(`heap-limit role=${bmeRole} requested=${size}`);\n      return 0;\n    }\n    var oldHeapSize')
await mkdir(`${work}/patches`, { recursive: true })
await writeFile(`${work}/patches/libcore.js.patched`, patched)
await writeFile(`${work}/patches/libcore.js.original`, original)
let diff
try { diff = execFileSync('diff', ['-u', '--label', 'a/src/lib/libcore.js', '--label', 'b/src/lib/libcore.js', `${work}/patches/libcore.js.original`, `${work}/patches/libcore.js.patched`], { encoding: 'utf8' }) }
catch (error) { if (error.status !== 1) throw error; diff = error.stdout }
await writeFile(`${work}/patches/emscripten-role.patch`, diff)
const sdk = JSON.parse(await read(`${b0}/sdk-lock.json`))
const mode = process.env.BME_BUILD_MODE ?? 'development'
if (!['development','ship-candidate'].includes(mode)) throw new Error('Unknown build mode')
if (mode === 'ship-candidate' && sdk.architecture !== 'x86_64') throw new Error('Ship candidate requires a native x86-64 SDK lock')
const sourceDateEpoch = execFileSync('git',['show','-s','--format=%ct','HEAD'],{cwd:`${b0}/source/pdfium`,encoding:'utf8'}).trim()
const compileMarker = (await read(`${work}/compile.complete`)).trim()
if (compileMarker !== `${mode} ${mode === 'ship-candidate' ? sourceDateEpoch : 'unset'}`) throw new Error('Compile phase mode/epoch mismatch')
const toolVersion = async name => (await read(`${b0}/${name}-version.txt`)).trim()
const settings = {
  MODULARIZE:1, EXPORT_ES6:1, EXPORT_NAME:'createPdfium', ENVIRONMENT:['worker'],
  EXPORTED_FUNCTIONS:linkerExports,
  EXPORTED_RUNTIME_METHODS:['HEAPU8','HEAPU32','HEAP32','HEAPF32','HEAPF64','addFunction','removeFunction'],
  ALLOW_TABLE_GROWTH:1, ALLOW_MEMORY_GROWTH:1, INITIAL_MEMORY:33554432, MAXIMUM_MEMORY:4294967296,
  MALLOC:'dlmalloc', ABORTING_MALLOC:1, ASSERTIONS:0, STACK_OVERFLOW_CHECK:0,
  FILESYSTEM:0, FORCE_FILESYSTEM:0, DYNAMIC_EXECUTION:0, MEMORY64:0,
  INCOMING_MODULE_JS_API:['instantiateWasm','locateFile','onAbort','print','printErr','noInitialRun','bmeRole'],
}
const templates = {}
for (const file of ['role-pre.template.js','abi.c','generate-inputs.mjs','link.sh']) templates[file] = hash(await read(`${work}/${file}`))
const patches = {}
for (const file of ['b0-pdfium-build-files.patch','b0-chromium-build-files.patch']) patches[file] = hash(await read(`${b0}/${file}`))
patches['emscripten-role.patch'] = hash(diff)
const inputs = {
  schemaVersion:1, qualification:mode, architecture:`linux-${sdk.architecture}-native`,
  pdfiumCommit:'6688c576fd851f4159c6fae39396da50939de110', recipeCommit:'0dc8e9598ab4496f8620043ec2c3f2eabf4eea33',
  containerImageConfig:imageDigest,
  osPackagesLockSha256:hash(await read(`${b0}/os-lock.json`)), osPackageInventorySha256:hash(await read(`${b0}/os-installed.tsv`)),
  toolchain:{ emsdkCommit:sdk.emsdkCommit, version:sdk.version, release:sdk.toolchainId, emscriptenCommit:sdk.emscriptenSourcePin,
    archives:sdk.archives, clang:await toolVersion('clang'), binaryen:await toolVersion('binaryen'), node:await toolVersion('node'),
    gn:(await read(`${b0}/gn-version.txt`)).trim(), ninja:(await read(`${b0}/ninja-version.txt`)).trim(),
    libcoreOriginalSha256:hash(original), libcorePatchedSha256:hash(patched) },
  deps:JSON.parse(await read(`${b0}/deps-revinfo.json`)),
  gnArgs:(await read(`${b0}/b0-args.gn`)).trim().split('\n'),
  link:{ optimization:'-O2', noEntry:true, settings, extraArguments:['-lexports.js'],
    rationale:'Pinned tools/link.py1582–1604: libexports.js disables export-name minification without global symbol injection or debug/assertions; unused library API is dead-stripped.',
    compileSourceDateEpoch:mode === 'ship-candidate' ? sourceDateEpoch : null, linkSourceDateEpoch:sourceDateEpoch },
  canonicalExportMapSha256:hash(mapBytes), protocolOperations:protocolOps, allocator:'dlmalloc',
  roles:{version:1,render:1073741824,writer:3758096384}, optionalFeatures:{charBatch:false,simd:false,threads:false},
  templates, patches,
}
const canonicalBytes = canonical(inputs)
const buildId = `${mode === 'development' ? 'dev-' : ''}${hash(canonicalBytes)}`
const template = await read(`${work}/role-pre.template.js`)
if (template.split('__BME_BUILD_ID__').length !== 2) throw new Error('Unique build-id template marker required')
await writeFile(`${work}/role-pre.js`, template.replace('__BME_BUILD_ID__', buildId))
await writeFile(`${work}/canonical-inputs.json`, canonicalBytes)
await writeFile(`${work}/linker-exports.json`, JSON.stringify(linkerExports, null, 2) + '\n')
await writeFile(`${work}/op-coverage.json`, JSON.stringify({operations:coverage, nativeExports:[...native].sort(), allocatorExports:map.allocatorExports}, null, 2) + '\n')
await writeFile(`${work}/build-settings.json`, JSON.stringify({buildId, settings, originalLibcoreSha256:hash(original), patchedLibcoreSha256:hash(patched), sourceDateEpoch:inputs.link.linkSourceDateEpoch},null,2)+'\n')
console.log(JSON.stringify({buildId,nativeExports:native.size,ops:protocolOps.length,libcorePatchSha256:hash(diff)}))
