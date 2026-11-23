import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const regenerateFrame = () => execFileSync(process.execPath, ['src/epub/build-frame.mjs'], { cwd: root, stdio: 'pipe' })

export default defineConfig({
  plugins: [react(), {
    name: 'contained-epub-frame',
    // Runs for both dev and build, even when generated files already exist.
    // The frame is imported as raw text only from the lazy EPUB chunk, so base
    // paths never become publisher resource URLs and note-only vaults fetch none.
    buildStart() { regenerateFrame() },
    async handleHotUpdate(context) {
      const path = context.file.replaceAll('\\', '/')
      if ((path.includes('/src/epub/') && !/reader-frame\.(html|integrity\.json)$/.test(path)) || path.endsWith('/src/utils/readingEmphasis.ts')) {
        regenerateFrame()
        context.server.ws.send({ type: 'full-reload' })
        return []
      }
    },
    generateBundle() {
      // License texts/source inventory travel with static deployments, too.
      for (const name of ['THIRD_PARTY_NOTICES', 'src/epub/vendor/LICENSE', 'src/epub/vendor/PYTHON-LICENSE.txt', 'src/epub/vendor/THIRD_PARTY_NOTICES.txt', 'src/epub/vendor/source-lock.json', 'src/epub/reader-frame.integrity.json']) {
        this.emitFile({ type: 'asset', fileName: name, source: readFileSync(new URL(name, import.meta.url)) })
      }
    },
  }],
  // `@tldraw/assets/imports.vite` is ~100 `import x from './font.woff2?url'`
  // lines. Dev pre-bundling hands them to esbuild, which has no `?url` and makes
  // every one `undefined` — so `getAssetUrlsByImport()` threw at canvasPen's
  // module scope and no canvas (annotate, drawing, notebook) could open under
  // `npm run dev`. Served unbundled, Vite resolves them as it does in a build.
  optimizeDeps: { exclude: ['@tldraw/assets'] },
})
