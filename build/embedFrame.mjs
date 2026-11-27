import { resolve } from 'node:path';
import { bundleContainedRuntime } from '../src/platform/containedFrameBuild.mjs';

export function containedEmbedFrames(root) {
    const id = '\0virtual:contained-embed';
    const entry = 'src/platform/embedBootstrap.ts';
    const watched = new Set([
        resolve(root, entry), resolve(root, 'src/platform/embedPolicy.ts'),
        resolve(root, 'src/platform/containedFrameBuild.mjs'), resolve(root, 'build/embedFrame.mjs'),
    ]);
    let cached;
    const bundle = context => {
        if (!cached) {
            const pending = bundleContainedRuntime({ root, entry }).then(result => {
                for (const path of Object.keys(result.metafile.inputs)) {
                    const file = resolve(root, path);
                    watched.add(file); context.addWatchFile(file);
                }
                return result;
            }).catch(error => { if (cached === pending) cached = undefined; throw error; });
            cached = pending;
        }
        return cached;
    };
    return {
        name: 'contained-embed-frame',
        async buildStart() { for (const file of watched) this.addWatchFile(file); await bundle(this); },
        watchChange(file) { if (watched.has(resolve(file))) cached = undefined; },
        resolveId(source) { if (source === 'virtual:contained-embed') return id; },
        async load(source) {
            if (source !== id) return;
            const { runtime, hash } = await bundle(this);
            return `export const runtime = ${JSON.stringify(runtime)}; export const scriptHash = ${JSON.stringify(hash)};`;
        },
        async handleHotUpdate(context) {
            if (!watched.has(resolve(context.file))) return;
            cached = undefined;
            await bundle(this);
            const module = context.server.moduleGraph.getModuleById(id);
            if (module) context.server.moduleGraph.invalidateModule(module);
            context.server.ws.send({ type: 'full-reload' });
            return [];
        },
    };
}
