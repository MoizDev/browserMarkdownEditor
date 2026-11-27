let nextClosedRevision = 0;

export function createClosedCanvasVersions() {
    type Fact = { root: FileSystemDirectoryHandle; handle: FileSystemFileHandle; hash: string; lastModified: number; size: number; revision: number };
    const facts = new Map<string, Fact>(), queues = new Map<string, Promise<void>>();
    let currentActivation: number | undefined;
    return {
        async acquire(root: FileSystemDirectoryHandle, activation: number, path: string, signal: AbortSignal) {
            if (!Number.isSafeInteger(activation) || activation < 0 || !path) throw new TypeError('Invalid closed canvas identity');
            signal.throwIfAborted();
            if (currentActivation !== undefined && activation < currentActivation) throw new DOMException('Vault changed', 'AbortError');
            if (currentActivation !== activation) { facts.clear(); currentActivation = activation; }
            const key = JSON.stringify([activation, path]), prior = queues.get(key) ?? Promise.resolve();
            let unlock!: () => void;
            const held = new Promise<void>(resolve => { unlock = resolve; });
            const tail = prior.then(() => held);
            queues.set(key, tail);
            let released = false;
            const release = () => {
                if (released) return; released = true; unlock();
                void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
            };
            let abort!: () => void;
            const cancelled = new Promise<never>((_resolve, reject) => {
                abort = () => reject(signal.reason ?? new DOMException('Closed canvas read cancelled', 'AbortError'));
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) abort();
            });
            try { await Promise.race([prior, cancelled]); signal.throwIfAborted(); }
            catch (error) { release(); throw error; }
            finally { signal.removeEventListener('abort', abort); }
            return {
                async observe(handle: FileSystemFileHandle, version: { hash: string; lastModified: number; size: number },
                    sameEntry: (a: FileSystemHandle, b: FileSystemHandle) => Promise<boolean>, current: () => boolean) {
                    signal.throwIfAborted();
                    if (released || currentActivation !== activation || !current() || !/^[a-f0-9]{64}$/.test(version.hash)) throw new DOMException('Closed canvas source changed', 'AbortError');
                    const priorFact = facts.get(key);
                    const same = !!priorFact && priorFact.root === root && priorFact.hash === version.hash
                        && priorFact.lastModified === version.lastModified && priorFact.size === version.size && await sameEntry(priorFact.handle, handle);
                    signal.throwIfAborted();
                    if (released || currentActivation !== activation || !current()) throw new DOMException('Closed canvas source changed', 'AbortError');
                    if (same) return priorFact!.revision;
                    if (nextClosedRevision === Number.MAX_SAFE_INTEGER) throw new RangeError('Closed canvas revision exhausted');
                    const revision = ++nextClosedRevision;
                    facts.set(key, { root, handle, ...version, revision });
                    return revision;
                },
                release,
            };
        },
    };
}
