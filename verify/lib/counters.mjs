/** Window-only wrappers. They intentionally do NOT claim visibility inside workers.
 * @param {import('playwright').BrowserContext} context
 * @param {{vaultName?: string | null}} options
 */
export async function installCounters(context, { vaultName = null } = {}) {
    await context.addInitScript(({ vaultName }) => {
        // Context init scripts also enter opaque reader frames. V-01a counts
        // only the main window; V-01b instruments other realms explicitly.
        if (window !== window.top) return;
        let storage;
        try { storage = navigator.storage; } catch { return; }
        if (typeof FileSystemHandle !== 'function' || typeof FileSystemDirectoryHandle !== 'function' ||
            typeof FileSystemFileHandle !== 'function' || typeof storage?.getDirectory !== 'function') return;
        if (window.__bmeCounters) return;
        let records = [], sequence = 0;
        const paths = new WeakMap();
        const log = (op, fields = {}) => {
            if ('path' in fields && vaultName) {
                const opfsPath = fields.path;
                const prefix = `${vaultName}/`;
                fields = { ...fields, opfsPath, vault: vaultName,
                    path: opfsPath === vaultName ? '' : opfsPath?.startsWith(prefix) ? opfsPath.slice(prefix.length) : opfsPath };
            }
            records.push({ sequence: ++sequence, time: performance.now(), op, ...fields });
        };
        const pathOf = handle => paths.get(handle) ?? handle?.name ?? null;
        const childPath = (dir, name) => [pathOf(dir), name].filter(Boolean).join('/');
        const getRoot = storage.getDirectory.bind(storage);
        storage.getDirectory = async function () {
            const handle = await getRoot();
            paths.set(handle, '');
            return handle;
        };
        const directory = FileSystemDirectoryHandle.prototype;
        for (const method of ['getDirectoryHandle', 'getFileHandle']) {
            const original = directory[method];
            directory[method] = async function (name, ...args) {
                const handle = await original.call(this, name, ...args);
                paths.set(handle, childPath(this, name));
                return handle;
            };
        }
        for (const method of ['entries', 'values', 'keys']) {
            const original = directory[method];
            directory[method] = function (...args) {
                log(method, { path: pathOf(this) });
                const iterator = original.apply(this, args), dir = this;
                return {
                    async next(...args) {
                        const result = await iterator.next(...args);
                        if (!result.done && method !== 'keys') {
                            const handle = method === 'entries' ? result.value[1] : result.value;
                            paths.set(handle, childPath(dir, handle.name));
                        }
                        return result;
                    },
                    async return(value) { return iterator.return ? iterator.return(value) : { value, done: true }; },
                    async throw(error) { if (iterator.throw) return iterator.throw(error); throw error; },
                    [Symbol.asyncIterator]() { return this; },
                };
            };
        }
        // for-await directly on a directory must not bypass entries instrumentation.
        directory[Symbol.asyncIterator] = directory.entries;
        const wrap = (prototype, method, operation, detail) => {
            const original = prototype[method];
            prototype[method] = async function (...args) {
                const fields = { ...detail.call(this, args), time: performance.now() };
                try {
                    const result = await original.apply(this, args);
                    log(operation, { ...fields, ok: true });
                    return result;
                } catch (error) { log(operation, { ...fields, ok: false, error: error.name }); throw error; }
            };
        };
        wrap(directory, 'removeEntry', 'removeEntry', function (args) { return { path: childPath(this, args[0]), recursive: !!args[1]?.recursive }; });
        wrap(FileSystemFileHandle.prototype, 'getFile', 'getFile', function () { return { path: pathOf(this) }; });
        const createWritable = FileSystemFileHandle.prototype.createWritable;
        FileSystemFileHandle.prototype.createWritable = async function (...args) {
            const path = pathOf(this), time = performance.now();
            try {
                const stream = await createWritable.apply(this, args);
                log('createWritable', { path, time, ok: true });
                const close = stream.close;
                stream.close = async function (...args) {
                    const time = performance.now();
                    try { const result = await close.apply(this, args); log('close', { path, time, completedAt: performance.now(), ok: true }); return result; }
                    catch (error) { log('close', { path, time, ok: false, error: error.name }); throw error; }
                };
                return stream;
            } catch (error) { log('createWritable', { path, time, ok: false, error: error.name }); throw error; }
        };
        const NativeWorker = window.Worker;
        let workerId = 0;
        window.Worker = new Proxy(NativeWorker, {
            construct(Target, args, NewTarget) {
                const worker = Reflect.construct(Target, args, NewTarget);
                const id = ++workerId, url = String(args[0]), name = args[1]?.name ?? '';
                log('workerStart', { id, url, name });
                const terminate = worker.terminate;
                worker.terminate = function (...args) { log('workerTerminate', { id, url, name }); return terminate.apply(this, args); };
                return worker;
            },
        });
        const contextIds = new WeakMap();
        let contextId = 0;
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
            const result = getContext.call(this, type, ...args);
            let id = result && contextIds.get(result);
            if (result && !id) { id = ++contextId; contextIds.set(result, id); }
            log('getContext', { type, id: id || null, ok: !!result, canvasId: this.id || null });
            return result;
        };
        window.__bmeCounters = {
            read: () => ({ realm: 'window', vaultName, url: location.href, records: records.slice() }),
            reset: () => {
                const previous = { realm: 'window', vaultName, url: location.href, records: records.slice() };
                records = []; sequence = 0;
                return previous;
            },
        };
    }, { vaultName });
}

/** One browser round trip, with paths and outcome for every observed operation.
 * @param {import('playwright').Page} page
 */
export async function readCounters(page) {
    return page.evaluate(() => {
        if (!window.__bmeCounters) throw new Error('Window counters were not installed');
        return window.__bmeCounters.read();
    });
}
/** @param {import('playwright').Page} page */
export async function resetCounters(page) {
    return page.evaluate(() => {
        if (!window.__bmeCounters) throw new Error('Window counters were not installed');
        return window.__bmeCounters.reset();
    });
}
