import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { developmentPdfiumAssets } from './build/pdfiumDevAssets'
import { pdfContainedAssets } from './build/pdfContainedAssets'
import { pdfFontAssets } from './build/pdfFontAssets'
import { whiteboardSvgFrames } from './build/whiteboardSvgFrames.mjs'
import { containedEmbedFrames } from './build/embedFrame.mjs'
import { thirdPartyNotices } from './build/thirdPartyNotices'

const root = fileURLToPath(new URL('.', import.meta.url))
const regenerateFrame = () => execFileSync(process.execPath, ['src/epub/build-frame.mjs'], { cwd: root, stdio: 'pipe' })
const buildId = randomUUID()

export default defineConfig({
  // Index workers share split modules; Chromium-only module workers support ES chunks.
  worker: { format: 'es' },
  plugins: [react(), developmentPdfiumAssets(), pdfContainedAssets(), pdfFontAssets(), whiteboardSvgFrames(root), containedEmbedFrames(root), thirdPartyNotices(root), {
    // The benchmark-build constant (verification.md §2.1, contracts C9): true only
    // in `vite build --mode benchmark` (a dev server in that mode stays false: the
    // benchmark build is the production build plus hooks, nothing else), so every
    // measurement hook sits behind `if (__BME_BENCH__)` and the production build
    // drops it. A plugin hook, not a function config, because scratch configs spread this object.
    name: 'benchmark-build-constant',
    config(_config, { command, mode }) {
      return {
        define: { __BME_BENCH__: JSON.stringify(command === 'build' && mode === 'benchmark'), __BME_BUILD_ID__: JSON.stringify(buildId) },
        // Vite's client define may follow the initial TS transform, too late for its dead-code elimination.
        ...(command === 'serve' ? { esbuild: { define: { __BME_BENCH__: 'false' }, treeShaking: true, minifySyntax: true } } : {}),
      }
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: buildId }) })
    },
  }, {
    name: 'contained-epub-frame',
    // Runs for both dev and build, even when generated files already exist.
    // The frame is imported as raw text only from the lazy EPUB chunk, so base
    // paths never become publisher resource URLs and note-only vaults fetch none.
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
      // License texts/source inventory travel with static deployments, too.
      for (const name of ['src/epub/vendor/LICENSE', 'src/epub/vendor/PYTHON-LICENSE.txt', 'src/epub/vendor/THIRD_PARTY_NOTICES.txt', 'src/epub/vendor/source-lock.json', 'src/epub/reader-frame.integrity.json']) {
        this.emitFile({ type: 'asset', fileName: name, source: readFileSync(new URL(name, import.meta.url)) })
      }
    },
  }],
  optimizeDeps: {
    // Worker-only imports escape the HTML scan. Observed: discovering these
    // after mount changed React's shared-chunk URL; NativePdfEntry then used
    // a second dispatcher while React DOM still held the original module.
    // Pre-optimization does not fetch these lazy workers in the browser.
    include: ['@lezer/markdown', 'lz-string', 'pdf-lib', 'nspell'],
  },
})
