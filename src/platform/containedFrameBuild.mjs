/** Neutral build primitives for fixed, first-party opaque-frame bootstraps. */
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

export function sha256Hex(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

export function hashInlineScript(runtime) {
    if (typeof runtime !== 'string' || /<\/script/i.test(runtime)) {
        throw new Error('Invalid contained-frame inline script');
    }
    return createHash('sha256').update(runtime, 'utf8').digest('base64');
}

/** The caller owns its CSP, generated output lifecycle and integrity inventory. */
export async function bundleContainedRuntime({ root, entry }) {
    const result = await build({
        absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'iife', platform: 'browser',
        target: 'chrome120', tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } },
        write: false, metafile: true, minify: true, legalComments: 'inline',
    });
    if (result.outputFiles.length !== 1 || !result.metafile) throw new Error('Invalid contained-frame bundle');
    const runtime = result.outputFiles[0].text;
    return { runtime, hash: hashInlineScript(runtime), metafile: result.metafile };
}
