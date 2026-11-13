#!/usr/bin/env node
// P1-dev-a's explicitly isolated bootstrap witness, NOT an integrated P3 gate.
// Native calls live only in this dev browser run, never in product startup.
import { chromium } from 'playwright'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const base = process.argv[2]
const output = process.argv[3]
const evidence = process.argv[4]
if (!base || !output || !evidence) throw new Error('Usage: load-engine.mjs <dev-url> <scratch-output-dir> <evidence-export-list>')
const pin = JSON.parse(await readFile(resolve(root, 'verify/browser-pin.json'), 'utf8'))
const manifest = JSON.parse(await readFile(resolve(root, 'src/pdf/engine/dev/manifest.json'), 'utf8'))
const driver = JSON.parse(await readFile(resolve(root, 'node_modules/playwright/package.json'), 'utf8'))
if (driver.version !== '1.63.0') throw new Error('The pinned Playwright driver is required')
const expectedExports = (await readFile(evidence, 'utf8')).trim().split('\n').sort()
const executablePath = resolve(process.env.BME_CHROME_ROOT ?? '/Users/adham/Developer/bme-impl/scratch/browsers', pin.version, pin.executable)

// A fixed single-page PDF: Helvetica text and a solid rectangle ensure a white
// bitmap cannot be mistaken for a successfully initialized renderer.
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 180] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  (() => { const stream = '0 0 0 rg 20 20 80 40 re f\nBT /F1 18 Tf 20 120 Td (PDFium witness) Tj ET\n'; return `<< /Length ${stream.length} >>\nstream\n${stream}endstream` })(),
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
]
let pdf = '%PDF-1.7\n'
const offsets = [0]
objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` })
const xref = pdf.length
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
const pdfBytes = [...Buffer.from(pdf, 'ascii')]
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath })
let result
try {
  if (browser.version() !== pin.version) throw new Error(`Unexpected browser: ${browser.version()}`)
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort())
  await page.goto(base)
  await page.getByRole('button', { name: 'Open Vault', exact: true }).waitFor()
  // This isolated loader witness is the one P1-dev-a exception to app-gesture
  // entry: the real host does not exist yet. P3 must re-prove it via a real PDF.
  result = await page.evaluate(async ({ pdfBytes }) => {
    const { createDevPdfiumRuntimeSource, devPdfiumAssets } = await import('/src/pdf/engine/dev/loader.ts')
    const assets = devPdfiumAssets()
    const glueResponse = await fetch(assets.glueUrl)
    const wasmResponse = await fetch(assets.wasmUrl)
    if (!glueResponse.ok || !wasmResponse.ok || !wasmResponse.headers.get('content-type')?.includes('application/wasm')) throw new Error('Engine asset serving failed')
    const glueSource = await glueResponse.text()
    const glueBytes = new TextEncoder().encode(glueSource)
    const glueSha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', glueBytes)), b => b.toString(16).padStart(2, '0')).join('')
    if (glueSha !== assets.files.glue.sha256 || glueBytes.byteLength !== assets.files.glue.bytes) throw new Error('Glue integrity mismatch')
    const wasmBytes = await wasmResponse.arrayBuffer()
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', wasmBytes)), b => b.toString(16).padStart(2, '0')).join('')
    if (sha !== assets.files.wasm.sha256 || wasmBytes.byteLength !== assets.files.wasm.bytes) throw new Error('WASM integrity mismatch')
    const runtimeSource = createDevPdfiumRuntimeSource()
    const frame = document.createElement('iframe')
    frame.sandbox = 'allow-scripts'
    const workerBody = `onmessage = async event => {
      try {
        const engine = await instantiateDevPdfium({ compiledModule: event.data.module, glueSource: event.data.glue, role: event.data.role });
        const m = engine.module;
        m._FPDF_InitLibrary();
        const pdf = new Uint8Array(event.data.pdf);
        const ptr = m._malloc(pdf.byteLength) >>> 0;
        engine.HEAPU8.set(pdf, ptr);
        const doc = m._FPDF_LoadMemDocument(ptr, pdf.byteLength, 0);
        if (!doc) throw new Error('Generated PDF did not open');
        const pageCount = m._FPDF_GetPageCount(doc);
        const page = m._FPDF_LoadPage(doc, 0);
        const width = 240, height = 180;
        const bitmap = m._FPDFBitmap_CreateEx(width, height, 4, 0, 0);
        m._FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
        const matrix = m._malloc(24) >>> 0, clip = m._malloc(16) >>> 0;
        engine.HEAPF32.set([1, 0, 0, 1, 0, 0], matrix / 4);
        engine.HEAPF32.set([0, 0, width, height], clip / 4);
        m._FPDF_RenderPageBitmapWithMatrix(bitmap, page, matrix, clip, 0);
        const start = m._FPDFBitmap_GetBuffer(bitmap) >>> 0;
        const stride = m._FPDFBitmap_GetStride(bitmap);
        const rgba = new Uint8ClampedArray(width * height * 4);
        let inkPixels = 0;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const source = start + y * stride + x * 4, dest = (y * width + x) * 4;
          rgba[dest] = engine.HEAPU8[source + 2]; rgba[dest + 1] = engine.HEAPU8[source + 1]; rgba[dest + 2] = engine.HEAPU8[source]; rgba[dest + 3] = 255;
          if (rgba[dest] < 240 || rgba[dest + 1] < 240 || rgba[dest + 2] < 240) inkPixels++;
        }
        const memoryBytes = engine.HEAPU8.byteLength;
        m._FPDFBitmap_Destroy(bitmap); m._FPDF_ClosePage(page); m._FPDF_CloseDocument(doc);
        m._free(matrix); m._free(clip); m._free(ptr); m._FPDF_DestroyLibrary();
        postMessage({ kind: 'ready', buildId: engine.buildId, pageCount, inkPixels, memoryBytes, width, height, rgba }, [rgba.buffer]);
      } catch (error) { postMessage({ kind: 'failed', error: String(error) }); }
    };`
    const frameBody = `onmessage = async event => {
      try {
        const data = event.data;
        const module = await WebAssembly.compile(data.wasmBytes);
        const exports = WebAssembly.Module.exports(module).map(item => item.name).sort();
        const roles = ['render', 'writer'];
        for (const role of roles) {
          const url = URL.createObjectURL(new Blob([data.runtimeSource, data.workerBody], {type:'text/javascript'}));
          const worker = new Worker(url);
          URL.revokeObjectURL(url);
          const response = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Worker init timed out')), 20000);
            worker.onmessage = message => { clearTimeout(timeout); resolve(message.data); };
            worker.onerror = error => { clearTimeout(timeout); reject(new Error(error.message)); };
            worker.postMessage({module, role, glue:data.glueSource, pdf:data.pdfBytes});
          });
          worker.terminate();
          if (response.kind !== 'ready') throw new Error(response.error);
          parent.postMessage({...response, exports, role}, '*', [response.rgba.buffer]);
        }
      } catch (error) { parent.postMessage({kind:'failed', error:String(error)}, '*'); }
    };`
    const reports = []
    const done = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Contained loader timed out')), 45000)
      window.addEventListener('message', event => {
        if (event.source !== frame.contentWindow) return
        if (event.data.kind === 'failed') { clearTimeout(timeout); reject(new Error(event.data.error)); return }
        const { rgba, ...report } = event.data
        const canvas = document.createElement('canvas')
        canvas.width = report.width; canvas.height = report.height
        canvas.getContext('2d').putImageData(new ImageData(rgba, report.width, report.height), 0, 0)
        canvas.dataset.role = report.role
        document.body.append(canvas)
        reports.push(report)
        if (reports.length === 2) { clearTimeout(timeout); resolve(reports) }
      })
    })
    frame.srcdoc = `<script>${frameBody}</script>`
    const loaded = new Promise(resolve => { frame.onload = resolve })
    document.body.append(frame)
    await loaded
    frame.contentWindow.postMessage({ runtimeSource, workerBody, glueSource, wasmBytes, pdfBytes: new Uint8Array(pdfBytes).buffer }, '*', [wasmBytes])
    return { assets, roles: await done }
  }, { pdfBytes })
  for (const role of result.roles) {
    if (role.buildId !== manifest.buildId || role.pageCount !== 1 || role.inkPixels < 3200) throw new Error(`Missing native/paint witness: ${JSON.stringify(role)}`)
    if (JSON.stringify(role.exports) !== JSON.stringify(expectedExports)) throw new Error('Module exports differ from the planning evidence list')
    if (role.memoryBytes > (role.role === 'render' ? 1_073_741_824 : 2_147_483_648)) throw new Error('Role memory exceeds the effective bound')
  }
  await page.locator('canvas[data-role="render"]').screenshot({ path: resolve(output, 'render.png') })
  await page.locator('canvas[data-role="writer"]').screenshot({ path: resolve(output, 'writer.png') })
  result = {
    status: 'isolated-bootstrap-witness-only', browser: browser.version(), driver: driver.version,
    buildCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    fixtureSha256: createHash('sha256').update(Buffer.from(pdfBytes)).digest('hex'),
    ...result,
    loss: 'Not an integrated P3 gate; no real document UI, role-capacity boundary, callback, codec or containment security qualification.',
  }
  await writeFile(resolve(output, 'loader.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ status: result.status, buildId: manifest.buildId, roles: result.roles.map(({ exports, ...role }) => ({ ...role, exportCount: exports.length })) }))
} finally { await browser.close() }
