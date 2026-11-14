/** Regenerate the fixed opaque bootstrap after runtime/core/vendor changes.
 * Vite runs this before dev/build; node may also regenerate it standalone.
 * CSP hashes the exact inline IIFE, not its source or pre-minification bytes.
 */
import { version } from 'esbuild';
import { bundleContainedRuntime, sha256Hex } from '../platform/containedFrameBuild.mjs';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
// A failed generation must never leave a usable old bootstrap behind.
await Promise.all(['reader-frame.html','reader-frame.integrity.json'].map(name=>rm(new URL(name,import.meta.url),{force:true})));
const {runtime,hash,metafile}=await bundleContainedRuntime({root,entry:'src/epub/readerRuntime.ts'});
const css=await readFile(new URL('./frame.css',import.meta.url),'utf8');
const csp=`default-src 'none'; script-src 'sha256-${hash}'; script-src-attr 'none'; connect-src 'none'; style-src 'unsafe-inline'; img-src blob:; font-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; media-src 'none'`;
const frame=`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><main id="surface" tabindex="0" aria-label="Book reading area"></main><div id="notice" role="status" aria-live="polite"></div><script>${runtime}</script></body></html>`;
const inputs={};for(const path of [...Object.keys(metafile.inputs),'src/epub/frame.css','src/epub/build-frame.mjs','src/platform/containedFrameBuild.mjs'].sort()){inputs[path]=sha256Hex(await readFile(new URL(path,new URL('../../',import.meta.url))))}
try {
 await writeFile(new URL('./reader-frame.html',import.meta.url),frame);
 await writeFile(new URL('./reader-frame.integrity.json',import.meta.url),JSON.stringify({schema:1,buildTool:'esbuild '+version,runtimeSHA256Base64:hash,frameSHA256:sha256Hex(frame),inputs},null,2)+'\n');
} catch (error) {
 await Promise.all(['reader-frame.html','reader-frame.integrity.json'].map(name=>rm(new URL(name,import.meta.url),{force:true})));
 throw error;
}
console.log(JSON.stringify({runtimeSHA256:hash,bytes:Buffer.byteLength(runtime),frame:'src/epub/reader-frame.html'}));
