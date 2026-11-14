// Browser-run support only: source identity, emitted maps and outside observations.
// No application module is imported or invoked by a gate.
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const TOOLBOX_COMMIT = '527faea';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
export function argumentsOf(argv, allowed, required = []) {
    const out = {};
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i]?.slice(2), value = argv[i + 1];
        if (!argv[i]?.startsWith('--') || !allowed.includes(key) || out[key] !== undefined || value === undefined || value.startsWith('--')) throw new Error(`Unknown, repeated or incomplete option: ${argv[i]}`);
        out[key] = value;
    }
    for (const key of required) if (!out[key]) throw new Error(`Required option: --${key}`);
    return out;
}
export function portNumber(value = '6384') {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || [5173, 5199].includes(port)) throw new Error('Use an explicitly assigned private port');
    return port;
}
export async function toolbox(directory) {
    const base = resolve(directory ?? join(ROOT, 'verify/lib'));
    const names = ['identity', 'report', 'counters', 'vault', 'serve'];
    const metadata = { commit: git(ROOT, 'rev-parse', TOOLBOX_COMMIT), directory: base, files: [] };
    const modules = {};
    for (const name of names) {
        const file = join(base, `${name}.mjs`), bytes = await readFile(file);
        // Until the domain merge, p-lead authorizes only this exact, unmodified
        // scratch export. Its dependencies remain relative to that same export.
        const expected = execFileSync('git', ['show', `${TOOLBOX_COMMIT}:verify/lib/${name}.mjs`], { cwd: ROOT });
        if (!bytes.equals(expected)) throw new Error(`Toolbox export differs from ${TOOLBOX_COMMIT}: ${name}`);
        metadata.files.push({ path: `verify/lib/${name}.mjs`, sha256: sha256(bytes), bytes: bytes.length });
        Object.assign(modules, await import(pathToFileURL(file).href));
    }
    return { ...modules, metadata };
}
export async function command(program, args, cwd) {
    const child = spawn(program, args, { cwd, stdio: 'inherit' });
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    if (result.code !== 0) throw new Error(`Command failed: ${program} ${args.join(' ')} (${result.code ?? result.signal})`);
}
export async function exists(path) { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
export function replaceExactly(source, before, after) {
    if (source.split(before).length !== 2) throw new Error(`Mutant/hold anchor is absent or ambiguous: ${before.slice(0, 100)}`);
    return source.replace(before, after);
}
export function workSite(source) {
    const lines = source.split('\n');
    const start = lines.findIndex(line => line.includes("const work = document.createElement('canvas');"));
    const end = lines.findIndex((line, index) => index >= start && line.includes("const ctx = work.getContext('2d');"));
    if (start < 0 || end < start || end - start > 10) throw new Error('The displayed render-work context cannot be attributed');
    return { source: 'src/components/PdfViewer.tsx', firstLine: start + 1, lastLine: end + 1 };
}

/** Stack attribution is functional-only observation. Source maps identify the
 * existing getContext caller; they never execute/import source in the page. */
export async function attributeCanvases(snapshot, prepared, origin) {
    const maps = new Map(), sourceSite = prepared.workSite;
    const roleAt = async stack => {
        for (const line of (stack ?? '').split('\n')) {
            const match = line.match(/(https?:\/\/[^\s)]+):(\d+):(\d+)/u);
            if (!match || new URL(match[1]).origin !== origin) continue;
            const path = decodeURIComponent(new URL(match[1]).pathname).slice(1);
            let map = maps.get(path);
            if (map === undefined) {
                const file = prepared.identity.files.find(file => file.path === `${path}.map`);
                if (!file) { maps.set(path, null); continue; }
                const bytes = await readFile(join(prepared.distDir, file.path));
                if (sha256(bytes) !== file.sha256) throw new Error('Source map does not match its prepared artifact');
                map = new TraceMap(JSON.parse(bytes)); maps.set(path, map);
            }
            if (!map) continue;
            const position = originalPositionFor(map, { line: Number(match[2]), column: Number(match[3]) - 1 });
            if (!position.source) continue;
            const source = position.source.replaceAll('\\', '/');
            if (source.endsWith(sourceSite.source) && position.line >= sourceSite.firstLine && position.line <= sourceSite.lastLine) return { role: 'work', ...position };
            if (source.includes('/pdfNativeEmphasis')) return { role: 'probe', ...position };
            // The closest mapped frame owns the context. Looking farther up
            // would mislabel a probe called by renderLoop as a work canvas.
            return { role: 'other', ...position };
        }
        return { role: 'unattributed' };
    };
    const canvases = [];
    for (const canvas of snapshot.canvases) canvases.push({ ...canvas, attribution: await roleAt(canvas.stack) });
    return { ...snapshot, canvases };
}
export async function waitForCanvasIdle(page, prepared, origin, timeoutMs = 30000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        const snapshot = await attributeCanvases(await page.evaluate(() => window.__d1Outside.snapshot()), prepared, origin);
        const ids = snapshot.canvases.filter(canvas => ['work', 'probe'].includes(canvas.attribution.role)).map(canvas => canvas.id);
        const quiet = await page.evaluate(ids => new Promise(resolve => {
            const start = window.__d1Outside.activity();
            let frames = 0;
            const frame = () => {
                const current = window.__d1Outside.activity();
                if (current.nextCanvas !== start.nextCanvas) { resolve(false); return; }
                const busy = current.canvases.some(canvas => ids.includes(canvas.id) && canvas.width * canvas.height > 0);
                if (busy) { resolve(false); return; }
                if (++frames === 3) { resolve(true); return; }
                requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
        }), ids);
        if (quiet) return snapshot;
        // Browser state, not a fixed warm-up delay: a new allocation forces a
        // new map attribution before another three-frame quiescence attempt.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    }
    const snapshot = await attributeCanvases(await page.evaluate(() => window.__d1Outside.snapshot()), prepared, origin);
    const bytes = snapshot.canvases.filter(canvas => ['work', 'probe'].includes(canvas.attribution.role)).reduce((n, canvas) => n + canvas.width * canvas.height * 4, 0);
    const error = new Error(`Render/probe canvases did not quiesce: ${bytes} backing bytes remain`);
    error.name = 'CanvasIdleTimeout';
    throw error;
}
export async function publicGeometry(page, index = 0) {
    return page.evaluate(index => {
        const box = document.querySelectorAll('.pdf-viewer-page')[index], canvas = box?.querySelector('canvas'), scroll = document.querySelector('.pdf-viewer-scroll');
        if (!box || !canvas || !scroll) throw new Error('Reader geometry is absent');
        const p = box.getBoundingClientRect(), c = canvas.getBoundingClientRect(), v = scroll.getBoundingClientRect();
        const x = Math.max(0, v.left + scroll.clientLeft - p.left), y = Math.max(0, v.top + scroll.clientTop - p.top);
        return { page: { width: p.width, height: p.height }, canvas: { x: c.left - p.left, y: c.top - p.top, w: c.width, h: c.height },
            need: { x, y, w: Math.max(0, Math.min(p.width, x + scroll.clientWidth) - x), h: Math.max(0, Math.min(p.height, y + scroll.clientHeight) - y) },
            band: Boolean(canvas.style.width), dpr: devicePixelRatio, scrollTop: scroll.scrollTop, scrollLeft: scroll.scrollLeft,
            zoom: document.querySelector('.pdf-viewer-zoom [aria-label="Reset zoom"]')?.textContent };
    }, index);
}
export function observedTrigger({ page, canvas: rect, need }) {
    // Public painted-band bounds plus the visible intersection recover the
    // half-margin contract, independently of the app's target/predicate module.
    const left = rect.x <= 0.5 ? rect.x : (rect.x + need.x) / 2;
    const top = rect.y <= 0.5 ? rect.y : (rect.y + need.y) / 2;
    const right = rect.x + rect.w >= page.width - 0.5 ? rect.x + rect.w : (rect.x + rect.w + need.x + need.w) / 2;
    const bottom = rect.y + rect.h >= page.height - 0.5 ? rect.y + rect.h : (rect.y + rect.h + need.y + need.h) / 2;
    return { x: left, y: top, w: right - left, h: bottom - top };
}
export function covers(rect, need) {
    return need.x >= rect.x - 0.5 && need.y >= rect.y - 0.5 && need.x + need.w <= rect.x + rect.w + 0.5 && need.y + need.h <= rect.y + rect.h + 0.5;
}
export async function canvasFingerprint(page, index = 0) {
    return page.evaluate(async index => {
        const box = document.querySelectorAll('.pdf-viewer-page')[index], canvas = box?.querySelector('canvas');
        if (!canvas || !canvas.isConnected || !canvas.width || !canvas.height) return { painted: false };
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(n => n.toString(16).padStart(2, '0')).join('');
        let darkPixels = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] < 150 && data[i + 1] < 150 && data[i + 2] < 150 && data[i + 3] > 0) darkPixels++;
        const r = canvas.getBoundingClientRect(), p = box.getBoundingClientRect();
        return { painted: darkPixels > 0, sha256: hash, width: canvas.width, height: canvas.height, darkPixels,
            css: { x: r.left - p.left, y: r.top - p.top, width: r.width, height: r.height },
            page: { width: p.width, height: p.height }, dpr: devicePixelRatio, emphasis: canvas.dataset.nativeEmphasis,
            visibility: getComputedStyle(canvas).visibility };
    }, index);
}
