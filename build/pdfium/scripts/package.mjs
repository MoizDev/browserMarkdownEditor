// Product packager: no artifact is published until its linkage, memory policy
// and redistribution materials satisfy the build contract. Never instantiate
// PDFium here; native initialization belongs to the real application pane.
import { readFile, writeFile, mkdir, readdir, copyFile, rename, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { gzipSync, brotliCompressSync } from 'node:zlib'
import path from 'node:path'
import { buildSbom } from './sbom.mjs'
const root = path.resolve(process.env.BME_BUILD_DIR ?? path.dirname(new URL(import.meta.url).pathname))
const required = name => process.env[name] ?? (() => { throw new Error(`${name} required`) })()
const exportMap = path.resolve(required('BME_EXPORT_MAP'))
const engineRoot = path.resolve(required('BME_ENGINE_DIR'))
const manifestOutput = path.resolve(required('BME_MANIFEST_PATH'))
const materialRoot = path.resolve(required('BME_MATERIAL_ROOT'))
const read = p => readFile(p, 'utf8')
const sha = x => createHash('sha256').update(x).digest('hex')
const fail = text => { throw new Error(`Refusing engine publication: ${text}`) }
const same = (a,b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
const inputsBytes = await readFile(`${root}/canonical-inputs.json`)
const inputs = JSON.parse(inputsBytes)
const settings = JSON.parse(await read(`${root}/build-settings.json`))
if (!['development','ship-candidate'].includes(inputs.qualification)) fail('unknown build qualification')
if (inputs.qualification === 'ship-candidate' && (inputs.architecture !== 'linux-x86_64-native' || inputs.link.compileSourceDateEpoch !== inputs.link.linkSourceDateEpoch)) fail('ship candidate needs native x86-64 and fixed source epoch')
const buildId = `${inputs.qualification === 'development' ? 'dev-' : ''}${sha(inputsBytes)}`
if (settings.buildId !== buildId || (await read(`${root}/link.complete`)).trim() !== buildId) fail('build identity/link phase mismatch')
const exportBytes = await readFile(exportMap)
if (sha(exportBytes) !== inputs.canonicalExportMapSha256) fail('canonical op map changed since link')
const map = JSON.parse(exportBytes)
const expected = [...map.rows.flatMap(r => r.exports), ...map.allocatorExports]
const linkerNames = JSON.parse(await read(`${root}/linker-exports.json`)).map(n => n.slice(1))
if (!same(expected,linkerNames)) fail('linker allow-list differs from operation map')
const wasm = await readFile(`${root}/link/pdfium.wasm`)
const glue = await read(`${root}/link/pdfium.mjs`)
const wat = await read(`${root}/link/pdfium.wat`)
// Module reflection is compile-only. There is no Instance and no PDF API call.
const compiled = new WebAssembly.Module(wasm)
const exports = WebAssembly.Module.exports(compiled)
const imports = WebAssembly.Module.imports(compiled)
const runtimeExports = {__wasm_call_ctors:'function',setThrew:'function',_emscripten_stack_restore:'function',_emscripten_stack_alloc:'function',emscripten_stack_get_current:'function',memory:'memory',__indirect_function_table:'table'}
if (!same(exports.map(e => e.name), [...expected,...Object.keys(runtimeExports)])) fail('actual WASM export set differs from canonical+enumerated runtime exports')
for (const e of exports) if (e.kind !== (runtimeExports[e.name] ?? 'function')) fail(`export kind ${e.name}`)
const importNames = ['__syscall_fcntl64','__syscall_fstat64','__syscall_getdents64','__syscall_ioctl','__syscall_lstat64','__syscall_newfstatat','__syscall_openat','__syscall_rmdir','__syscall_stat64','__syscall_unlinkat','_abort_js','_emscripten_throw_longjmp','_gmtime_js','_localtime_js','_mmap_js','_munmap_js','_tzset_js','emscripten_date_now','emscripten_errn','emscripten_resize_heap','environ_get','environ_sizes_get','fd_close','fd_read','fd_seek','fd_write','invoke_ii','invoke_iii','invoke_iiii','invoke_iiiii','invoke_iiiiiii','invoke_vi','invoke_vii','invoke_viii','invoke_viiii']
if (imports.some(i => !importNames.includes(i.name) || i.kind !== 'function' || !['env','wasi_snapshot_preview1'].includes(i.module)) || imports.filter(i => i.name === 'emscripten_resize_heap').length !== 1) fail('uncontrolled WASM import path')
if (/\bmemory\.grow\b|\bv128\.|\b(?:i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\.|\.atomic\.|\batomics\b|\bsimd128\b/.test(wat)) fail('native grow/SIMD/thread path')
const memory = wat.match(/\(memory \$[^\s)]+ (\d+) (\d+)\)/)
if (!memory || +memory[1] !== 512 || +memory[2] !== 65536) fail('memory must be unshared WASM32 32MiB initial/4GiB maximum')
if (/\(memory[^\n]*(?:shared|i64)/.test(wat)) fail('shared or memory64 memory')
for (const text of ['const bmeRole=Module["bmeRole"]','const bmeRoleLimit=bmeRole==="render"?1073741824:bmeRole==="writer"?3758096384:0','Math.min(4294901760,bmeRoleLimit)','if(size>bmeRoleLimit)','Math.min(maxHeapSize,alignMemory(','heap-limit role=${bmeRole} requested=${requestedSize}','wasmMemory.grow(pages);updateMemoryViews()','export default createPdfium;']) if (!glue.includes(text)) fail(`missing built role/factory policy: ${text}`)
if (glue.split(`Module["buildId"]="${buildId}"`).length !== 2 || glue.split('wasmMemory.grow(').length !== 2) fail('baked identity or growth call multiplicity')
for (const name of ['HEAPU8','HEAPU32','HEAP32','HEAPF32','HEAPF64','addFunction','removeFunction',...linkerNames.map(n=>`_${n}`)]) if (!glue.includes(`Module["${name}"]=`)) fail(`missing public module binding ${name}`)
if (/https?:\/\/|\beval\s*\(|new\s+Function\b|\bFS\s*[.=]|node:fs|require\s*\(/.test(glue)) fail('CDN/network literal/eval/filesystem runtime')
// Native POSIX/WASI functions above are FILESYSTEM=0 error stubs, not an FS.
if (inputs.link.settings.FILESYSTEM !== 0 || inputs.link.settings.FORCE_FILESYSTEM !== 0 || inputs.link.settings.DYNAMIC_EXECUTION !== 0) fail('filesystem/evaluation build settings')
const graph = await read(`${root}/archive-inputs.txt`)
const groups = [...new Set([...graph.matchAll(/third_party\/([^/\s]+)/g)].map(m=>m[1]))].sort()
const handledGroups = ['abseil-cpp','agg23','brotli','emsdk','freetype','fx_agg','fx_freetype','fx_freetype.inputs','fx_lcms2','fx_lcms2.inputs','fx_libopenjpeg','fx_libopenjpeg.inputs','harfbuzz','highway','icu','lcms','libjpeg_turbo','libopenjpeg','zlib']
if (!same(groups,handledGroups)) fail('unreconciled native dependency notice group')
const linkMap = await read(`${root}/link/pdfium.map`)
const runtimeArchives = [...new Set([...linkMap.matchAll(/\/emscripten-cache\/[^\s(]+\/(lib[^\s/(]+\.a)/g)].map(m=>m[1]))].sort()
if (!same(runtimeArchives,['libc++-noexcept.a','libc++abi-noexcept.a','libc.a','libcompiler_rt.a','libdlmalloc.a','libnoexit.a','libstubs.a'])) fail('unreconciled runtime archive')
const base = `${root}/inputs/licenses`
const notices = []
const decode = bytes => { try { return new TextDecoder('utf-8',{fatal:true}).decode(bytes) } catch { return new TextDecoder('windows-1252').decode(bytes) } }
async function notice(id, source, header = false) {
  const original = await readFile(`${base}/${source}`)
  let content = original
  if (header) {
    const text = decode(original)
    const end = text.search(/^\s*#\s*(?:include|ifndef|define)\b/m)
    if (end < 0 || end > 16000) fail(`no bounded complete copyright header ${source}`)
    content = Buffer.from(text.slice(0,end).trim()+'\n')
  }
  if (content.length < 50) fail(`empty notice ${source}`)
  notices.push({id,source,path:`licenses/${id}.txt`,content,sourceSha256:sha(original)})
}
for (const [id,source,header] of [
 ['pdfium','pdfium/LICENSE'],['abseil','pdfium/third_party/abseil-cpp/LICENSE'],['agg','pdfium/third_party/agg23/agg_array.h',true],
 ['brotli','pdfium/third_party/brotli/LICENSE'],['freetype','pdfium/third_party/freetype/src/docs/FTL.TXT'],['freetype-choice','pdfium/third_party/freetype/src/LICENSE.TXT'],
 ['freetype-copyright','pdfium/third_party/freetype/src/include/freetype/freetype.h',true],['freetype-bdf','pdfium/third_party/freetype/src/src/bdf/README'],['freetype-pcf','pdfium/third_party/freetype/src/src/pcf/README'],['freetype-hash','pdfium/third_party/freetype/src/src/base/fthash.c',true],['freetype-zlib','pdfium/third_party/freetype/src/src/gzip/zlib.h',true],
 ['harfbuzz','pdfium/third_party/harfbuzz/src/COPYING'],['highway','pdfium/third_party/highway/LICENSE'],['icu','pdfium/third_party/icu/LICENSE'],
 ['lcms','pdfium/third_party/lcms/src/LICENSE'],['lcms-copyright','pdfium/third_party/lcms/src/include/lcms2.h',true],
 ['jpeg-turbo','pdfium/third_party/libjpeg_turbo/LICENSE.md'],['jpeg-ijg','pdfium/third_party/libjpeg_turbo/README.ijg'],
 ['openjpeg','pdfium/third_party/libopenjpeg/src/LICENSE'],['zlib','pdfium/third_party/zlib/zlib.h',true],
 ['emscripten','emscripten/LICENSE'],['musl','emscripten/system/lib/libc/musl/COPYRIGHT'],['compiler-rt','emscripten/system/lib/compiler-rt/LICENSE.TXT'],['libcxx','emscripten/system/lib/libcxx/LICENSE.TXT'],['libcxxabi','emscripten/system/lib/libcxxabi/LICENSE.TXT'],
]) await notice(id,source,header)
const dlmalloc = await read(`${base}/emscripten/system/lib/dlmalloc.c`)
const dlNotice = dlmalloc.match(/\/\*\s*\n This is a version[\s\S]+?\* Quickstart/)
if (!dlNotice || !dlNotice[0].includes('released to the public domain') || !dlNotice[0].includes('2.8.6')) fail('dlmalloc redistribution declaration missing')
notices.push({id:'dlmalloc',source:'emscripten/system/lib/dlmalloc.c',path:'licenses/dlmalloc.txt',sourceSha256:sha(dlmalloc),content:Buffer.from(dlNotice[0].replace(/\* Quickstart$/,'*/')+'\n')})
const fontDir='pdfium/core/fxge/fontdata/chromefontdata'
const embeddedFonts=[]
for (const name of (await readdir(`${base}/${fontDir}`)).filter(n=>n.endsWith('.cpp')).sort()) {
  await notice(`font-${name.slice(0,-4)}`,`${fontDir}/${name}`,true)
  const bytes=await readFile(`${base}/${fontDir}/${name}`)
  embeddedFonts.push({source:`core/fxge/fontdata/chromefontdata/${name}`,bytes:bytes.length,sha256:sha(bytes),licence:'PDFium BSD-3-Clause source notices'})
}
if (embeddedFonts.length < 14) fail('missing embedded font copyright materials')
const copyright = decode((await readFile(`${base}/pdfium/third_party/freetype/src/include/freetype/freetype.h`))).match(/Copyright \(C\) (\d{4}-\d{4}) by/)
if (!copyright) fail('locked FreeType copyright range missing')
const ftCredit=`Portions of this software are copyright © ${copyright[1]} The FreeType Project (https://freetype.org). All rights reserved.`
const credit=`PDFium ${inputs.qualification} engine — unsigned; NOT SHIPPABLE\n\n${ftCredit}\nThis software is based in part on the work of the Independent JPEG Group.\nFreeType is used under the FreeType License (FTL), not its alternative GPL licence.\n\nComplete original licence/notice text follows; licence files are also supplied separately.\n\n`
const noticeText=credit+notices.map(n=>`===== ${n.id} — ${n.source} =====\n${decode(n.content)}\n`).join('\n')
if (!noticeText.includes(ftCredit) || !noticeText.includes('work of the Independent JPEG Group')) fail('required credits missing')
// Retain the compiler's public declarations as data, with stable public aliases.
const dump=await read(`${root}/abi-layout.txt`)
const aliases={'FPDF_LIBRARY_CONFIG_':'FPDF_LIBRARY_CONFIG','_FPDF_FORMFILLINFO':'FPDF_FORMFILLINFO','_FPDF_SYSFONTINFO':'FPDF_SYSFONTINFO','_IFSDK_PAUSE':'IFSDK_PAUSE','FPDF_FILEWRITE_':'FPDF_FILEWRITE','_FS_MATRIX_':'FS_MATRIX','_FS_RECTF_':'FS_RECTF','FS_SIZEF_':'FS_SIZEF','FS_POINTF_':'FS_POINTF','_FS_QUADPOINTSF':'FS_QUADPOINTSF','_FPDF_SYSTEMTIME':'FPDF_SYSTEMTIME','FPDF_IMAGEOBJ_METADATA':'FPDF_IMAGEOBJ_METADATA'}
const records={}
for (const block of dump.split('*** Dumping AST Record Layout')) {
  const match=block.match(/^\s*0 \| struct (.+)$/m)
  if (!match) continue
  let name=aliases[match[1]]
  if (match[1].includes('/public/fpdfview.h:473:9')) name='FPDF_FILEACCESS'
  if (!name) continue
  const size=block.match(/\[sizeof=(\d+), align=(\d+)\]/)
  if (!size) fail(`incomplete ABI record ${name}`)
  const fields={}
  for (const m of block.matchAll(/^\s*(\d+) \|   (.+) (\w+)$/gm)) fields[m[3]]={offset:+m[1],type:m[2]}
  records[name]={size:+size[1],align:+size[2],fields}
}
for (const name of ['FPDF_LIBRARY_CONFIG','FPDF_FILEACCESS','FPDF_FORMFILLINFO','FPDF_SYSFONTINFO','IFSDK_PAUSE','FPDF_FILEWRITE','FPDF_IMAGEOBJ_METADATA']) if (!records[name]) fail(`missing ABI ${name}`)
const abi={schemaVersion:1,origin:'compile-only pinned public C headers; no native program executed',pointerBytes:4,unsignedLongBytes:4,records,headerFiles:await Promise.all((await readdir(`${root}/inputs/headers`)).sort().map(async name=>({path:`public/${name}`,sha256:sha(await readFile(`${root}/inputs/headers/${name}`))})))}
const assetStats = bytes => ({sha256:sha(bytes),bytes:bytes.length,gzipBytes:gzipSync(bytes,{level:9}).length,brotliBytes:brotliCompressSync(bytes).length})
const wasmStats=assetStats(wasm), glueStats=assetStats(Buffer.from(glue))
if (wasm.length+Buffer.byteLength(glue)>6*1024*1024) fail('raw engine+glue exceeds 6MiB build budget')
const manifest={schemaVersion:1,qualification:inputs.qualification,shippingAllowed:false,buildId,sha256:sha(inputsBytes),hashMeaning:'SHA-256 of canonical true input bytes, NOT archive or WASM bytes',artifactSha256:wasmStats.sha256,assetDirectory:buildId,servedBase:inputs.qualification === 'development' ? `/__bme_pdfium_dev/${buildId}/` : null,factory:{format:'es-module',export:'default',name:'createPdfium',roleOption:'bmeRole',roleVersion:1,instantiateWasm:'trusted compiled-module callback; raw objects remain worker-private'},files:{glue:{path:'pdfium.mjs',...glueStats},wasm:{path:'pdfium.wasm',...wasmStats}},initialMemoryBytes:33554432,maximumMemoryBytes:4294967296,roleLimits:inputs.roles,nativeExports:expected.length-map.allocatorExports.length,allocatorExports:map.allocatorExports,runtimeExports,imports,canonicalExportMapSha256:inputs.canonicalExportMapSha256,opCoverage:JSON.parse(await read(`${root}/op-coverage.json`)).operations,inputs,embeddedFonts,externalFonts:[],notices:{path:'NOTICE.txt',sha256:sha(noticeText),bytes:Buffer.byteLength(noticeText),credits:[ftCredit,'This software is based in part on the work of the Independent JPEG Group.'],files:notices.map(({content,...n})=>({...n,sha256:sha(content),bytes:content.length})),nativeDependencyGroups:groups,runtimeArchives},abi:{path:'abi.json',sha256:sha(JSON.stringify(abi,null,2)+'\n'),bytes:Buffer.byteLength(JSON.stringify(abi,null,2)+'\n')}}
const sbom = JSON.stringify(buildSbom(manifest,await readFile(`${materialRoot}/os-lock.json`),await readFile(`${materialRoot}/os-installed.tsv`)),null,2)+'\n'
manifest.sbom = {path:'sbom.spdx.json',sha256:sha(sbom),bytes:Buffer.byteLength(sbom)}
// Publish only after every refusal above. Never overwrite an existing build.
const destination=path.join(engineRoot,buildId)
for (const target of [destination, manifestOutput]) {
  try { await stat(target); fail(`output already exists, refusing overwrite: ${target}`) } catch(e) { if(e.code!=='ENOENT') throw e }
}
const temp=path.join(engineRoot,`.${buildId}.packaging-${process.pid}`)
await mkdir(`${temp}/licenses`,{recursive:true})
for (const [name,content] of [['pdfium.wasm',wasm],['pdfium.mjs',glue],['NOTICE.txt',noticeText],['abi.json',JSON.stringify(abi,null,2)+'\n'],['sbom.spdx.json',sbom],['manifest.json',JSON.stringify(manifest,null,2)+'\n'],['canonical-inputs.json',inputsBytes]]) await writeFile(`${temp}/${name}`,content,{flag:'wx'})
for (const n of notices) await writeFile(`${temp}/${n.path}`,n.content,{flag:'wx'})
await copyFile(`${root}/abi-layout.txt`,`${temp}/abi-layout.txt`)
await rename(temp,destination)
await writeFile(manifestOutput,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({buildId,destination,files:manifest.files,notices:notices.length,abiRecords:Object.keys(records).length}))
