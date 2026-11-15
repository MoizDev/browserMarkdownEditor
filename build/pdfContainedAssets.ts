import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import type { Plugin } from 'vite';
import { bundleContainedRuntime } from '../src/platform/containedFrameBuild.mjs';

/** Generated in memory from fixed first-party sources, never a checked-in stale bootstrap. */
export function pdfContainedAssets(): Plugin {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const brokerId = '\0virtual:pdf-engine-broker', workerId = '\0virtual:pdf-engine-worker', metadataId = '\0virtual:pdf-engine-metadata';
    let broker: ReturnType<typeof bundleContainedRuntime> | undefined;
    let worker: ReturnType<typeof bundleContainedRuntime> | undefined;
    let metadata: Promise<{ source: string; sha256: string }> | undefined;
    const brokerBundle = () => broker ??= bundleContainedRuntime({ root, entry: 'src/pdf/contained/brokerRuntime.ts' });
    const workerBundle = () => worker ??= bundleContainedRuntime({ root, entry: 'src/pdf/worker/entry.ts' });
    const metadataBundle = () => metadata ??= build({ absWorkingDir: root, entryPoints: ['src/pdf/writing/metadataEntrypoint.ts'],
        bundle: true, format: 'esm', platform: 'browser', target: 'chrome120',
        tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } }, write: false, minify: true, legalComments: 'inline' }).then(result => {
        if (result.outputFiles.length !== 1) throw new Error('Invalid contained PDF metadata bundle');
        const source = result.outputFiles[0].text;
        return { source, sha256: createHash('sha256').update(source, 'utf8').digest('hex') };
    });
    return {
        name: 'contained-pdf-engine-assets',
        config(_config, env) {
            const pin = JSON.parse(readFileSync(new URL('../src/pdf/engine/dev/source-manifest.json', import.meta.url), 'utf8')) as {
                shippingAllowed?: boolean; qualification?: string;
            };
            return { define: { __BME_PDF_ENGINE_AVAILABLE__: JSON.stringify(env.command === 'serve' || env.mode === 'benchmark' ||
                (pin.shippingAllowed === true && pin.qualification !== 'development')) } };
        },
        resolveId(id) {
            if (id === 'virtual:pdf-engine-broker') return brokerId;
            if (id === 'virtual:pdf-engine-worker') return workerId;
            if (id === 'virtual:pdf-engine-metadata') return metadataId;
        },
        async load(id) {
            if (id === brokerId) {
                const { runtime, hash } = await brokerBundle();
                return `export const runtime=${JSON.stringify(runtime)}; export const hash=${JSON.stringify(hash)};`;
            }
            if (id === workerId) {
                const { runtime } = await workerBundle();
                return `export const source=${JSON.stringify(runtime)};`;
            }
            if (id === metadataId) {
                const { source, sha256 } = await metadataBundle();
                return `export const source=${JSON.stringify(source)}; export const sha256=${JSON.stringify(sha256)};`;
            }
        },
        buildStart() { broker = undefined; worker = undefined; metadata = undefined; },
        handleHotUpdate(context) {
            const path = context.file.replaceAll('\\', '/');
            if (path.includes('/src/pdf/') || path.includes('/src/utils/pdf') || path.includes('/src/platform/workers/') ||
                path.endsWith('/src/utils/readingEmphasis.ts') || path.endsWith('/src/utils/sha256.ts') ||
                path.endsWith('/src/platform/containedFrameBuild.mjs')) {
                broker = undefined; worker = undefined; metadata = undefined;
                for (const id of [brokerId, workerId, metadataId]) {
                    const module = context.server.moduleGraph.getModuleById(id);
                    if (module) context.server.moduleGraph.invalidateModule(module);
                }
            }
        },
    };
}
