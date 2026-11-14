/** Browser-only observations. No app import, no replacement worker implementation or result. */
export async function installCounters(context) {
    await context.addInitScript(() => {
        const witness = window.__bmeCoreWitness = { workers: [], lifecycle: [], rejections: [] };
        const stamp = () => ({ at: performance.now(), date: Date.now() });
        document.addEventListener('freeze', () => {
            witness.lifecycle.push({ event: 'freeze', ...stamp() });
            console.debug('BME_CORE_LIFECYCLE:freeze');
        });
        document.addEventListener('resume', () => {
            witness.lifecycle.push({ event: 'resume', ...stamp() });
            console.debug('BME_CORE_LIFECYCLE:resume');
        });
        window.addEventListener('unhandledrejection', event => witness.rejections.push(String(event.reason)));
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
            constructor(...args) {
                super(...args);
                const item = this.__bmeCoreWorker = {
                    id: witness.workers.length + 1, url: String(args[0]), ...stamp(), posts: [], messages: [], terminations: [], errors: [],
                };
                witness.workers.push(item);
                this.addEventListener('message', ({ data }) => {
                    // Never retain a result's Blob/bitmap/document bytes in instrumentation.
                    item.messages.push({ ...stamp(), id: data?.id, event: data?.event, heartbeatId: data?.event === 'heartbeat' ? data.data?.id : undefined,
                        ok: data?.ok, error: data?.error?.name, hello: data?.hello });
                });
                this.addEventListener('error', event => item.errors.push({ ...stamp(), message: event.message }));
            }
            postMessage(...args) {
                const data = args[0];
                this.__bmeCoreWorker.posts.push({ ...stamp(), id: data?.id, op: data?.op, path: data?.args?.path,
                    cancel: data?.cancel, reprioritise: data?.reprioritise, pause: data?.pause, resume: data?.resume,
                    priority: data?.priority, deadlineMs: data?.deadlineMs });
                return super.postMessage(...args);
            }
            terminate() {
                this.__bmeCoreWorker.terminations.push(stamp());
                return super.terminate();
            }
        };
    });
    return {
        async read(page) {
            return page.evaluate(() => ({
                ...structuredClone(window.__bmeCoreWitness),
                clock: { date: Date.now(), monotonic: performance.now() },
                perf: typeof window.__perf?.workers === 'function' ? window.__perf.workers() : null,
            }));
        },
    };
}

/** Interim V-01b counters: actual worker targets, independent of our Worker.terminate wrapper. */
export async function installWorkerTargets(page, { record = () => {} } = {}) {
    const session = await page.context().newCDPSession(page);
    const workers = [];
    session.on('Target.attachedToTarget', event => {
        if (event.targetInfo.type !== 'worker') return;
        const worker = { ...event.targetInfo, sessionId: event.sessionId, attachedAt: Date.now() };
        workers.push(worker);
        record({ type: 'worker-attached', ...worker });
    });
    session.on('Target.targetInfoChanged', event => {
        const worker = workers.find(w => w.targetId === event.targetInfo.targetId);
        if (worker) worker.url = event.targetInfo.url;
    });
    session.on('Target.detachedFromTarget', event => {
        const worker = workers.find(w => w.sessionId === event.sessionId);
        if (!worker) return;
        worker.detachedAt = Date.now();
        record({ type: 'worker-detached', ...worker });
    });
    await session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    return {
        session, workers,
        read() {
            return {
                started: workers.length, ended: workers.filter(w => w.detachedAt).length,
                alive: workers.filter(w => !w.detachedAt).map(w => ({ ...w })), workers: workers.map(w => ({ ...w })),
            };
        },
        async stop() { await session.detach().catch(() => {}); },
    };
}
