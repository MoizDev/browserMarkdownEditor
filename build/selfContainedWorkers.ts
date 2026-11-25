import type { Plugin } from 'vite';
import { SELF_CONTAINED_WORKER, SELF_CONTAINED_WORKER_END } from '../src/platform/workers/scriptMarker';

const NEEDS_OWN_URL = /\bimport\.meta\b|\blocation\b|\bfetch\s*\(|\bimportScripts\b|\bnew\s+(?:Shared)?Worker\b/;

/** Marks each built worker script that needs nothing from its own URL, so the app may start later copies of it from bytes
 *  it already holds (src/platform/workers/script.ts), where its URL is a `blob:` one. Left unmarked: a static or dynamic
 *  import, `import.meta`, an asset (inside a worker Vite writes a `?url` asset or a nested `?worker&url` as a plain
 *  "/assets/x" string, in neither `imports` nor `import.meta`), and any use of `location`, `fetch`, `importScripts` or a
 *  nested worker — measured in the pinned Chrome, a blob worker's `fetch('/version.json')` throws "Failed to parse URL"
 *  and `new URL('/x', location.href)` "Invalid URL". The bundle decides, not a list kept by hand: a worker that gains any
 *  of these loses its mark and simply starts from the network again. Ordered after the minifier (which drops comments)
 *  and before the file is hashed, so the name still says what the file holds; the end mark lets the app tell a script
 *  cut short from a whole one. */
export function selfContainedWorkers(): Plugin {
    let assetPath = '/assets/';
    return {
        name: 'self-contained-workers',
        apply: 'build',
        configResolved(config) { assetPath = `${config.base}${config.build.assetsDir}/`; },
        renderChunk: {
            order: 'post',
            handler(code, chunk) {
                if (!chunk.isEntry || chunk.imports.length || chunk.dynamicImports.length || chunk.viteMetadata?.importedAssets.size
                    || NEEDS_OWN_URL.test(code) || ['"', "'", '`'].some(quote => code.includes(quote + assetPath))) return null;
                return { code: SELF_CONTAINED_WORKER + code + SELF_CONTAINED_WORKER_END, map: null };
            },
        },
    };
}
