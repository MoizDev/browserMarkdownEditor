import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

const VIRTUAL = 'virtual:pdfjs-classic-assets';
const RESOLVED = `\0${VIRTUAL}`;
const AUDITED_VERSION = '6.1.200';
const DIRECTORIES = ['wasm', 'cmaps', 'standard_fonts', 'iccs'] as const;
const REQUIRED = [
    'LICENSE', 'cmaps/LICENSE', 'iccs/LICENSE', 'standard_fonts/LICENSE_FOXIT',
    'standard_fonts/LICENSE_LIBERATION', 'wasm/LICENSE_JBIG2', 'wasm/LICENSE_OPENJPEG',
    'wasm/LICENSE_QCMS', 'wasm/LICENSE_PDFJS_JBIG2', 'wasm/LICENSE_PDFJS_OPENJPEG',
    'wasm/LICENSE_PDFJS_QCMS', 'wasm/openjpeg.wasm', 'wasm/jbig2.wasm', 'wasm/qcms_bg.wasm',
    'wasm/openjpeg_nowasm_fallback.js', 'wasm/jbig2_nowasm_fallback.js',
];
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

/** Emit unchanged, version-matched codec/font data without adding a single
 * runtime import/preload edge. pdf.js appends fixed names, so hash the directory
 * rather than renaming its children. QuickJS is not a renderer dependency. */
export function pdfClassicAssets(): Plugin {
    let config: ResolvedConfig;
    let packageRoot: string;
    let prefix: string;
    let manifest: { version: string; manifestHash: string; directories: Record<string, string>; files: Record<string, string> };
    let files: Array<{ name: string; source: Buffer }>;
    function collect() {
        const require = createRequire(join(config.root, 'package.json'));
        packageRoot = require.resolve('pdfjs-dist/package.json').replace(/[/\\]package\.json$/, '');
        const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
        const api = readFileSync(join(packageRoot, 'build/pdf.mjs'), 'utf8');
        const worker = readFileSync(join(packageRoot, 'build/pdf.worker.mjs'), 'utf8');
        const emittedWorker = readFileSync(join(packageRoot, 'build/pdf.worker.min.mjs'), 'utf8');
        const emphasis = readFileSync(join(config.root, 'src/utils/pdfNativeEmphasis.ts'), 'utf8');
        if (version !== AUDITED_VERSION
            || !api.includes(`const version = "${version}"`)
            || !api.includes(`apiVersion: "${version}"`)
            || !worker.includes(`const workerVersion = "${version}"`)
            || !emittedWorker.includes(`pdfjsVersion = ${version}`)
            || !emphasis.includes(`PDF_EMPHASIS_RENDERER_VERSION = '${version}'`)) {
            throw new Error('Classic PDF renderer/worker/assets/emphasis versions disagree; re-audit before upgrading.');
        }
        files = [];
        function walk(path: string) {
            for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
                const full = join(path, entry.name);
                if (entry.isSymbolicLink()) throw new Error('Classic PDF assets must not contain symlinks');
                if (entry.isDirectory()) walk(full);
                else if (!entry.name.startsWith('quickjs-eval.')) files.push({ name: relative(packageRoot, full).split(sep).join('/'), source: readFileSync(full) });
            }
        }
        for (const dir of DIRECTORIES) walk(join(packageRoot, dir));
        files.push({ name: 'LICENSE', source: readFileSync(join(packageRoot, 'LICENSE')) });
        files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        for (const name of REQUIRED) {
            if (!files.some(f => f.name === name && f.source.length > 0)) throw new Error(`Missing classic PDF runtime file/notice: ${name}`);
        }
        const fingerprint = createHash('sha256').update(`${version}\0`);
        for (const { name, source } of files) fingerprint.update(`${name}\0${source.length}\0`).update(source);
        const manifestHash = fingerprint.digest('hex');
        prefix = `pdfjs-runtime/${version}-${manifestHash.slice(0, 16)}/`;
        manifest = { version, manifestHash, directories: Object.fromEntries(DIRECTORIES.map(d => [d, `${prefix}${d}/`])), files: Object.fromEntries(files.map(f => [f.name, hash(f.source)])) };
    }
    return {
        name: 'classic-pdf-runtime-assets',
        configResolved(value) { config = value; collect(); },
        resolveId(id) { if (id === VIRTUAL) return RESOLVED; },
        load(id) { if (id === RESOLVED) return `export const classicAssets = ${JSON.stringify(manifest)};`; },
        generateBundle() {
            for (const file of files) {
                if (hash(readFileSync(join(packageRoot, file.name))) !== manifest.files[file.name]) throw new Error(`Classic PDF runtime changed during build: ${file.name}`);
                this.emitFile({ type: 'asset', fileName: `${prefix}${file.name}`, source: file.source });
            }
            this.emitFile({ type: 'asset', fileName: `${prefix}manifest.json`, source: `${JSON.stringify(manifest, null, 2)}\n` });
        },
        configureServer(server) {
            const byName = new Map(files.map(f => [`${prefix}${f.name}`, f.source]));
            byName.set(`${prefix}manifest.json`, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
            server.middlewares.use((req, res, next) => {
                const base = new URL(config.base, 'http://vite.local').pathname;
                const path = (req.url || '').split('?')[0];
                // Vite may already have stripped base before this middleware.
                const name = path.startsWith(base) ? path.slice(base.length) : path.replace(/^\//, '');
                const data = byName.get(name);
                if (!data) { next(); return; }
                res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.js') ? 'text/javascript' : name.endsWith('.json') ? 'application/json' : 'application/octet-stream');
                res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                res.end(data);
            });
        },
    };
}
