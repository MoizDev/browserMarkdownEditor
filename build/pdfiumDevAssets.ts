import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

export function developmentPdfiumAssets(): Plugin {
  let assets: { name: string; bytes: Buffer; type: string }[] = []
  return {
    name: 'development-pdfium-assets',
    configResolved(config) {
      // Production does not even read the development manifest or scratch path.
      if (config.command !== 'serve' && config.mode !== 'benchmark') return
      const scratch = process.env.BME_DEV_ENGINE_DIR
      if (!scratch) return
      const manifest = JSON.parse(readFileSync(new URL('../src/pdf/engine/dev/manifest.json', import.meta.url), 'utf8')) as {
        sha256: string; qualification: string; buildId: string;
        files: Record<string, { path: string; sha256: string; bytes: number }>;
      }
      if (manifest.qualification !== 'development' || !/^[0-9a-f]{64}$/.test(manifest.sha256) || manifest.buildId !== `dev-${manifest.sha256}`) throw new Error('Invalid development engine identity')
      assets = Object.values(manifest.files).map(file => {
        if (!/^lib\/pdfium\.(js|wasm)$/.test(file.path)) throw new Error('Unexpected development engine path')
        const bytes = readFileSync(resolve(scratch, manifest.sha256, file.path))
        if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Development engine asset integrity mismatch')
        return { name: `__bme_pdfium_dev/${manifest.sha256}/${file.path.slice(4)}`, bytes, type: file.path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' }
      })
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        const asset = assets.find(item => path === '/' + item.name || path === server.config.base + item.name)
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
