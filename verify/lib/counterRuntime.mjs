/** Shared, closure-free instrumentation evaluated in a window or paused worker.
 * No permissions are granted here. Missing APIs are capabilities, not exceptions:
 * opaque realms must remain opaque (verification.md §3, contracts C5.4–5.5).
 * @param {{vaultName?: string|null, realm?: 'window'|'worker', bindingName?: string,
 *   postMessages?: boolean, blobReads?: boolean, targetUrl?: string}} options
 */
export function installCounterRuntime({ vaultName = null, realm = 'window', bindingName = '', postMessages = false, blobReads = false, targetUrl = '' } = {}) {
    const scope = globalThis;
    // Measured CfT157: a pre-start worker location.href getter crashes its
    // renderer. The CDP-announced URL is authoritative and needs no native getter.
    const realmUrl = () => realm === 'worker' ? targetUrl : scope.location?.href ?? '';
    if (scope.__bmeCounters) return scope.__bmeCounters.receipt;
    let records = [], sequence = 0;
    const paths = new WeakMap();
    const capabilities = { filesystem: false, storage: false, workerConstructor: typeof scope.Worker === 'function',
        blobReads: false, postMessages, canvases: [] };
    const log = (op, fields = {}) => {
        if ('path' in fields && vaultName) {
            const opfsPath = fields.path, prefix = `${vaultName}/`;
            fields = { ...fields, opfsPath, vault: vaultName,
                path: opfsPath === vaultName ? '' : opfsPath?.startsWith(prefix) ? opfsPath.slice(prefix.length) : opfsPath };
        }
        const record = { sequence: ++sequence, time: performance.now(), timeOrigin: performance.timeOrigin, op, ...fields };
        records.push(record);
        if (bindingName && typeof scope[bindingName] === 'function') scope[bindingName](JSON.stringify(record));
    };
    const pathOf = handle => paths.get(handle) ?? handle?.name ?? null;
    const childPath = (dir, name) => [pathOf(dir), name].filter(Boolean).join('/');
    let storage;
    try { storage = scope.navigator?.storage; } catch { /* denied in an opaque realm */ }
    if (typeof storage?.getDirectory === 'function') {
        const getRoot = storage.getDirectory.bind(storage);
        storage.getDirectory = async function () {
            const handle = await getRoot();
            paths.set(handle, '');
            instrumentHandle(handle);
            return handle;
        };
        capabilities.storage = true;
    }
    const directoryPrototypes = new WeakSet(), filePrototypes = new WeakSet();
    let hasDirectory = false, hasFile = false;
    const changedCapabilities = () => {
        capabilities.filesystem = hasDirectory && hasFile;
        log('capabilities', { capabilities: { ...capabilities } });
    };
    const wrap = (prototype, method, operation, detail) => {
        const original = prototype[method];
        prototype[method] = async function (...args) {
            const fields = { ...detail.call(this, args), time: performance.now() };
            try {
                const result = await original.apply(this, args);
                if (method === 'getFile') paths.set(result, pathOf(this));
                log(operation, { ...fields, ok: true });
                return result;
            } catch (error) { log(operation, { ...fields, ok: false, error: error.name }); throw error; }
        };
    };
    function instrumentDirectory(directory) {
        if (directoryPrototypes.has(directory)) return;
        directoryPrototypes.add(directory);
        for (const method of ['getDirectoryHandle', 'getFileHandle']) {
            const original = directory[method];
            directory[method] = async function (name, ...args) {
                const handle = await original.call(this, name, ...args);
                paths.set(handle, childPath(this, name));
                instrumentHandle(handle);
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
                            instrumentHandle(handle);
                        }
                        return result;
                    },
                    async return(value) { return iterator.return ? iterator.return(value) : { value, done: true }; },
                    async throw(error) { if (iterator.throw) return iterator.throw(error); throw error; },
                    [Symbol.asyncIterator]() { return this; },
                };
            };
        }
        directory[Symbol.asyncIterator] = directory.entries;
        wrap(directory, 'removeEntry', 'removeEntry', function (args) { return { path: childPath(this, args[0]), recursive: !!args[1]?.recursive }; });
        hasDirectory = true; changedCapabilities();
    }
    function instrumentFile(file) {
        if (filePrototypes.has(file)) return;
        filePrototypes.add(file);
        wrap(file, 'getFile', 'getFile', function () { return { path: pathOf(this) }; });
        const createWritable = file.createWritable;
        file.createWritable = async function (...args) {
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
        hasFile = true; changedCapabilities();
    }
    function instrumentHandle(handle) {
        if (handle?.kind === 'directory' && typeof handle.getDirectoryHandle === 'function') instrumentDirectory(Object.getPrototypeOf(handle));
        else if (handle?.kind === 'file' && typeof handle.getFile === 'function') instrumentFile(Object.getPrototypeOf(handle));
    }
    // Worker globals may not expose the FSA constructors before startup, even
    // though returned handles work. Hook each native prototype before returning
    // its first instance, not after the user's first getFile() has already run.
    if (scope.FileSystemDirectoryHandle?.prototype) instrumentDirectory(scope.FileSystemDirectoryHandle.prototype);
    if (scope.FileSystemFileHandle?.prototype) instrumentFile(scope.FileSystemFileHandle.prototype);
    if (blobReads && typeof scope.Blob?.prototype.arrayBuffer === 'function') {
        const original = scope.Blob.prototype.arrayBuffer;
        scope.Blob.prototype.arrayBuffer = async function (...args) {
            const time = performance.now(), path = pathOf(this), bytes = this.size;
            try { const result = await original.apply(this, args); log('blobRead', { path, bytes, time, ok: true }); return result; }
            catch (error) { log('blobRead', { path, bytes, time, ok: false, error: error.name }); throw error; }
        };
        capabilities.blobReads = true;
    }
    if (capabilities.workerConstructor) {
        const NativeWorker = scope.Worker;
        let workerId = 0;
        scope.Worker = new Proxy(NativeWorker, {
            construct(Target, args, NewTarget) {
                const worker = Reflect.construct(Target, args, NewTarget);
                const id = ++workerId, url = new URL(String(args[0]), realmUrl()).href, name = args[1]?.name ?? '';
                log('workerStart', { id, url, name });
                const terminate = worker.terminate;
                worker.terminate = function (...args) { log('workerTerminate', { id, url, name }); return terminate.apply(this, args); };
                if (postMessages) {
                    const post = worker.postMessage;
                    worker.postMessage = function (...args) { log('postMessage', { direction: 'to-worker', id, url, name }); return post.apply(this, args); };
                }
                return worker;
            },
        });
    }
    if (realm === 'worker') {
        // The index exception (C5.5) receives cloned handles instead of opening
        // OPFS. Capture their native prototypes before the app's message handler.
        const ports = new WeakSet();
        const received = event => {
            try {
                const stack = [event.data], seen = new WeakSet();
                for (const port of event.ports ?? []) {
                    if (ports.has(port)) continue;
                    ports.add(port);
                    port.addEventListener('message', received); // Never start a port on the app's behalf.
                }
                while (stack.length) {
                    const value = stack.pop();
                    if (!value || typeof value !== 'object' || seen.has(value)) continue;
                    seen.add(value);
                    instrumentHandle(value);
                    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Blob) continue;
                    if (value instanceof Map) { for (const [key, item] of value) stack.push(key, item); }
                    else if (value instanceof Set) { for (const item of value) stack.push(item); }
                    else if (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
                        for (const item of Object.values(value)) stack.push(item);
                    }
                }
            } catch (error) { log('instrumentationFault', { reason: error.message }); }
            if (postMessages) log('messageReceived');
        };
        scope.addEventListener('message', received);
        if (postMessages && typeof scope.postMessage === 'function') {
            const post = scope.postMessage;
            scope.postMessage = function (...args) { log('postMessage', { direction: 'from-worker' }); return post.apply(this, args); };
        }
    }
    const contextIds = new WeakMap();
    let contextId = 0;
    for (const Canvas of [scope.HTMLCanvasElement, scope.OffscreenCanvas].filter(value => typeof value === 'function')) {
        const getContext = Canvas.prototype.getContext;
        Canvas.prototype.getContext = function (type, ...args) {
            const result = getContext.call(this, type, ...args);
            let id = result && contextIds.get(result);
            if (result && !id) { id = ++contextId; contextIds.set(result, id); }
            log('getContext', { type, id: id || null, ok: !!result, surface: Canvas.name, canvasId: this.id || null });
            return result;
        };
        capabilities.canvases.push(Canvas.name);
    }
    const receipt = { version: 'bme-counter-runtime-2', realm, capabilities, workerName: realm === 'worker' ? scope.name ?? '' : '', url: realmUrl() };
    const read = () => ({ realm, vaultName, url: realmUrl(), receipt, records: records.slice() });
    scope.__bmeCounters = { receipt, read,
        reset: () => { const previous = read(); records = []; sequence = 0; return previous; } };
    return receipt;
}
