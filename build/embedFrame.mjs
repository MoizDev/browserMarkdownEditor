import { resolve } from 'node:path';
import { bundleContainedRuntime } from '../src/platform/containedFrameBuild.mjs';

/** The virtual module contains only the fixed first-party bootstrap and its exact CSP hash. */
export function containedEmbedFrames(root) {
    const id = '\0virtual:contained-embed';
    const entry = 'src/platform/embedBootstrap.ts';
    const watched = new Set([
        resolve(root, entry), resolve(root, 'src/platform/embedPolicy.ts'),
        resolve(root, 'src/platform/containedFrameBuild.mjs'), resolve(root, 'build/embedFrame.mjs'),
    ]);
    return {
        name: 'contained-embed-frame',
        buildStart() { for (const file of watched) this.addWatchFile(file); },
        resolveId(source) { if (source === 'virtual:contained-embed') return id; },
        async load(source) {
            if (source !== id) return;
            const { runtime, hash, metafile } = await bundleContainedRuntime({ root, entry });
            for (const path of Object.keys(metafile.inputs)) {
                const file = resolve(root, path);
                watched.add(file); this.addWatchFile(file);
            }
            return `export const runtime = ${JSON.stringify(runtime)}; export const scriptHash = ${JSON.stringify(hash)};`;
        },
        handleHotUpdate(context) {
            if (!watched.has(resolve(context.file))) return;
            const module = context.server.moduleGraph.getModuleById(id);
            if (module) context.server.moduleGraph.invalidateModule(module);
            context.server.ws.send({ type: 'full-reload' });
            return [];
        },
    };
}
