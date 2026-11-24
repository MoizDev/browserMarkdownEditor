import type { Plugin } from 'vite';
import { SELF_CONTAINED_WORKER } from '../src/platform/workers/scriptMarker';

/** Marks each built worker script that imports nothing — no static or dynamic import, no `import.meta` (an asset URL
 *  or a nested worker) — so the app may start later copies of it from bytes it already holds
 *  (src/platform/workers/script.ts). The bundler's own import graph decides, not a list kept by hand: a worker that
 *  gains an import loses its mark and simply starts from the network again. Ordered after the minifier (which drops
 *  comments) and before the file is hashed, so the name still says what the file holds. */
export function selfContainedWorkers(): Plugin {
    return {
        name: 'self-contained-workers',
        apply: 'build',
        renderChunk: {
            order: 'post',
            handler(code, chunk) {
                if (!chunk.isEntry || chunk.imports.length || chunk.dynamicImports.length || /\bimport\.meta\b/.test(code)) return null;
                return { code: SELF_CONTAINED_WORKER + code, map: null };
            },
        },
    };
}
