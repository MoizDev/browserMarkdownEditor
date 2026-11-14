// External IPC/CDP fault: pause the unchanged production inventory at its
// bounded stream read, then terminate the public Worker. Never call app code.
import { createHash } from 'node:crypto';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function armRoleWorkerDeath(page, origin, artifact) {
    const url = new URL(artifact.url, origin).href;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Cannot bind breakpoint source: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha(bytes) !== artifact.sha256 || bytes.length !== artifact.bytes) throw new Error('Breakpoint source is not the emitted role worker');
    const source = bytes.toString('utf8');
    const matches = [...source.matchAll(/\.getBytes\([\w$]+\+1\)/g)];
    if (matches.length !== 1) throw new Error(`Bounded read must match once, got ${matches.length}`);
    const point = source.lastIndexOf(';', matches[0].index) + 1;
    const readEnd = matches[0].index + matches[0][0].length;
    if (matches[0].index - point > 256) throw new Error('Read no longer occupies one bounded statement');
    // V8 source positions count ALL JavaScript line terminators, not only LF.
    const starts = [0, ...[...source.matchAll(/\r\n|[\n\r\u2028\u2029]/g)].map(match => match.index + match[0].length)];
    const relativeLine = starts.findLastIndex(start => start <= point);
    const state = { url, sha256: artifact.sha256, targets: [], scripts: [], debuggerReady: false,
        paused: false, readPauseCount: 0, terminated: false, detached: false, pauses: [], errors: [] };
    await page.addInitScript(() => {
        const NativeWorker = window.Worker, nativePost = NativeWorker.prototype.postMessage;
        const roles = new WeakSet(), held = [];
        let ready = false;
        const forward = (worker, message) => {
            window.__p09.roleRequestsForwarded = (window.__p09.roleRequestsForwarded ?? 0) + 1;
            nativePost.call(worker, message);
        };
        // Playwright's debugger client may resume boot before our breakpoint
        // exists. Hold the real IPC packet, unchanged, until we are ready.
        window.__p09ReleaseRoleTransport = () => {
            ready = true;
            for (const item of held) forward(item.worker, item.message);
            held.length = 0;
        };
        window.Worker = class extends NativeWorker {
            constructor(url, options) {
                super(url, options);
                if (String(url).includes('pdfBuild.worker-')) {
                    roles.add(this);
                    (window.__p09.roleWorkers ??= []).push(this);
                    this.addEventListener('message', event => {
                        if (event.data?.role) (window.__p09.roleReplies ??= []).push({ kind: event.data.role.kind, originalBytes: event.data.role.original?.byteLength, snapshotBytes: event.data.role.snapshot?.length });
                    });
                }
            }
            postMessage(...args) {
                if (roles.has(this) && args[0]?.kind === 'inspect-role') {
                    if (!ready) { held.push({ worker: this, message: structuredClone(args[0]) }); return; }
                    forward(this, args[0]); return;
                }
                return nativePost.apply(this, args);
            }
        };
    });
    const cdp = await page.context().newCDPSession(page);
    const pending = new Map(), hints = new Set(), sourceJobs = new Set();
    let nextId = 1, roleSession, breakpoint, parsed;
    function send(sessionId, method, params = {}) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
            pending.set(`${sessionId}:${id}`, { resolve, reject });
            cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => {
                pending.delete(`${sessionId}:${id}`); reject(error);
            });
        });
    }
    const error = value => {
        if (!(state.detached && value.message === 'Worker target detached')) state.errors.push(value.message);
    };
    cdp.on('Target.receivedMessageFromTarget', event => {
        const message = JSON.parse(event.message), sessionId = event.sessionId;
        if (message.id) {
            const key = `${sessionId}:${message.id}`, entry = pending.get(key);
            if (!entry) return;
            pending.delete(key);
            if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
            return;
        }
        if (message.method === 'Debugger.scriptParsed' && hints.has(sessionId)) {
            const descriptor = message.params, key = `${sessionId}:${descriptor.scriptId}`;
            if (sourceJobs.has(key)) return;
            sourceJobs.add(key);
            void (async () => {
                const result = await send(sessionId, 'Debugger.getScriptSource', { scriptId: descriptor.scriptId });
                const hash = sha(Buffer.from(result.scriptSource, 'utf8'));
                state.scripts.push({ url: descriptor.url, scriptId: descriptor.scriptId, hash, startLine: descriptor.startLine,
                    startColumn: descriptor.startColumn, endLine: descriptor.endLine, endColumn: descriptor.endColumn });
                if (hash !== artifact.sha256) return;
                if (state.debuggerReady) throw new Error('More than one script matches the role worker');
                parsed = descriptor; roleSession = sessionId;
                const location = { scriptId: descriptor.scriptId, lineNumber: descriptor.startLine + relativeLine,
                    columnNumber: point - starts[relativeLine] + (relativeLine === 0 ? descriptor.startColumn : 0) };
                state.requested = location;
                await send(sessionId, 'Debugger.setSkipAllPauses', { skip: false });
                await send(sessionId, 'Debugger.setBreakpointsActive', { active: true });
                const end = { ...location, columnNumber: location.columnNumber + readEnd - point + 1 };
                const possible = await send(sessionId, 'Debugger.getPossibleBreakpoints', { start: location, end, restrictToFunction: false });
                state.possible = possible.locations;
                const target = possible.locations.find(location => location.type === 'call') ?? possible.locations[0];
                if (!target) throw new Error('No executable breakpoint in the bounded read statement');
                const bound = await send(sessionId, 'Debugger.setBreakpoint', { location: { scriptId: target.scriptId, lineNumber: target.lineNumber, columnNumber: target.columnNumber } });
                state.resolved = bound.actualLocation;
                breakpoint = bound.breakpointId;
                state.debuggerReady = true;
                await page.evaluate(() => window.__p09ReleaseRoleTransport());
            })().catch(error);
            return;
        }
        if (message.method !== 'Debugger.paused') return;
        state.pauses.push({ sessionId, reason: message.params.reason, hitBreakpoints: message.params.hitBreakpoints, frames: message.params.callFrames.slice(0, 3).map(frame => ({ name: frame.functionName, location: frame.location, functionLocation: frame.functionLocation })) });
        if (sessionId !== roleSession || !message.params.hitBreakpoints?.includes(breakpoint)) {
            void send(sessionId, 'Debugger.resume').catch(error); return;
        }
        const actual = message.params.callFrames[0]?.location;
        if (!actual) { state.errors.push('No live frame at the read breakpoint'); return; }
        const line = actual.lineNumber - parsed.startLine;
        const offset = starts[line] + actual.columnNumber - (line === 0 ? parsed.startColumn : 0);
        state.actual = actual; state.pauseOffset = offset;
        if (!Number.isInteger(offset) || offset < point || offset > readEnd) { state.errors.push('Breakpoint moved outside the bounded read statement'); return; }
        state.paused = true;
        if (++state.readPauseCount > 2) { state.errors.push('One legacy read reached more than its source/snapshot pair'); return; }
        if (state.terminationRequested) return;
        state.terminationRequested = true;
        // Stop JS before the asynchronous main-page Worker.terminate roundtrip;
        // another attached debugger can otherwise resume the first pause.
        void send(sessionId, 'Runtime.terminateExecution').catch(error => { state.interruptReply = error.message; });
        void page.evaluate(() => {
            const worker = window.__p09.roleWorkers?.at(-1);
            if (!worker) throw new Error('Public role Worker was not witnessed');
            worker.terminate();
            window.__p09.terminatedWorkers = (window.__p09.terminatedWorkers ?? 0) + 1;
        }).then(() => { state.terminated = true; }).catch(error);
    });
    cdp.on('Target.detachedFromTarget', event => {
        if (event.sessionId === roleSession) state.detached = true;
        for (const [key, entry] of pending) if (key.startsWith(`${event.sessionId}:`)) {
            pending.delete(key); entry.reject(new Error('Worker target detached'));
        }
    });
    cdp.on('Target.attachedToTarget', event => {
        void (async () => {
            state.targets.push({ type: event.targetInfo.type, url: event.targetInfo.url });
            if (event.targetInfo.url === url) {
                hints.add(event.sessionId);
                await send(event.sessionId, 'Debugger.enable');
            }
            await send(event.sessionId, 'Runtime.runIfWaitingForDebugger');
        })().catch(error);
    });
    const activate = () => cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
    await activate();
    return { state, activate,
        check() {
            if (state.errors.length || !state.debuggerReady || !state.paused || !state.terminated || !state.detached) throw new Error(`Death-at-read fault unproven: ${JSON.stringify(state)}`);
            return structuredClone(state);
        },
        async stop() {
            await cdp.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: false }).catch(() => {});
            await cdp.detach().catch(() => {});
        },
    };
}
