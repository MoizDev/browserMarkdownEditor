import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { PDF_FONT_CATALOGUE } from '../src/pdf/fonts/catalogue';

const root = fileURLToPath(new URL('../', import.meta.url));
const licences = {
    sans: { file: 'noto-sans-OFL.txt', sha256: '0dab92d0544f7b233403f14b84a663bdbfa746982eda629e7f4f9ffe1b036feb' },
    cjk: { file: 'noto-cjk-OFL.txt', sha256: '6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2' },
} as const;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const assetDir = () => resolve(root, process.env.BME_PDF_FONT_DIR || 'vendor/pdf-fonts');

/** Only pinned filenames can be requested; never expose the supply directory itself. */
export function pdfFontAssets(): Plugin {
    let emit = false;
    return {
        name: 'pdf-font-assets',
        config(_config, env) {
            const pin = JSON.parse(readFileSync(new URL('../src/pdf/engine/dev/source-manifest.json', import.meta.url), 'utf8')) as {
                shippingAllowed?: boolean; qualification?: string;
            };
            emit = env.command === 'build' && (env.mode === 'benchmark' || (pin.shippingAllowed === true && pin.qualification !== 'development'));
        },
        configResolved(config) {
            // Vite copies public files without plugin inspection, bypassing the pin.
            if (config.publicDir && existsSync(resolve(config.publicDir, 'pdf-fonts'))) {
                throw new Error('PDF fonts must be supplied outside Vite publicDir');
            }
        },
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const path = (req.url ?? '').split('?')[0];
                const prefix = '/pdf-fonts/';
                const basePrefix = `${server.config.base.replace(/\/$/, '')}${prefix}`;
                const name = path.startsWith(basePrefix) ? path.slice(basePrefix.length) : path.startsWith(prefix) ? path.slice(prefix.length) : null;
                if (name === null) return next();
                if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return; }
                const pin = Object.values(PDF_FONT_CATALOGUE).find(asset => basename(asset.path) === name);
                if (!pin) { res.statusCode = 404; res.end(); return; }
                try {
                    const bytes = readFileSync(resolve(assetDir(), name));
                    if (bytes.length !== pin.bytes || digest(bytes) !== pin.sha256) throw new Error('font integrity mismatch');
                    res.setHeader('Content-Type', name.endsWith('.otf') ? 'font/otf' : 'font/ttf');
                    res.setHeader('Content-Length', bytes.length);
                    res.setHeader('Cache-Control', 'no-store');
                    res.setHeader('X-Content-Type-Options', 'nosniff');
                    res.end(req.method === 'HEAD' ? undefined : bytes);
                } catch { res.statusCode = 404; res.end(); }
            });
        },
        generateBundle() {
            if (!emit) return;
            const directory = assetDir();
            const texts = Object.fromEntries(Object.entries(licences).map(([key, pin]) => {
                const data = readFileSync(resolve(directory, pin.file));
                if (digest(data) !== pin.sha256) throw new Error(`PDF font licence integrity mismatch: ${pin.file}`);
                return [key, data.toString('utf8')];
            })) as Record<keyof typeof licences, string>;
            const notices: string[] = [];
            for (const [id, pin] of Object.entries(PDF_FONT_CATALOGUE)) {
                const filename = basename(pin.path), data = readFileSync(resolve(directory, filename));
                if (data.length !== pin.bytes || digest(data) !== pin.sha256) throw new Error(`PDF font integrity mismatch: ${filename}`);
                const sans = id.startsWith('sans-');
                const copyright = sans ? `Copyright 2015-${id.includes('italic') ? '2022' : '2021'} Google LLC. All Rights Reserved.` : '© 2014-2021 Adobe (http://www.adobe.com/).';
                notices.push(`${filename}\n${copyright}\n`);
                this.emitFile({ type: 'asset', fileName: pin.path, source: data });
            }
            this.emitFile({ type: 'asset', fileName: 'pdf-fonts/NOTICES.txt', source: `${notices.join('\n')}\n${texts.sans}\n\n${texts.cjk}\n` });
        },
    };
}
