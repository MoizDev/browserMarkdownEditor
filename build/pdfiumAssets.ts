import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

// The one PDFium engine the app ships: src/pdf/vendor/pdfium/, our from-source build (build/pdfium/README.md).
// Dev and production serve the same committed bytes at pdfium/<buildId>/; a missing or altered file fails the
// dev server and `npm run build` here, before anything is served. NOTICE.txt and licenses/ ship with it.
const root = fileURLToPath(new URL('../', import.meta.url))
const engineDir = resolve(root, 'src/pdf/vendor/pdfium')
const PATH = /^(?:pdfium\.(?:mjs|wasm)|abi\.json|NOTICE\.txt|licenses\/[A-Za-z0-9-]+\.txt)$/

type Asset = { path: string; sha256: string; bytes: number }

function readEngine() {
  const manifest = JSON.parse(readFileSync(resolve(engineDir, 'manifest.json'), 'utf8')) as {
    buildId: string; artifactSha256: string; files: { glue: Asset; wasm: Asset }; abi: Asset; notices: Asset & { files: Asset[] }
  }
  if (!/^(?:dev-)?[0-9a-f]{64}$/.test(manifest.buildId) || manifest.files.wasm.sha256 !== manifest.artifactSha256) throw new Error('Invalid PDFium engine manifest')
  return [manifest.files.glue, manifest.files.wasm, manifest.abi, manifest.notices, ...manifest.notices.files].map(file => {
    if (!PATH.test(file.path)) throw new Error(`Unexpected PDFium engine path: ${file.path}`)
    const bytes = readFileSync(resolve(engineDir, file.path))
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new Error(`PDFium engine file does not match src/pdf/vendor/pdfium/manifest.json: ${file.path}`)
    }
    const type = file.path.endsWith('.wasm') ? 'application/wasm' : file.path.endsWith('.mjs') ? 'text/javascript' : file.path.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8'
    return { name: `pdfium/${manifest.buildId}/${file.path}`, bytes, type }
  })
}

export function pdfiumAssets(): Plugin {
  let assets: ReturnType<typeof readEngine> = []
  return {
    name: 'pdfium-assets',
    configResolved() { assets = readEngine() },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        const asset = assets.find(item => path === '/' + item.name || path === server.config.base + item.name)
        // An unserved engine path must fail as a missing file, never as Vite's index.html (a wasm MIME error at the caller).
        if (!asset && (path.startsWith('/pdfium/') || path.startsWith(server.config.base + 'pdfium/'))) { res.statusCode = 404; res.end(); return }
        if (!asset) return next()
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return }
        res.setHeader('Content-Type', asset.type)
        res.setHeader('Content-Length', asset.bytes.length)
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.end(req.method === 'HEAD' ? undefined : asset.bytes)
      })
    },
    generateBundle() {
      for (const asset of assets) this.emitFile({ type: 'asset', fileName: asset.name, source: asset.bytes })
    },
  }
}
