import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePaths = ['src', 'shared', 'helper', 'public', 'config', 'configs', 'index.html', 'package.json', 'package-lock.json',
    'vite.config.ts', 'eslint.config.ts', 'eslint.rules.ts', ':(glob)*.config.*', ':(glob)tsconfig*.json',
    ':(glob).env*', ':(glob).babelrc*', ':(glob).postcssrc*'];

/** Verification identity (verification.md:77–89, VER-06/10/13), not an app hook.
 * treeClean excludes run scripts/docs, but includes untracked source and configs.
 * @param {{worktree: string, distDir?: string, patch?: string | Uint8Array | object}} options
 */
export async function buildIdentity({ worktree, distDir, patch }) {
    worktree = resolve(worktree);
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
    const treeClean = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', ...sourcePaths], { cwd: worktree, encoding: 'utf8' }).length === 0;
    const files = [];
    const walk = async (directory, prefix = '') => {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
            const path = `${prefix}${entry.name}`;
            if (entry.isDirectory()) await walk(join(directory, entry.name), `${path}/`);
            else {
                if (!entry.isFile()) throw new Error(`Emitted build contains a non-file: ${path}`);
                const bytes = await readFile(join(directory, entry.name));
                files.push({ path, sha256: sha256(bytes), bytes: bytes.length });
            }
        }
    };
    if (distDir) await walk(resolve(distDir));
    const patchSha256 = patch === undefined ? null : sha256(typeof patch === 'object' && !(patch instanceof Uint8Array) ? JSON.stringify(patch) : patch);
    const identity = { commit, treeClean, patchSha256, files };
    return { ...identity, manifestSha256: sha256(JSON.stringify(identity)) };
}

/** p-d measured response.body() re-encoding CSS fetched by fetch(), but not the
 * same CSS loaded as a stylesheet (CfT157: 110219→110223 bytes). Thus functional
 * binding uses raw APIResponse bytes; timing never intercepts/disables the cache.
 * Attach before goto; await check before EVERY assertion and before finishing.
 * @param {import('playwright').BrowserContext} context
 * @param {{identity: Awaited<ReturnType<typeof buildIdentity>>, origin: string,
 *   mode?: 'raw-route'|'node-refetch', buildMode?: 'dev'|'production'|'benchmark',
 *   report?: {data: object}, blockExternalOrigins?: string[],
 *   moduleOverrides?: {name: string, pattern: RegExp, body: string, contentType: string, onServe?: Function}[]}} options
 */
