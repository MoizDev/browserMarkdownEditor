import { readCounters } from './counters.mjs';

async function beforeDeadline(promise, deadline, message) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), Math.max(0, deadline - performance.now()));
        })]);
    } finally { clearTimeout(timer); }
}

async function completedCloses(page, { name, path, count, timeoutMs = 10000, intervalMs = 50, report }) {
    checkedPath(path);
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000 || !Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('Invalid completed-close wait bound');
    const started = performance.now(), deadline = started + timeoutMs;
    const observation = { vault: name, path, expected: count, observed: null, timeoutMs, startedAt: new Date().toISOString(), polls: 0, passed: false };
    const waits = report.data.completedCloseWaits ??= [];
    waits.push(observation);
    try {
        while (performance.now() < deadline) {
            observation.polls++;
            const snapshot = await beforeDeadline(readCounters(page), deadline, 'Completed-close counters exceeded their deadline');
            if (snapshot.vaultName !== name) throw new Error('afterCompletedCloses requires installCounters(context,{vaultName:name})');
            observation.observed = snapshot.records.filter(record => record.op === 'close' && record.ok && record.vault === name && record.path === path).length;
            if (observation.observed >= count && performance.now() <= deadline) { observation.passed = true; return; }
            await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(intervalMs, deadline - performance.now()))));
        }
        throw new Error('Completed-close count did not reach its target');
    } catch (error) {
        observation.error = error.message;
        const fault = new Error(`Completed-close wait harness fault for ${path}: expected ${count}, observed ${observation.observed}; ${error.message}`, { cause: error });
        fault.name = 'HarnessFault';
        throw fault;
    } finally { observation.elapsedMs = performance.now() - started; }
}

/** Install before creating a page. Restored handles need prototype grants too.
 * @param {import('playwright').BrowserContext} context
 * @param {{name: string}} options
 */
export async function installVault(context, { name }) {
    if (!name || /[/\\]/.test(name)) throw new Error('The OPFS vault needs one nonempty folder name');
    await context.addInitScript(({ name }) => {
        // The picker belongs to the host, never the opaque reader/engine realm.
        if (window !== window.top) return;
        let storage;
        try { storage = navigator.storage; } catch { return; }
        if (typeof FileSystemHandle !== 'function' || typeof FileSystemDirectoryHandle !== 'function' ||
            typeof storage?.getDirectory !== 'function') return;
        const grant = handle => {
            handle.queryPermission = async () => 'granted';
            handle.requestPermission = async () => 'granted';
            return handle;
        };
        FileSystemHandle.prototype.queryPermission = async () => 'granted';
        FileSystemHandle.prototype.requestPermission = async () => 'granted';
        const getDir = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
        FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) {
            return grant(await getDir.apply(this, args));
        };
        window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true }));
    }, { name });
}

function checkedPath(path) {
    const parts = path.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error(`Not a vault-relative path: ${path}`);
    return parts;
}

/** Seed after goto, before Open Vault. Text or bytes; binary never travels as text.
 * @param {import('playwright').Page} page
 * @param {{name: string, files: Record<string, string | Uint8Array>}} options
 */
export async function seedVault(page, { name, files }) {
    const entries = Object.entries(files).map(([path, data]) => ({ parts: checkedPath(path),
        bytes: [...(typeof data === 'string' ? new TextEncoder().encode(data) : data)] }));
    await page.evaluate(async ({ name, entries }) => {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
        for (const { parts, bytes } of entries) {
            let dir = root;
            for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
            const file = await dir.getFileHandle(parts.at(-1), { create: true });
            const writable = await file.createWritable();
            await writable.write(new Uint8Array(bytes));
            await writable.close();
        }
    }, { name, entries });
}

/** Fresh handles, outside the app's filesystem path. Reads are visible to window counters.
 * @param {import('playwright').Page} page
 * @param {{name: string, path: string, binary?: boolean}} options
 * @returns {Promise<string | Buffer>}
 */
export async function readVaultFile(page, { name, path, binary = false }) {
    const result = await page.evaluate(async ({ name, parts }) => {
        try {
            let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
            for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
            return { bytes: [...new Uint8Array(await (await (await dir.getFileHandle(parts.at(-1))).getFile()).arrayBuffer())] };
        } catch (error) {
            // Driver error serialization can erase DOMException.name. Preserve only the
            // one transient lock failure; every other exception fails immediately.
            if (error.name === 'NotReadableError') return { unreadable: error.message };
            throw error;
        }
    }, { name, parts: checkedPath(path) });
    if ('unreadable' in result) {
        const error = new Error(result.unreadable);
        error.name = 'NotReadableError';
        throw error;
    }
    return binary ? Buffer.from(result.bytes) : new TextDecoder().decode(new Uint8Array(result.bytes));
}

/** Fresh-handle outside witness. Default bound: 20 attempts, 19 × 25 ms delays.
 * Retries only NotReadableError, never a missing file, and never returns stale bytes.
 * report is required so a transient lock cannot disappear from the run's evidence.
 * @param {import('playwright').Page} page
 * @param {{name: string, path: string, binary?: boolean, attempts?: number, delayMs?: number,
 *   afterCompletedCloses?: {path: string, count: number, timeoutMs?: number, intervalMs?: number},
 *   report: Awaited<ReturnType<typeof import('./report.mjs').createReport>>}} options
 * @returns {Promise<string | Buffer>}
 */
