// Offline analysis of real-browser evidence, not a code test or a new timing run.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { median } from '../lib/bench/stats.mjs';
import { scratch } from '../lib/bench/lock.mjs';
const input = resolve(process.argv[2] ?? join(scratch, 'measure/floor-3-calibration.json'));
const out = resolve(process.argv[3] ?? join(scratch, 'v-c/reports/bimodality'));
const bytes = await readFile(input), calibration = JSON.parse(bytes);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const output = { purpose: 'Offline diagnosis; no metric definition/threshold changed', input, inputSha256: sha(bytes),
    analysisSource: fileURLToPath(import.meta.url), rows: [], groups: {},
    driverSource: { version: 'playwright-core@1.63.0', file: 'node_modules/playwright-core/lib/coreBundle.js',
        references: ['lines20199–20252: pointer actions wait for visible/enabled/stable',
            'injected source line19837: _checkElementIsStable requests RAF until stable count; <15ms skip only when stableRafCount>1',
            'lines37464–37466: Chromium stableRafCount=1', 'lines23989–24022: locator retry backoff20/50/100/...ms'] } };
function unionMs(events, from, to) {
    const intervals = events.map(e => [Math.max(from, e.ts), Math.min(to, e.ts + e.dur)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
    let sum = 0, end = -Infinity;
    for (const [a, b] of intervals) { sum += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
    return sum / 1000;
}
for (const session of calibration.sessions.filter(s => s.validity.valid && s.measurement)) {
    const measure = session.measurement, traceBytes = await readFile(measure.trace);
    const events = JSON.parse(traceBytes).traceEvents;
    const start = events.find(e => e.name === 'bme-open-vault-start');
    const end = events.find(e => e.name === 'bme-first-note-paint');
    if (!start || !end) throw new Error(`Existing trace has no metric marks: ${session.id}`);
    const main = events.filter(e => e.pid === start.pid && e.tid === start.tid && e.ts >= start.ts && e.ts <= end.ts).sort((a, b) => a.ts - b.ts);
    const clicks = main.filter(e => e.name === 'EventDispatch' && e.args?.data?.type === 'click');
    const noteClick = clicks.find(e => e.ts > start.ts + 1000);
    const marked = main.find(e => e.name === 'EventDispatch' && e.args?.data?.type === '__playwright_mark_target__');
    const driverRafs = main.filter(e => e.name === 'FunctionCall' && e.args?.data?.functionName === 'raf'
        && e.args?.data?.lineNumber === 7339 && e.ts < (noteClick?.ts ?? end.ts));
    const editorPaint = main.find(e => e.name === 'Paint' && /class='cm-(?:editor|scroller)/.test(e.args?.data?.nodeName ?? ''));
    const relative = event => event ? (event.ts - start.ts) / 1000 : null;
    const appCalls = main.filter(e => e.name === 'FunctionCall' && Number.isFinite(e.dur) && e.args?.data?.url?.startsWith('http://127.0.0.1:'));
    output.rows.push({ id: session.id, arm: session.arm, openToPaintMs: measure.values[0],
        group: measure.values[0] < 110 ? 'fast' : measure.values[0] < 120 ? 'intermediate' : 'main',
        trace: measure.trace, traceSha256: sha(traceBytes), firstNoteClickMs: relative(noteClick), targetMarkedMs: relative(marked),
        driverStableRafCallsMs: driverRafs.map(relative),
        driverStableRafGapMs: driverRafs.length >= 2 ? (driverRafs.at(-1).ts - driverRafs[0].ts) / 1000 : null,
        firstEditorPaintMs: relative(editorPaint),
        clickToEditorPaintMs: noteClick && editorPaint ? (editorPaint.ts - noteClick.ts) / 1000 : null,
        paintToReadoutMs: editorPaint ? (end.ts - editorPaint.ts) / 1000 : null,
        observerRafCount: measure.observation.rafTimes.length,
        appFunctionUnionMs: unionMs(appCalls, start.ts, end.ts),
        maxAppFunctionMs: Math.max(0, ...appCalls.map(e => e.dur / 1000)),
        timerFires: main.filter(e => e.name === 'TimerFire').map(e => ({ t: relative(e), data: e.args?.data })),
        idleCallbacks: main.filter(e => e.name === 'FireIdleCallback').map(e => ({ t: relative(e), durationMs: e.dur / 1000 })),
        resourceEvents: events.filter(e => e.ts >= start.ts && e.ts <= end.ts && /^Resource(?:SendRequest|ReceiveResponse|ReceivedData|Finish)$/.test(e.name))
            .map(e => ({ t: relative(e), name: e.name, data: e.args?.data })),
    });
}
for (const group of ['fast', 'intermediate', 'main']) {
    const rows = output.rows.filter(r => r.group === group);
    const fields = ['openToPaintMs', 'firstNoteClickMs', 'targetMarkedMs', 'driverStableRafGapMs',
        'firstEditorPaintMs', 'clickToEditorPaintMs', 'paintToReadoutMs', 'appFunctionUnionMs', 'maxAppFunctionMs'];
    output.groups[group] = { count: rows.length,
        ...Object.fromEntries(fields.map(field => {
            const values = rows.map(r => r[field]).filter(x => x !== null);
            return [field, values.length ? { min: Math.min(...values), median: median(values), max: Math.max(...values) } : null];
        })),
        driverRafGapsMs: rows.map(r => r.driverStableRafGapMs),
        totalTimerFires: rows.reduce((sum, r) => sum + r.timerFires.length, 0),
        totalResourceEvents: rows.reduce((sum, r) => sum + r.resourceEvents.length, 0) };
}
await mkdir(out, { recursive: true });
await writeFile(join(out, 'analysis.json'), JSON.stringify(output, null, 4) + '\n');
await writeFile(join(out, 'analysis.md'), '# Existing cold-control trace segmentation\n\nOffline analysis only; no replacement metric applied.\n\n'
    + '| ID | Mode | Metric | Note click | PW target | PW stable RAF gap | First editor paint | Paint→readout | App JS union |\n|---|---|---:|---:|---:|---:|---:|---:|---:|\n'
    + output.rows.map(r => `| ${r.id} | ${r.group} | ${r.openToPaintMs.toFixed(3)} | ${r.firstNoteClickMs?.toFixed(3)} | ${r.targetMarkedMs?.toFixed(3)} | ${r.driverStableRafGapMs?.toFixed(3)} | ${r.firstEditorPaintMs?.toFixed(3)} | ${r.paintToReadoutMs?.toFixed(3)} | ${r.appFunctionUnionMs.toFixed(3)} |`).join('\n')
    + '\n\nAll times milliseconds from the Open Vault click mark. App JS union is diagnostic FunctionCall interval union, NOT top-level task CPU and NOT a save metric. Raw trace paths, hashes, timers/resources and group ranges are in analysis.json.\n');
console.log(join(out, 'analysis.json'));