export async function bindServedBodies(context, { identity, origin, mode = 'raw-route', buildMode = 'production', report, blockExternalOrigins = [], moduleOverrides = [] }) {
    origin = new URL(origin).origin;
    if (!['raw-route', 'node-refetch'].includes(mode)) throw new Error(`Unknown binding mode: ${mode}`);
    if (!['dev', 'production', 'benchmark'].includes(buildMode)) throw new Error(`Unknown build mode: ${buildMode}`);
    if (mode === 'node-refetch' && buildMode === 'dev') throw new Error('Timed node-refetch binding requires an emitted build');
    blockExternalOrigins = blockExternalOrigins.map(value => new URL(value).origin);
    if (blockExternalOrigins.includes(origin)) throw new Error('External-origin blocking must not suppress the app origin');
    if (mode === 'node-refetch' && blockExternalOrigins.length) throw new Error('Timed binding must never install an interception route');
    if (moduleOverrides.length && (mode !== 'raw-route' || buildMode !== 'dev')) throw new Error('Declared module overrides are dev-only; production bytes must match emitted files');
    const expected = new Map(identity.files.map(file => [file.path, file]));
    const pending = new Set(), modules = [], browserUrls = [], foreign = [], faults = [], blocked = [];
    const urlsToRefetch = new Map(), refetched = new Set(), rawBound = new WeakSet(), foreignRequests = new WeakMap();
    const isCode = (request, headers = {}) => ['script', 'stylesheet'].includes(request.resourceType()) ||
        /\.(?:m?js|css|wasm)(?:\?|$)/i.test(request.url()) || /(?:javascript|text\/css|application\/wasm)/i.test(headers['content-type'] ?? '');
    const fault = (url, message) => { faults.push({ url, name: 'HarnessFault', message }); };
    const bind = (url, type, status, bytes) => {
        const parsed = new URL(url), path = decodeURIComponent(parsed.pathname).replace(/^\//, '');
        if (parsed.origin !== origin || !path || path.split('/').some(part => part === '..' || part.includes('\\'))) {
            fault(url, 'Unsafe served build path'); return;
        }
        const actual = { url, path, type, status, sha256: sha256(bytes), bytes: bytes.length };
        modules.push(actual);
        if (status < 200 || status >= 300) fault(url, `Served code response has status ${status}`);
        if (buildMode === 'dev') return;
        const emitted = expected.get(path);
        if (!emitted) { fault(url, `No emitted file matches served code: ${path}`); return; }
        if (actual.sha256 !== emitted.sha256 || actual.bytes !== emitted.bytes) {
            fault(url, `Served body differs from emitted file ${path}: expected ${emitted.sha256}/${emitted.bytes}, got ${actual.sha256}/${actual.bytes}`);
        }
    };
    const requestListener = request => {
        if (new URL(request.url()).origin === origin) return;
        const row = { url: request.url(), origin: new URL(request.url()).origin, type: request.resourceType(), status: null, sha256: null };
        foreign.push(row); foreignRequests.set(request, row);
    };
    const responseListener = response => {
        const request = response.request(), url = response.url();
        if (new URL(url).origin === origin) {
            if (!isCode(request, response.headers())) return;
            browserUrls.push({ url, type: request.resourceType(), status: response.status() });
            if (mode === 'raw-route' && !rawBound.has(request)) fault(url, 'Code response bypassed raw-byte binding (another route fulfilled it)');
            if (mode === 'node-refetch') urlsToRefetch.set(url, request.resourceType());
            return;
        }
        const task = (async () => {
            const row = foreignRequests.get(request) ?? { url, origin: new URL(url).origin, type: request.resourceType(), status: null, sha256: null };
            if (!foreignRequests.has(request)) foreign.push(row);
            row.status = response.status();
            try { const bytes = await response.body(); row.sha256 = sha256(bytes); row.bytes = bytes.length; }
            catch (error) { row.bodyError = error.message; }
        })().catch(error => fault(url, error.message)).finally(() => pending.delete(task));
        pending.add(task);
    };
    const failedListener = request => {
        const row = foreignRequests.get(request);
        if (row) { row.failure = request.failure()?.errorText ?? 'failed'; return; }
        if (isCode(request) && new URL(request.url()).origin === origin) fault(request.url(), `Code request failed: ${request.failure()?.errorText}`);
    };
    const routeListener = async route => {
        const request = route.request(), url = request.url(), requestOrigin = new URL(url).origin;
        if (blockExternalOrigins.includes(requestOrigin)) {
            blocked.push({ url, origin: requestOrigin, type: request.resourceType() });
            await route.abort('blockedbyclient'); return;
        }
        if (mode !== 'raw-route' || requestOrigin !== origin) { await route.fallback(); return; }
        const task = (async () => {
            // Raw-route is deliberately uncached. A conditional 304 has no body
            // to bind, so send unconditional requests in this functional arm.
            const override = moduleOverrides.find(override => override.pattern.test(url));
            if (override) {
                bind(url, request.resourceType(), 200, Buffer.from(override.body));
                rawBound.add(request);
                override.onServe?.();
                await route.fulfill({ status: 200, contentType: override.contentType, body: override.body });
                return;
            }
            const headers = { ...request.headers() };
            delete headers['if-none-match']; delete headers['if-modified-since'];
            const response = await route.fetch({ headers });
            try {
                if (isCode(request, response.headers())) {
                    bind(url, request.resourceType(), response.status(), await response.body());
                    rawBound.add(request);
                }
                await route.fulfill({ response });
            } finally { await response.dispose(); }
        })().catch(async error => {
            fault(url, error.message);
            try { await route.abort(); } catch { /* a failed fulfil may already own the route */ }
        }).finally(() => pending.delete(task));
        pending.add(task);
        await task;
    };
    const intercepted = mode === 'raw-route' || blockExternalOrigins.length > 0;
    if (intercepted) await context.route('**/*', routeListener);
    context.on('request', requestListener); context.on('response', responseListener); context.on('requestfailed', failedListener);
    const snapshot = () => ({ mode, buildMode, origin, intercepted, httpCacheDisabled: intercepted,
        buildManifestSha256: identity.manifestSha256, modules: structuredClone(modules), browserUrls: structuredClone(browserUrls),
        servedManifestSha256: sha256(JSON.stringify(modules)), foreign: structuredClone(foreign), faults: structuredClone(faults),
        blockExternalOrigins, blocked: structuredClone(blocked),
        moduleOverrides: moduleOverrides.map(override => ({ name: override.name, pattern: override.pattern.source, sha256: sha256(override.body) })),
        loss: mode === 'node-refetch' ? 'Server bytes plus browser URL list, not the browser cached body; refetch only at check(), outside the timed action' : 'Interception disables the HTTP cache; not a timing arm' });
    return {
        async check() {
            while (pending.size) await Promise.all([...pending]);
            if (mode === 'node-refetch') {
                // Defer refetches until the caller's assertion boundary, never
                // add network work to the action whose duration is being timed.
                for (const [url, type] of urlsToRefetch) {
                    if (refetched.has(url)) continue;
                    refetched.add(url);
                    try {
                        const response = await fetch(url, { signal: AbortSignal.timeout(30000), cache: 'no-store' });
                        bind(url, type, response.status, Buffer.from(await response.arrayBuffer()));
                    } catch (error) { fault(url, `Node body refetch failed: ${error.message}`); }
                }
                while (pending.size) await Promise.all([...pending]);
            }
            const result = snapshot();
            if (report) report.data.servedBinding = result;
            if (faults.length || modules.length === 0) {
                const error = new Error(`Served-build binding failed: ${faults.length ? faults.map(fault => fault.message).join('; ') : 'no same-origin modules observed; attach before goto'}`);
                error.name = 'HarnessFault';
                throw error;
            }
            return result;
        },
        async stop() {
            context.off('request', requestListener); context.off('response', responseListener); context.off('requestfailed', failedListener);
            if (intercepted) await context.unroute('**/*', routeListener);
        },
    };
}
