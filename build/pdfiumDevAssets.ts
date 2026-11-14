import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

export function developmentPdfiumAssets(): Plugin {
  let assets: { name: string; bytes: Buffer; type: string }[] = []
  return {
    name: 'development-pdfium-assets',
    // Vite exposes isPreview on ConfigEnv, not ResolvedConfig. Filtering the
    // plugin here also excludes every hook when a config object is reused.
    apply(_config, env) {
      return !env.isPreview && (env.command === 'serve' || env.mode === 'benchmark')
    },
    configResolved() {
      assets = []
      const scratch = process.env.BME_DEV_ENGINE_DIR
      if (!scratch) return
      type Asset = { path: string; sha256: string; bytes: number }
      // The source build replaces the prebuilt pin. Its input identity names
      // the directory; each served byte stream still has its own output hash.
      const manifest = JSON.parse(readFileSync(new URL('../src/pdf/engine/dev/source-manifest.json', import.meta.url), 'utf8')) as {
        sha256: string; qualification: string; buildId: string; assetDirectory: string;
        files: { glue: Asset; wasm: Asset }; abi: Asset;
        notices: Asset & { files: Asset[] };
      }
      if (manifest.qualification !== 'development' || !/^[0-9a-f]{64}$/.test(manifest.sha256) || manifest.buildId !== `dev-${manifest.sha256}` || manifest.assetDirectory !== manifest.buildId) throw new Error('Invalid development engine identity')
      assets = [manifest.files.glue, manifest.files.wasm, manifest.abi, manifest.notices, ...manifest.notices.files].map(file => {
        if (!/^(?:pdfium\.(?:mjs|wasm)|abi\.json|NOTICE\.txt|licenses\/[A-Za-z0-9-]+\.txt)$/.test(file.path)) throw new Error('Unexpected development engine path')
        const bytes = readFileSync(resolve(scratch, manifest.assetDirectory, file.path))
        if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Development engine asset integrity mismatch')
        const type = file.path.endsWith('.wasm') ? 'application/wasm' : file.path.endsWith('.mjs') ? 'text/javascript' : file.path.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8'
        return { name: `__bme_pdfium_dev/${manifest.buildId}/${file.path}`, bytes, type }
      })
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        const asset = assets.find(item => path === '/' + item.name || path === server.config.base + item.name)
        if (!asset) return next()
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return }
        res.setHeader('Content-Type', asset.type)
        // The parser stays opaque; its pinned WASM fetch is CORS + SRI with credentials omitted.
        if (asset.type === 'application/wasm') {
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
        }
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
