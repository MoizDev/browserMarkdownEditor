import type { Plugin } from 'vite';
import { SELF_CONTAINED_WORKER, SELF_CONTAINED_WORKER_END } from '../src/platform/workers/scriptMarker';

const NEEDS_OWN_URL = /\bimport\.meta\b|\blocation\b|\bfetch\s*\(|\bimportScripts\b|\bnew\s+(?:Shared)?Worker\b/;

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
