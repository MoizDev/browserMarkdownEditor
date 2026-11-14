import { HELPER_APP_ID, HELPER_HOST, HELPER_PORTS, MIN_HELPER_VERSION, PROTOCOL_VERSION } from '../../../shared/vaultAgentProtocol.ts';

/** Real transport stand-in, not an executor import. Every frame in both directions is recorded.
 * `cancel: 'after-tool'` keeps a stopping run open for its honest tool reply; 'immediate' models a
 * helper that has already stopped waiting (vault switch/uninstall). V-02 will adopt this module. */
export async function installHelperStandIn(context, { cancel = 'after-tool', record = () => {} } = {}) {
    const frames = [];
    const runs = [];
    const calls = [];
    const waiters = new Map();
    let socket;
    let active;
    let sequence = 0;
    let disposed = false;
    const log = (direction, frame) => {
        const event = { at: Date.now(), direction, frame };
        frames.push(event);
        record({ type: 'helper-frame', ...event });
    };
    const send = frame => { log('helper-to-app', frame); socket.send(JSON.stringify(frame)); };
    const finishRun = (runId = active?.runId, status = 'ok') => {
        const run = runs.find(r => r.runId === runId);
        if (!run || run.ended) return;
        run.ended = { at: Date.now(), status };
        send({ type: 'run.done', runId, sessionId: null, status });
        if (active === run) active = undefined;
    };
    await context.route(new RegExp(`http://${HELPER_HOST.replaceAll('.', '\\.')}:(?:${HELPER_PORTS.join('|')})/health$`), route => route.fulfill({
        contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ app: HELPER_APP_ID, version: MIN_HELPER_VERSION, protocol: PROTOCOL_VERSION, platform: 'macos' }),
    }));
    await context.routeWebSocket(new RegExp(`ws://${HELPER_HOST.replaceAll('.', '\\.')}:(?:${HELPER_PORTS.join('|')})/ws$`), ws => {
        socket = ws;
        ws.onMessage(raw => {
            const frame = JSON.parse(String(raw));
            log('app-to-helper', frame);
            if (frame.type === 'tool.result') {
                const call = calls.find(c => c.callId === frame.callId && c.runId === frame.runId);
                if (!call || call.result) throw new Error(`HarnessFault: unknown/duplicate tool result ${frame.callId}`);
                call.result = frame.result;
                call.repliedAt = Date.now();
                const waiter = waiters.get(frame.callId);
                if (waiter) { clearTimeout(waiter.timer); waiters.delete(frame.callId); waiter.resolve(frame.result); }
                const run = runs.find(r => r.runId === frame.runId);
                if (run?.cancelling && !calls.some(c => c.runId === run.runId && !c.result)) finishRun(run.runId, 'cancelled');
                return;
            }
            const reply = result => send({ type: 'response', reqId: frame.reqId, ok: true, result });
            switch (frame.type) {
                case 'hello': reply({ version: MIN_HELPER_VERSION, protocol: PROTOCOL_VERSION, platform: 'macos', sessionsDir: '/fixture-sessions' }); break;
                case 'agents.status': reply([{ agent: 'claude', installed: true, loggedIn: true, version: 'fixture', loginCommand: '', installCommand: '' }]); break;
                case 'models.list': reply([{ id: 'fixture', label: 'Fixture', efforts: [], defaultEffort: null, images: false, isDefault: true }]); break;
                case 'vault.sync': reply({ written: frame.files.length, removed: 0 }); break;
                case 'run.start':
                    active = { runId: frame.runId, startedAt: Date.now(), input: frame };
                    runs.push(active);
                    reply({ accepted: true });
                    break;
                case 'run.cancel': {
                    const run = runs.find(r => r.runId === frame.runId);
                    if (run) run.cancelling = true;
                    reply({ cancelled: true });
                    if (cancel === 'immediate' || !calls.some(c => c.runId === frame.runId && !c.result)) finishRun(frame.runId, 'cancelled');
                    break;
                }
                case 'helper.uninstall':
                    reply({ ok: true });
                    if (active) finishRun(active.runId, 'cancelled');
                    break;
                default: throw new Error(`HarnessFault: unexpected helper request ${frame.type}`);
            }
        });
    });
    return {
        frames, runs, calls,
        get activeRun() { return active; },
        finishRun,
        sendTool(name, args, { timeoutMs = 60000 } = {}) {
            if (!socket || !active || disposed) throw new Error('HarnessFault: a user-started run must exist before sending a tool');
            const call = { callId: `fixture-tool-${++sequence}`, runId: active.runId, name, args, askedAt: Date.now() };
            calls.push(call);
            const result = new Promise((resolve, reject) => {
                const timer = setTimeout(() => { waiters.delete(call.callId); reject(new Error(`HarnessFault: ${call.callId} did not reply in ${timeoutMs} ms`)); }, timeoutMs);
                waiters.set(call.callId, { resolve, reject, timer });
            });
            // Some lifecycle arms deliberately close a run without a reply. They inspect calls and
            // run.done instead; dispose clears the wait without leaking a Node timeout/rejection.
            void result.catch(() => {});
            send({ type: 'tool.call', runId: call.runId, callId: call.callId, name, args });
            return { call, result };
        },
        dispose() {
            disposed = true;
            for (const [id, waiter] of waiters) {
                clearTimeout(waiter.timer);
                waiter.reject(new Error(`HarnessFault: helper disposed with ${id} unanswered`));
            }
            waiters.clear();
        },
    };
}

export const toolText = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
