import { installCounterRuntime } from './counterRuntime.mjs';
import { readCounters } from './counters.mjs';
import { currentGrants } from './resources.mjs';

function harnessFault(message) {
    const error = new Error(message);
    error.name = 'HarnessFault';
    return error;
}

async function connect(debuggingPort) {
    const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/version`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw harnessFault(`CDP discovery returned ${response.status}`);
    const discovery = await response.json(), endpoint = new URL(discovery.webSocketDebuggerUrl);
    if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || Number(endpoint.port) !== debuggingPort || !endpoint.pathname.startsWith('/devtools/browser/')) throw harnessFault('CDP discovery did not name the caller’s loopback browser');
    const socket = new WebSocket(endpoint.href);
    const commands = new Map(), listeners = new Set();
    let nextId = 0, closed = false;
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', () => reject(harnessFault('CDP WebSocket could not open')), { once: true });
    });
    socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(event.data); }
        catch { for (const listener of listeners) listener({ method: 'transport.error', params: { message: 'Invalid CDP JSON' } }); return; }
        if (message.id !== undefined) {
            const pending = commands.get(message.id);
            if (!pending) return;
            commands.delete(message.id); clearTimeout(pending.timer);
            if (message.error) pending.reject(harnessFault(`CDP ${pending.method}: ${message.error.message}`));
            else pending.resolve(message.result ?? {});
        } else for (const listener of listeners) listener(message);
    });
    socket.addEventListener('close', () => {
        closed = true;
        for (const pending of commands.values()) { clearTimeout(pending.timer); pending.reject(harnessFault(`CDP closed during ${pending.method}`)); }
        commands.clear();
        for (const listener of listeners) listener({ method: 'transport.closed', params: {} });
    });
    return {
        discovery,
        on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        send(method, params = {}, sessionId) {
            if (closed) return Promise.reject(harnessFault(`CDP is closed: ${method}`));
            const id = ++nextId;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => { commands.delete(id); reject(harnessFault(`CDP command timed out: ${method}`)); }, 10000);
                commands.set(id, { method, resolve, reject, timer });
                socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
            });
        },
        async close() {
            if (closed) return;
            await new Promise(resolve => { socket.addEventListener('close', resolve, { once: true }); socket.close(); });
        },
    };
}

/** Functional-only CDP observer (verification.md:121–142). Owns no app entry.
 * Part1 counts every dedicated worker; iframe targets are recorded/resumed but
 * explicitly DEFERRED, never described as counted. No timed run may install it.
 * @param {import('playwright').Page} page
 * @param {{debuggingPort: number, vaultName: string, report?: {data: object},
 *   fault?: {skipRecursiveAutoAttach?: boolean, skipWorkerUrl?: string,
 *     noAutoAttach?: boolean, resumeOnly?: boolean, evaluateControl?: 'trivial'|'location'|'name'}}} options
 */
export async function instrumentTargets(page, { debuggingPort, vaultName, report, fault = {} }) {
    if ((await currentGrants()).has('bench')) throw harnessFault('Paused-target instrumentation is forbidden in a bench grant');
    if (!Number.isInteger(debuggingPort) || debuggingPort < 1024 || debuggingPort > 65535) throw harnessFault('A debuggingPort from the caller’s own range is required');
    const pageProbe = await page.context().newCDPSession(page);
    const { targetInfo: pageInfo } = await pageProbe.send('Target.getTargetInfo');
    await pageProbe.detach();
    const transport = await connect(debuggingPort);
    const entries = new Map(), deferred = new Map(), sessions = new Map(), records = new Map();
    const pending = new Set(), faults = [], events = [];
    const bindingName = '__bmeTargetCounterRecord';
    const autoAttach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
    let rootSession, stopping = false, stopped = false;
    const skipWorker = fault.skipWorkerUrl ? new RegExp(fault.skipWorkerUrl) : null;
    const inContext = info => !info.browserContextId || !pageInfo.browserContextId || info.browserContextId === pageInfo.browserContextId;
    const noteFault = message => faults.push({ time: performance.now(), message });
    const announce = (info, source, creator) => {
        if (!inContext(info)) return null;
        if (['service_worker', 'shared_worker'].includes(info.type)) { noteFault(`Unsupported app target: ${info.type} ${info.url}`); return null; }
        if (info.type === 'iframe') {
            const entry = deferred.get(info.targetId) ?? { targetId: info.targetId, type: info.type };
            // Keep the object the async resume task owns; replacing it on an
            // info-change dropped its eventual resumedAt from the report.
            Object.assign(entry, { url: info.url || entry.url || '', creator: creator ?? entry.creator ?? info.openerId ?? pageInfo.targetId,
                status: 'deferred to V-01b part2, not counted' });
            deferred.set(info.targetId, entry);
            return entry;
        }
        if (info.type !== 'worker') return null;
        let entry = entries.get(info.targetId);
        if (!entry) {
            entry = { targetId: info.targetId, type: info.type, url: info.url, creator: creator ?? info.openerId ?? pageInfo.targetId,
                announcedBy: [], instrumented: false, ended: false, announcedAt: performance.now() };
            entries.set(info.targetId, entry);
        }
        if (info.url) entry.url = info.url;
        if (creator) entry.creator = creator;
        if (!entry.announcedBy.includes(source)) entry.announcedBy.push(source);
        return entry;
    };
    const addRecords = (target, rows) => {
        for (const row of rows) {
            if (!Number.isInteger(row.sequence) || typeof row.op !== 'string') { noteFault(`Invalid counter record from ${target.targetId}`); continue; }
            if (row.op === 'instrumentationFault') noteFault(`Counter runtime failed in ${target.targetId}: ${row.reason}`);
            if (row.op === 'capabilities') target.currentCapabilities = row.capabilities;
            records.set(`${target.targetId}:${row.sequence}`, { ...row, targetId: target.targetId, targetType: target.type, targetUrl: target.url, creator: target.creator });
        }
    };
    const attached = async message => {
        const { sessionId, targetInfo: info, waitingForDebugger } = message.params;
        sessions.set(sessionId, info.targetId);
        if (info.targetId === pageInfo.targetId) return;
        const creator = sessions.get(message.sessionId) ?? pageInfo.targetId;
        const entry = announce(info, 'attachedToTarget', creator);
        if (!entry) {
            await transport.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
            return;
        }
        entry.sessionId = sessionId;
        entry.pausedAtStart = waitingForDebugger;
        try {
            if (!fault.skipRecursiveAutoAttach) {
                entry.stage = 'recursive-auto-attach';
                await transport.send('Target.setAutoAttach', autoAttach, sessionId);
                entry.recursiveAutoAttach = true;
            } else entry.recursiveAutoAttach = false;
            if (info.type === 'iframe') return;
            if (fault.resumeOnly) { entry.control = 'resume without Runtime.evaluate; not instrumented'; return; }
            if (entry.instrumented) return;
            if (!waitingForDebugger) throw harnessFault(`Worker was not paused before startup: ${info.targetId}`);
            entry.stage = 'runtime-enable';
            await transport.send('Runtime.enable', {}, sessionId);
            entry.stage = 'worker-metadata';
            const contextId = entry.contexts?.[0]?.id;
            if (contextId === undefined) throw harnessFault(`Worker has no execution context after Runtime.enable: ${info.targetId}`);
            entry.evaluationContextId = contextId;
            if (fault.evaluateControl) {
                const expressions = { trivial: '1+1', location: 'location.href', name: 'globalThis.name' };
                entry.stage = `evaluate-control-${fault.evaluateControl}`;
                const result = await transport.send('Runtime.evaluate', { expression: expressions[fault.evaluateControl], contextId, returnByValue: true }, sessionId);
                entry.controlResult = result.result?.value;
                entry.controlException = result.exceptionDetails?.text;
                return;
            }
            // TargetInfo supplies the same URL without touching WorkerLocation;
            // measured on CfT157, that pre-start native getter crashes the renderer.
            if (!entry.url) {
                const current = await transport.send('Target.getTargetInfo', { targetId: info.targetId });
                entry.url = current.targetInfo.url;
            }
            if (!entry.url) throw harnessFault(`No announced URL for worker ${info.targetId}`);
            if (skipWorker?.test(entry.url)) { entry.skippedByMutant = true; return; }
            entry.stage = 'binding';
            await transport.send('Runtime.addBinding', { name: bindingName }, sessionId);
            const options = { vaultName, realm: 'worker', bindingName, postMessages: true, blobReads: true, targetUrl: entry.url };
            entry.stage = 'counter-install';
            const result = await transport.send('Runtime.evaluate', { expression: `(${installCounterRuntime.toString()})(${JSON.stringify(options)})`, contextId, returnByValue: true }, sessionId);
            if (result.exceptionDetails) throw harnessFault(`Counter installation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
            const receipt = result.result.value;
            if (receipt?.version !== 'bme-counter-runtime-2' || receipt.realm !== 'worker') throw harnessFault(`No counter receipt from ${info.targetId}`);
            entry.receipt = receipt; entry.instrumented = true; entry.instrumentedAt = performance.now();
            entry.workerName = receipt.workerName;
        } catch (error) {
            entry.instrumentationError = error.message;
            entry.errorStage = entry.stage;
            if (info.type === 'worker') noteFault(error.message);
        }
        finally {
            // Even a failed probe must not leave application code frozen. Its
            // missing receipt remains a strict failure at the next check().
            await transport.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(error => {
                if (info.type === 'worker' && !entry.ended) noteFault(`Cannot resume ${info.targetId}: ${error.message}`);
            });
            entry.resumedAt = performance.now();
        }
    };
    const off = transport.on(message => {
        const { method, params = {}, sessionId } = message;
        if (method.startsWith('Target.')) events.push({ method, targetId: params.targetInfo?.targetId ?? params.targetId ?? sessions.get(params.sessionId), sessionId, time: performance.now() });
        if (method === 'Target.attachedToTarget') {
            const task = attached(message).catch(error => noteFault(error.message)).finally(() => pending.delete(task));
            pending.add(task);
        } else if (method === 'Target.targetCreated') announce(params.targetInfo, 'targetCreated');
        else if (method === 'Target.targetInfoChanged') announce(params.targetInfo, 'targetInfoChanged');
        else if (method === 'Target.targetDestroyed') {
            const entry = entries.get(params.targetId);
            if (entry) { entry.ended = true; entry.endedAt ??= performance.now(); entry.endReason = 'target-destroyed'; }
        } else if (method === 'Target.detachedFromTarget') {
            const entry = entries.get(sessions.get(params.sessionId));
            if (entry && !stopping) { entry.ended = true; entry.endedAt ??= performance.now(); entry.endReason = 'target-detached'; }
        } else if (method === 'Target.targetCrashed') {
            const entry = entries.get(params.targetId);
            if (entry) { entry.ended = true; entry.endReason = 'target-crashed'; entry.crash = params; }
            noteFault(`Target crashed: ${params.targetId} ${params.status ?? ''}`);
        } else if (method === 'Runtime.executionContextCreated') {
            const entry = entries.get(sessions.get(sessionId));
            if (entry) (entry.contexts ??= []).push(params.context);
        } else if (method === 'Runtime.bindingCalled' && params.name === bindingName) {
            const entry = entries.get(sessions.get(sessionId));
            if (!entry) { noteFault(`Counter record has unknown session ${sessionId}`); return; }
            try { addRecords(entry, [JSON.parse(params.payload)]); }
            catch (error) { noteFault(`Invalid counter payload: ${error.message}`); }
        } else if (method === 'transport.error' || (method === 'transport.closed' && !stopping)) noteFault(`Target transport lost: ${params.message ?? method}`);
    });
    try {
        await transport.send('Target.setDiscoverTargets', { discover: true });
        const attachedPage = await transport.send('Target.attachToTarget', { targetId: pageInfo.targetId, flatten: true });
        rootSession = attachedPage.sessionId;
        sessions.set(rootSession, pageInfo.targetId);
        if (!fault.noAutoAttach) await transport.send('Target.setAutoAttach', autoAttach, rootSession);
    } catch (error) { stopping = true; off(); await transport.close(); throw error; }
    const snapshot = () => ({ scope: 'V-01b part1: window plus dedicated workers; no frame-content coverage', debuggingPort,
        pageTargetId: pageInfo.targetId, targets: structuredClone([...entries.values()]), deferredFrames: structuredClone([...deferred.values()]),
        announced: [...entries.keys()], instrumented: [...entries.values()].filter(entry => entry.instrumented).map(entry => entry.targetId),
        faults: structuredClone(faults), events: structuredClone(events), fault,
        loss: 'Paused startup disturbs timing; frame contents/child-control proof deferred to part2; logical worker end does not prove CPU stopped before terminate()+2s' });
    const api = {
        async check() {
            if (stopped) throw harnessFault('Target observer was already stopped');
            // Browser-owned discovery is independent of recursive attachment. A
            // worker missed by a child session therefore cannot disappear silently.
            const current = await transport.send('Target.getTargets');
            for (const info of current.targetInfos) announce(info, 'getTargets');
            const deadline = performance.now() + 2000;
            do {
                while (pending.size) await Promise.all([...pending]);
                if (![...entries.values()].some(entry => !entry.instrumented && !entry.skippedByMutant && !entry.instrumentationError && !entry.ended)) break;
                await new Promise(resolve => setTimeout(resolve, 10));
            } while (performance.now() < deadline);
            const result = snapshot();
            if (report) report.data.targetCounters = result;
            const missed = result.targets.filter(entry => !entry.instrumented);
            if (missed.length) throw harnessFault(`uncounted worker: ${missed.map(entry => `${entry.targetId} ${entry.url}${entry.instrumentationError ? ` (${entry.instrumentationError})` : ''}`).join('; ')}`);
            if (faults.length) throw harnessFault(`Target instrumentation failed: ${faults.map(fault => fault.message).join('; ')}`);
            return result;
        },
        async read() {
            const identity = await api.check();
            const window = await readCounters(page);
            return { ...identity, window, records: [
                ...window.records.map(record => ({ ...record, targetId: pageInfo.targetId, targetType: 'page', targetUrl: page.url(), creator: null })),
                ...records.values(),
            ] };
        },
        async stop() {
            if (stopped) return;
            stopping = true;
            while (pending.size) await Promise.all([...pending]);
            await transport.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }, rootSession).catch(() => {});
            await transport.send('Target.setDiscoverTargets', { discover: false }).catch(() => {});
            off(); await transport.close(); stopped = true;
        },
    };
    return api;
}
