import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pdfiumAssets } from './build/pdfiumAssets'
import { pdfContainedAssets } from './build/pdfContainedAssets'
import { pdfFontAssets } from './build/pdfFontAssets'
import { whiteboardSvgFrames } from './build/whiteboardSvgFrames.mjs'
import { containedEmbedFrames } from './build/embedFrame.mjs'
import { thirdPartyNotices } from './build/thirdPartyNotices'
import { selfContainedWorkers } from './build/selfContainedWorkers'

const root = fileURLToPath(new URL('.', import.meta.url))
const regenerateFrame = () => execFileSync(process.execPath, ['src/epub/build-frame.mjs'], { cwd: root, stdio: 'pipe' })
const BUILD_ID_SLOT = 'bme-build-id-slot'

export default defineConfig({
  worker: { format: 'es', plugins: () => [selfContainedWorkers()] },
  plugins: [react(), pdfiumAssets(), pdfContainedAssets(), pdfFontAssets(), whiteboardSvgFrames(root), containedEmbedFrames(root), thirdPartyNotices(root), {
    name: 'benchmark-build-constant',
    config(_config, { command, mode }) {
      return {
        define: { __BME_BENCH__: JSON.stringify(command === 'build' && mode === 'benchmark') },
        ...(command === 'serve' ? { esbuild: { define: { __BME_BENCH__: 'false' }, treeShaking: true, minifySyntax: true } } : {}),
      }
    },
  }, {
    name: 'build-identity',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'bme-build', content: BUILD_ID_SLOT }, injectTo: 'head' }],
    generateBundle(_options, bundle) {
      const hash = createHash('sha256')
      for (const name of Object.keys(bundle).sort()) {
        if (name === 'index.html') continue
        const item = bundle[name]
        hash.update(`${name}\0`).update(item.type === 'chunk' ? item.code : item.source).update('\0')
      }
      const id = hash.digest('hex').slice(0, 24)
      const html = bundle['index.html']
      if (html?.type !== 'asset' || !String(html.source).includes(BUILD_ID_SLOT)) this.error('index.html lost its build-identity meta tag')
      html.source = String(html.source).replace(BUILD_ID_SLOT, id)
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: id }) })
    },
  }, {
    name: 'contained-epub-frame',
    buildStart() { regenerateFrame() },
    async handleHotUpdate(context) {
      const path = context.file.replaceAll('\\', '/')
      if ((path.includes('/src/epub/') && !/reader-frame\.(html|integrity\.json)$/.test(path)) || path.endsWith('/src/utils/readingEmphasis.ts') || path.endsWith('/src/platform/containedFrameBuild.mjs')) {
        regenerateFrame()
        context.server.ws.send({ type: 'full-reload' })
        return []
      }
    },
    generateBundle() {
      for (const name of ['src/epub/vendor/LICENSE', 'src/epub/vendor/PYTHON-LICENSE.txt', 'src/epub/vendor/THIRD_PARTY_NOTICES.txt', 'src/epub/vendor/source-lock.json', 'src/epub/reader-frame.integrity.json']) {
        this.emitFile({ type: 'asset', fileName: name, source: readFileSync(new URL(name, import.meta.url)) })
      }
    },
  }],
  optimizeDeps: {
    include: ['@lezer/markdown', 'lz-string', 'pdf-lib', 'nspell'],
    // harfbuzzjs finds its WASM with new URL('harfbuzz.wasm', import.meta.url): pre-bundled into the
    // deps cache that URL fell through to index.html ("expected magic word 00 61 73 6d"). Excluded, it is
    // served from node_modules and never discovered late, which had reloaded the page mid-export.
    exclude: ['harfbuzzjs'],
  },
})