export async function readWitness(page, { name, path, binary = false, attempts = 20, delayMs = 25, report, afterCompletedCloses }) {
    if (!report?.data) throw new Error('readWitness requires the run report for retry attribution');
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 100 || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > 1000) {
        throw new Error('Witness bound must be 1–100 attempts with 0–1000 ms delay');
    }
    // NotFoundError can mean a real deletion. Synchronize on completed writes
    // when requested (core's measured swap race), NEVER retry a missing entry.
    if (afterCompletedCloses) await completedCloses(page, { ...afterCompletedCloses, name, report });
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try { return await readVaultFile(page, { name, path, binary }); }
        catch (error) {
            if (error.name !== 'NotReadableError') throw error;
            const exhausted = attempt === attempts;
            const retries = report.data.witnessRetries ??= [];
            retries.push({ vault: name, path, attempt, attempts,
                time: new Date().toISOString(), error: error.name, delayMs: exhausted ? 0 : delayMs, exhausted });
            if (exhausted) {
                const fault = new Error(`OPFS witness unreadable after ${attempts} fresh-handle attempts: ${name}/${path}`, { cause: error });
                fault.name = 'HarnessFault';
                throw fault;
            }
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

/** Await native async filesystem conditions, never waitForFunction's Promise truthiness.
 * Each predicate evaluation is awaited; a stalled native call is bounded by the same deadline.
 * @template T
 * @param {import('playwright').Page} page
 * @param {(arg: T) => boolean | Promise<boolean>} condition A browser function, no Node closures.
 * @param {{timeoutMs?: number, intervalMs?: number, arg?: T,
 *   report: Awaited<ReturnType<typeof import('./report.mjs').createReport>>}} options
 */
export async function waitForVault(page, condition, { timeoutMs = 10000, intervalMs = 50, report, arg } = {}) {
    if (!report?.data) throw new Error('waitForVault requires the run report');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000 || !Number.isFinite(intervalMs) || intervalMs <= 0) {
        throw new Error('Vault wait needs a finite timeout ≤300000 ms and positive polling interval');
    }
    const started = performance.now(), deadline = started + timeoutMs;
    const observation = { startedAt: new Date().toISOString(), timeoutMs, intervalMs, polls: 0, lastObserved: null, passed: false };
    const waits = report.data.vaultWaits ??= [];
    waits.push(observation);
    try {
        while (performance.now() < deadline) {
            observation.polls++;
            observation.lastObserved = await beforeDeadline(page.evaluate(condition, arg), deadline, 'Native filesystem condition exceeded its deadline');
            if (observation.lastObserved === true && performance.now() <= deadline) { observation.passed = true; return true; }
            await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(intervalMs, deadline - performance.now()))));
        }
        throw new Error(`Vault condition timed out; last observed: ${JSON.stringify(observation.lastObserved)}`);
    } catch (error) {
        observation.error = error.message;
        const fault = new Error(`Vault wait harness fault: ${error.message}`, { cause: error });
        fault.name = 'HarnessFault';
        throw fault;
    } finally { observation.elapsedMs = performance.now() - started; }
}

/** External writes, real OPFS move records, or copy+delete (different observer arm).
 * @param {import('playwright').Page} page
 * @param {{name: string, operation: 'write'|'delete'|'move'|'copy-delete', path: string,
 *   destination?: string, data?: string | Uint8Array}} options
 */
export async function outsideChange(page, { name, operation, path, destination, data }) {
    if (!['write', 'delete', 'move', 'copy-delete'].includes(operation)) throw new Error(`Unknown outside operation: ${operation}`);
    const parts = checkedPath(path);
    const to = destination ? checkedPath(destination) : null;
    if (['move', 'copy-delete'].includes(operation) && !to) throw new Error('A move needs a destination');
    return page.evaluate(async ({ name, operation, parts, to, bytes }) => {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
        const parent = async parts => {
            let dir = root;
            for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
            return dir;
        };
        const dir = await parent(parts);
        if (operation === 'delete') return dir.removeEntry(parts.at(-1));
        const handle = await dir.getFileHandle(parts.at(-1), { create: operation === 'write' });
        if (operation === 'write') {
            const writable = await handle.createWritable();
            await writable.write(new Uint8Array(bytes));
            return writable.close();
        }
        const target = await parent(to);
        if (operation === 'move') {
            if (typeof handle.move !== 'function') throw new Error('OPFS handle.move is unavailable; copy-delete is not an equivalent arm');
            return handle.move(target, to.at(-1));
        }
        const copy = await (await target.getFileHandle(to.at(-1), { create: true })).createWritable();
        await copy.write(await handle.getFile());
        await copy.close();
        await dir.removeEntry(parts.at(-1));
    }, { name, operation, parts, to, bytes: data === undefined ? [] : [...(typeof data === 'string' ? new TextEncoder().encode(data) : data)] });
}
