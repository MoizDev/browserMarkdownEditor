import { bundleContainedRuntime } from '../src/platform/containedFrameBuild.mjs';

export function whiteboardSvgFrames(root) {
    const id = '\0virtual:whiteboard-svg-frames';
    return {
        name: 'whiteboard-svg-frames',
        resolveId(source) { if (source === 'virtual:whiteboard-svg-frames') return id; },
        async load(source) {
            if (source !== id) return;
            const make = async (entry, image) => {
                const { runtime, hash, metafile } = await bundleContainedRuntime({ root, entry });
                for (const path of Object.keys(metafile.inputs)) this.addWatchFile(`${root}/${path}`);
                const csp = `default-src 'none'; script-src 'sha256-${hash}'; script-src-attr 'none'; connect-src 'none'; img-src ${image ? 'blob:' : "'none'"}; media-src 'none'; font-src 'none'; style-src 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`;
                return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script>${runtime}</script></body></html>`;
            };
            const xml = await make('src/whiteboard/media/svgXmlEntry.ts', false);
            const image = await make('src/whiteboard/media/svgImageEntry.ts', true);
            return `export const svgXmlFrame = ${JSON.stringify(xml)}; export const svgImageFrame = ${JSON.stringify(image)};`;
        },
    };
}
