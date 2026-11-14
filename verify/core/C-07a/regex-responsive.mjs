import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const origin = process.env.BME_ORIGIN ?? 'http://localhost:6320';
const output = process.env.BME_OUTPUT ?? '/Users/adham/Developer/bme-impl/scratch/c-c/C-07a';
const mode = process.env.BME_CASE ?? 'all';
const pin = JSON.parse(await readFile(new URL('../../browser-pin.json', import.meta.url), 'utf8'));
const chrome = (await readFile('/Users/adham/Developer/bme-impl/scratch/browsers/CHROME', 'utf8')).trim();
await mkdir(output, { recursive: true });

async function until(condition, description, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await condition()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`Timed out: ${description}`);
}
const textOf = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');

// Local protocol stand-in, not an executor shortcut. Replace only this function with V-02's
// helper fixture when available; discovery, connection, run and tool execution stay in the app.
async function helperStandIn(context) {
    let socket;
    let runId;
    let cancelling;
    let sequence = 0;
    let runs = 0;
    const calls = new Map();
    const answered = new Set();
    const requests = [];
    const done = (id, status) => {
        socket.send(JSON.stringify({ type: 'run.done', runId: id, sessionId: null, status }));
        if (runId === id) runId = undefined;
        cancelling = undefined;
    };
    await context.route(/http:\/\/127\.0\.0\.1:4782[3-7]\/health/, route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ app: 'vaultagent', version: '0.1.2', protocol: 1, platform: 'macos' }),
        headers: { 'Access-Control-Allow-Origin': '*' },
    }));
    await context.routeWebSocket(/ws:\/\/127\.0\.0\.1:4782[3-7]\/ws/, ws => {
        socket = ws;
        ws.onMessage(data => {
            const message = JSON.parse(String(data));
            requests.push(message.type);
            if (message.type === 'tool.result') {
                assert(!answered.has(message.callId), 'A tool must never reply twice');
                answered.add(message.callId);
                const call = calls.get(message.callId);
                assert(call, 'A result must belong to a recorded tool call');
                calls.delete(message.callId);
                call.resolve(message.result);
                // Stop acknowledged cancellation, not tool completion. Deliberately keep this run
                // open until its in-flight tool replies, catching a silent drop in chatStore.
                if (cancelling && !calls.size) done(cancelling, 'cancelled');
                return;
            }
            const reply = result => ws.send(JSON.stringify({ type: 'response', reqId: message.reqId, ok: true, result }));
            switch (message.type) {
                case 'hello': reply({ version: '0.1.2', protocol: 1, platform: 'macos', sessionsDir: '/fixture-sessions' }); break;
                case 'agents.status': reply([{ agent: 'claude', installed: true, loggedIn: true, version: 'fixture', loginCommand: '', installCommand: '' }]); break;
                case 'models.list': reply([{ id: 'fixture', label: 'Fixture', efforts: [], defaultEffort: null, images: false, isDefault: true }]); break;
                case 'vault.sync': reply({ written: message.files.length, removed: 0 }); break;
                case 'run.start': runId = message.runId; runs++; reply({ accepted: true }); break;
                case 'run.cancel':
                    cancelling = message.runId;
                    reply({ cancelled: true });
                    if (!calls.size) done(cancelling, 'cancelled');
                    break;
                default: throw new Error(`Unexpected helper request ${message.type}`);
            }
        });
    });
    return {
        get ready() { return !!runId; },
        get runs() { return runs; },
        requests,
        call(args) {
            assert(socket && runId, 'A user-started run must exist before sending a tool call');
            const callId = `search-${++sequence}`;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => { calls.delete(callId); reject(new Error(`Tool ${callId} timed out`)); }, 20000);
                calls.set(callId, { resolve: result => { clearTimeout(timer); resolve(result); } });
                socket.send(JSON.stringify({ type: 'tool.call', runId, callId, name: 'vault_search', args }));
            });
        },
        finish() { if (runId) done(runId, 'ok'); },
    };
}

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
const targets = [];
const observation = { browser: browser.version(), pin, mode, arms: {}, errors, targets };
try {
    assert.equal(browser.version(), pin.version, 'The pinned engine is part of this gate identity');
    // No outside service receives fixture text or any request from the app.
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        return url.origin === origin || url.protocol === 'data:' || url.protocol === 'blob:'
            ? route.continue() : route.abort();
    });
    const helper = await helperStandIn(context);
    await context.addInitScript(() => {
        const grant = handle => {
            handle.queryPermission = async () => 'granted';
            handle.requestPermission = async () => 'granted';
            return handle;
        };
        const getDirectory = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
        FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) {
            return grant(await getDirectory.apply(this, args));
        };
        window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle('regex-fixture', { create: true }));
        window.__c07Frames = [];
        const frame = time => { window.__c07Frames.push(time); requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
        window.__c07MainRegex = 0;
        const exec = RegExp.prototype.exec;
        RegExp.prototype.exec = function (...args) {
            if (this.source === '(a+)+$') window.__c07MainRegex++;
            return exec.apply(this, args);
        };
        window.__c07Workers = [];
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
            constructor(...args) {
                super(...args);
                if (!String(args[0]).includes('matcher')) return;
                const info = this.__c07 = { url: String(args[0]), started: performance.now(), posts: [], replies: [] };
                window.__c07Workers.push(info);
                this.addEventListener('message', event => {
                    if (event.data?.id) info.replies.push({ id: event.data.id, at: performance.now() });
                });
            }
            postMessage(...args) {
                const m = args[0];
                if (this.__c07 && m?.op) this.__c07.posts.push({ id: m.id, op: m.op, path: m.args?.path, at: performance.now() });
                return super.postMessage(...args);
            }
            terminate() {
                if (this.__c07) { this.__c07.terminated = performance.now(); performance.mark('c07-worker-terminate'); }
                return super.terminate();
            }
        };
    });
    const cdp = await context.newCDPSession(page);
    cdp.on('Target.attachedToTarget', event => {
        if (event.targetInfo.type === 'worker') targets.push({ ...event.targetInfo, sessionId: event.sessionId, attached: Date.now() });
    });
    cdp.on('Target.detachedFromTarget', event => {
        const target = targets.find(t => t.sessionId === event.sessionId);
        if (target) target.detached = Date.now();
    });
    cdp.on('Target.targetInfoChanged', event => {
        const target = targets.find(t => t.targetId === event.targetInfo.targetId);
        if (target) target.url = event.targetInfo.url;
    });
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(origin);
    await page.evaluate(async ({ capped }) => {
        const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('regex-fixture', { create: true });
        const files = {
            'a-early.md': 'kept a', 'evil.md': 'a'.repeat(26) + '!', 'typing.md': 'Write here.',
            'controls.md': 'prefix echo echo suffix\n',
            'unicode.md': 'before αβ 💡\r\nnext line\r\n',
            'huge.md': 'X'.repeat(131072) + 'END',
            'limits.md': Array.from({ length: 51 }, () => 'a').join('\n'),
        };
        if (capped) {
            for (let i = 0; i < 6; i++) files[`a-cap-${i}.md`] = Array.from({ length: 49 }, () => 'q'.repeat(250) + 'a').join('\n');
        }
        for (const [name, text] of Object.entries(files)) {
            const handle = await folder.getFileHandle(name, { create: true });
            const writer = await handle.createWritable();
            await writer.write(text);
            await writer.close();
        }
    }, { capped: mode === 'output-cap' });
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    await page.locator('.tree-item').filter({ hasText: /^typing$/ }).click();
    await page.locator('.cm-content').waitFor();
    await page.keyboard.press('Meta+e');
    await page.keyboard.press('Meta+Shift+x');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Message the agent' });
    const editor = page.locator('.editor-slot .cm-content[contenteditable="true"]');
    await composer.waitFor();
    const startRun = async () => {
        const before = helper.runs;
        await composer.fill('Run the local search fixture.');
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await until(() => helper.runs > before, 'the real bridge starts a user message');
    };
    await startRun();
    const warm = await helper.call({ query: 'neverthere' });
    assert(!warm.isError && textOf(warm).includes('No matches'), 'The warm-cache bridge control must complete');

    if (mode === 'all' || mode === 'responsive') {
        await page.evaluate(() => { window.__c07Frames = []; });
        await page.waitForFunction(() => window.__c07Frames.length >= 8);
        const baselineGaps = await page.evaluate(() => window.__c07Frames.slice(1).map((time, i) => time - window.__c07Frames[i]));
        await page.evaluate(() => { window.__c07Frames = [performance.now()]; });
        const before = Date.now();
        let completed = false;
        const searching = helper.call({ query: '(a+)+$', regex: true }).then(result => { completed = true; return result; });
        await editor.click();
        await page.keyboard.type('Typed marker', { delay: 5 });
        const typedBeforeReply = !completed;
        const result = await searching;
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const gaps = await page.evaluate(() => window.__c07Frames.slice(1).map((time, i) => time - window.__c07Frames[i]));
        gaps.sort((a, b) => a - b);
        const arm = observation.arms.responsive = {
            durationMs: Date.now() - before, baselineGaps, gaps, maxGapMs: gaps.at(-1),
            p95GapMs: gaps[Math.floor(gaps.length * 0.95)], typedBeforeReply, typedText: await editor.innerText(), result,
            mainRegexCalls: await page.evaluate(() => window.__c07MainRegex),
        };
        await writeFile(resolve(output, 'responsive.json'), JSON.stringify(arm, null, 2));
        await page.screenshot({ path: resolve(output, 'responsive.png') });
        assert(typedBeforeReply && arm.typedText.includes('Typed marker'), 'Typing must land while matching is in flight');
        assert(arm.maxGapMs <= 100, `Query-caused RAF gap ${arm.maxGapMs} ms > 100 ms`);
        assert.equal(arm.mainRegexCalls, 0, 'Filename/content/snippet regex evaluations must all stay off the UI thread');
        assert(targets.some(t => t.url.includes('matcher')), 'A real matcher worker must have attached');
    }

    if (mode === 'all' || mode === 'deadline' || mode === 'stop' || mode === 'output-cap' || mode === 'long-query') {
        // A separate, native filesystem write invalidates the real cache. 34 a's is 256 times the
        // measured 26-a near miss's search space; the no-termination mutant also witnesses its tail.
        await page.evaluate(async () => {
            const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('regex-fixture');
            const handle = await folder.getFileHandle('evil.md');
            const writer = await handle.createWritable();
            await writer.write('a'.repeat(34) + '!');
            await writer.close();
        });
    }
    if (mode === 'all' || mode === 'deadline') {
        const worker = targets.findLast(t => t.url.includes('matcher') && !t.detached);
        assert(worker, 'A warm matcher target must exist before the hostile call');
        const tracing = await browser.newBrowserCDPSession();
        const traceComplete = new Promise(resolve => tracing.once('Tracing.tracingComplete', resolve));
        await tracing.send('Tracing.start', {
            transferMode: 'ReturnAsStream',
            traceConfig: { recordMode: 'recordContinuously', includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'blink.user_timing', 'toplevel', 'worker'] },
        });
        await page.evaluate(() => performance.mark('c07-deadline-call'));
        const before = Date.now();
        const result = await helper.call({ query: '(a+)+$', regex: true });
        const resultAt = Date.now();
        // The condition is CDP target lifetime, not a claimed terminate counter. On the mutant this
        // deliberately observes through 3× the budget before reporting the missing detach.
        try { await until(() => !!worker.detached, 'the matcher worker actually detaches', Math.max(1, before + 15000 - Date.now())); }
        catch (error) { observation.arms.deadlineDetachError = String(error); }
        let timeline;
        {
            await tracing.send('Tracing.end');
            const { stream } = await traceComplete;
            const pieces = [];
            let eof = false;
            while (!eof) {
                const chunk = await tracing.send('IO.read', { handle: stream });
                pieces.push(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString() : chunk.data);
                eof = chunk.eof;
            }
            await tracing.send('IO.close', { handle: stream });
            await writeFile(resolve(output, 'deadline-trace.json'), pieces.join(''));
            const events = JSON.parse(pieces.join('')).traceEvents;
            const identity = events.find(e => e.name === 'TracingSessionIdForWorker' && e.args?.data?.workerId === worker.targetId);
            assert(identity, 'The trace must identify the same CDP worker target and thread');
            const call = events.find(e => e.name === 'c07-deadline-call');
            const terminated = events.filter(e => e.name === 'c07-worker-terminate');
            const tasks = events.filter(e => e.ph === 'X' && e.name === 'RunTask' && e.pid === identity.pid && e.tid === identity.args.data.workerThreadId && e.ts >= call.ts);
            const last = tasks.reduce((best, task) => !best || task.ts + task.dur > best.ts + best.dur ? task : best, undefined);
            const longest = tasks.reduce((best, task) => !best || task.dur > best.dur ? task : best, undefined);
            timeline = {
                workerId: worker.targetId, workerThreadId: identity.args.data.workerThreadId,
                terminateCalls: terminated.length,
                terminateMs: terminated[0] ? (terminated[0].ts - call.ts) / 1000 : null,
                workerTaskEndMs: longest?.dur >= 4500000 && last ? (last.ts + last.dur - call.ts) / 1000 : null,
                longestTaskMs: longest?.dur / 1000, longestTaskCpuMs: longest?.tdur / 1000,
            };
        }
        const details = await page.evaluate(() => window.__c07Workers);
        const arm = observation.arms.deadline = { result, responseMs: resultAt - before, detachMs: worker.detached ? worker.detached - before : null, timeline, workers: details };
        await writeFile(resolve(output, 'deadline.json'), JSON.stringify(arm, null, 2));
        // c-lead ruling: Chromium keeps uncooperative JS on-core for kForcibleTerminationDelay
        // (2 s) after terminate(). Assert that real trace-bound CPU tail, never just the promise.
        assert(timeline.workerTaskEndMs !== null && timeline.workerTaskEndMs <= 8500, `Worker task ended at ${timeline.workerTaskEndMs} ms, beyond 5 s + 2 s engine grace + 1.5 s tolerance`);
        assert.equal(timeline.terminateCalls, 1, 'Terminate must be called exactly once on the timed-out worker');
        assert(timeline.terminateMs >= 4500 && timeline.terminateMs <= 6500, `Terminate called at ${timeline.terminateMs} ms, not the 5 s deadline`);
        assert(arm.responseMs >= 4500 && arm.responseMs <= 6500, `Partial response at ${arm.responseMs} ms, not the 5 s deadline`);
        assert(worker.detached && arm.detachMs <= 8500, 'No timed-out worker target may remain alive beyond the bounded engine grace');
        assert(textOf(result).includes('incomplete:true') && textOf(result).includes('the pattern took too long'), 'Timeout must be an explicit incomplete answer');
        assert(textOf(result).includes('a-early.md:1: kept a'), 'Acknowledged earlier results must survive timeout');
        assert(!textOf(result).includes('No matches'), 'Zero/partial timeout is never a complete no-matches answer');
        const card = page.locator('.agent-tool').filter({ hasText: '(a+)+$' }).last();
        await card.locator('.agent-tool-row').click();
        await card.getByText(/the pattern took too long/).waitFor();
        assert((await card.innerText()).includes('a-early.md:1: kept a'), 'The reader sees the acknowledged partial matches too');
        await page.screenshot({ path: resolve(output, 'deadline-ui.png') });
        await card.locator('.agent-tool-row').click();
        const next = await helper.call({ query: 'kept', path: 'a-early.md' });
        arm.next = next;
        assert(!next.isError && textOf(next).includes('a-early.md:1: kept a'), 'The next literal search must still use the intact cache');
    }
    if (mode === 'all' || mode === 'stop') {
        const beforePosts = await page.evaluate(() => window.__c07Workers.reduce((n, worker) => n + worker.posts.filter(p => p.op === 'batch' && p.path === 'evil.md').length, 0));
        let replied = false;
        const searching = helper.call({ query: '(a+)+$', regex: true }).then(result => { replied = true; return result; });
        await page.waitForFunction(before => window.__c07Workers.reduce((n, worker) => n + worker.posts.filter(p => p.op === 'batch' && p.path === 'evil.md').length, 0) > before, beforePosts);
        await editor.click();
        await page.keyboard.type('Stop marker', { delay: 5 });
        assert(!replied, 'Stop must be exercised during an actual outstanding hostile match');
        const worker = targets.findLast(t => t.url.includes('matcher') && !t.detached);
        assert(worker, 'Stop requires a live real worker target');
        const before = Date.now();
        await page.getByRole('button', { name: 'Stop', exact: true }).click();
        const result = await searching;
        const responseMs = Date.now() - before;
        await until(() => !!worker.detached && !helper.ready, 'Stop terminates its worker and the helper finishes');
        const arm = observation.arms.stop = { responseMs, cleanupMs: Date.now() - before, result, detached: worker.detached };
        assert(responseMs < 1000, `Stop's tool result settled in ${responseMs} ms`);
        assert(arm.cleanupMs <= 3500, `Stop left its worker alive beyond Chromium's 2 s grace + tolerance: ${arm.cleanupMs} ms`);
        assert(textOf(result).includes('incomplete:true') && textOf(result).includes('the search was cancelled'), 'The still-waiting helper gets an honest cancellation, not silence');
        await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden' });
        await startRun();
    }
    if (mode === 'all' || mode === 'controls') {
        const cases = [
            { name: 'backreference-lookaround', args: { query: '(?<=prefix )([a-z]+) \\1(?= suffix)', regex: true, path: 'controls.md' }, want: 'controls.md:1: prefix echo echo suffix' },
            { name: 'empty-anchor', args: { query: '^$', regex: true, path: 'controls.md' }, want: 'controls.md:2: ' },
            { name: 'filename', args: { query: '^controls\\.md$', regex: true }, want: 'controls.md (file name matches)' },
            { name: 'unicode-crlf', args: { query: 'αβ 💡', path: 'unicode.md' }, want: 'unicode.md:1: before αβ 💡' },
            { name: 'huge-single-line', args: { query: 'END$', regex: true, path: 'huge.md' }, want: `huge.md:1: …${'X'.repeat(100)}END…` },
            { name: 'per-file-cap', args: { query: '^a$', regex: true, path: 'limits.md' }, want: 'limits.md: …more matches in this file' },
            { name: 'max-results', args: { query: '^a$', regex: true, path: 'limits.md', maxResults: 2 }, want: '…[stopped at maxResults=2;' },
        ];
        const controls = observation.arms.controls = [];
        for (const control of cases) {
            const result = await helper.call(control.args);
            controls.push({ ...control, result });
            assert(!result.isError && textOf(result).includes(control.want), `Original semantics: ${control.name}`);
        }
        const syntax = await helper.call({ query: '(', regex: true });
        controls.push({ name: 'syntax', result: syntax });
        assert(syntax.isError && textOf(syntax).includes('Invalid regular expression') && textOf(syntax).includes('Unterminated group'), 'Native JavaScript syntax error must be preserved');
        await writeFile(resolve(output, 'controls.json'), JSON.stringify(controls, null, 2));
        const original = JSON.parse(await readFile(new URL('./original-controls.json', import.meta.url), 'utf8'));
        assert.deepEqual(controls.map(c => ({ name: c.name, result: c.result })), original.map(c => ({ name: c.name, result: c.result })), 'All tool-result bytes must match the original main-thread implementation on this fixture');
        observation.controlsEqualOriginal = true;
    }
    if (mode === 'output-cap') {
        const result = await helper.call({ query: '(a+)+$', regex: true, maxResults: 500 });
        const text = textOf(result);
        observation.arms.outputCap = { result, chars: text.length };
        assert(text.includes('295 matches in 7 files'), 'The app must acknowledge the >60k partial-output fixture before the hostile file');
        assert(text.includes('a-cap-0.md:1:'), 'Actual acknowledged output must reach the tool result');
        assert(text.includes('incomplete:true') && text.includes('the pattern took too long'), 'Timeout must retain its incomplete marker even when the normal output cap truncates matches');
    }
    if (mode === 'long-query') {
        const query = '(a+)+$' + '(?:)'.repeat(17000);
        const result = await helper.call({ query, regex: true });
        const text = textOf(result);
        observation.arms.longQuery = { result, chars: text.length, queryChars: query.length };
        assert(!result.isError && text.includes('1 match in 1 file'), 'The long valid pattern must reach the hostile line after an acknowledged match');
        assert(text.startsWith('…[incomplete:true; the pattern took too long]'), 'An unbounded query header must not crowd out the incomplete status');
    }
    observation.helperRequests = helper.requests;
    observation.workerObservation = await page.evaluate(() => window.__c07Workers);
    helper.finish();
    assert.equal(errors.length, 0, `Page errors: ${errors.join('; ')}`);
    await page.screenshot({ path: resolve(output, 'final.png') });
    console.log(JSON.stringify(observation));
} catch (error) {
    observation.failure = String(error);
    await page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {});
    console.error(JSON.stringify(observation));
    throw error;
} finally {
    await writeFile(resolve(output, 'observation.json'), JSON.stringify(observation, null, 2));
    await browser.close();
}
