import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { bundleContainedRuntime } from '../src/platform/containedFrameBuild.mjs';

/** Generated in memory from fixed first-party sources, never a checked-in stale bootstrap. */
export function pdfContainedAssets(): Plugin {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const brokerId = '\0virtual:pdf-engine-broker', workerId = '\0virtual:pdf-engine-worker';
    let broker: ReturnType<typeof bundleContainedRuntime> | undefined;
    let worker: ReturnType<typeof bundleContainedRuntime> | undefined;
    const brokerBundle = () => broker ??= bundleContainedRuntime({ root, entry: 'src/pdf/contained/brokerRuntime.ts' });
    const workerBundle = () => worker ??= bundleContainedRuntime({ root, entry: 'src/pdf/worker/entry.ts' });
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
        },
        buildStart() { broker = undefined; worker = undefined; },
        handleHotUpdate(context) {
            const path = context.file.replaceAll('\\', '/');
            if (path.includes('/src/pdf/') || path.includes('/src/platform/workers/') ||
                path.endsWith('/src/utils/readingEmphasis.ts') || path.endsWith('/src/utils/sha256.ts') ||
                path.endsWith('/src/platform/containedFrameBuild.mjs')) {
                broker = undefined; worker = undefined;
                for (const id of [brokerId, workerId]) {
                    const module = context.server.moduleGraph.getModuleById(id);
                    if (module) context.server.moduleGraph.invalidateModule(module);
                }
            }
        },
    };
}
