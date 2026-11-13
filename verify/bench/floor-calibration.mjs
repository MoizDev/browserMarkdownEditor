// t21's timing-floor evidence, step 3 ONLY. Not a gate, baseline or preflight bound.
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openVaultAdapter } from '../lib/bench/browser.mjs';
import { acquireBenchLock, scratch } from '../lib/bench/lock.mjs';
import { machineSnapshot } from '../lib/bench/machine.mjs';
import { collectAgentRoots, startCPUMeasurement } from '../lib/bench/cpuMeasurement.mjs';
import { median, percentile, quantileInterval, shiftInterval, summarize } from '../lib/bench/stats.mjs';

const [distArg = join(scratch, 'v-c/dist'), countArg = '20'] = process.argv.slice(2);
const count = Number(countArg);
if (!Number.isInteger(count) || count < 10 || count > 40 || count % 2) throw new Error('Use an even session count per arm in [10,40]');
const dist = resolve(distArg);
const output = join(scratch, 'measure/floor-3-calibration.json');
const serialise = value => JSON.stringify(value, (_key, x) => typeof x === 'number' && !Number.isFinite(x) ? String(x) : x, 4) + '\n';
const halfWidth = interval => (interval.upper - interval.lower) / 2;
const relativeMetric = { name: 'openToPaintMs', unit: 'ms', rule: 'no-regression', comparison: 'relative', threshold: 0.05, lowerIsBetter: true };
const floorBytes = 6 * 1024 ** 3;
const lock = await acquireBenchLock('accepted');
const artifacts = join(scratch, 'v-c/floor-calibration', `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
let adapter, ownsOutput = false;
const report = { schema: 1, purpose: 't21 timing-floor evidence, step 3', status: 'calibration-running-NOT-A-GATE',
    started: new Date().toISOString(), temperature: 'cold', sessionsPerArm: count, totalPlannedSessions: count * 2,
    memoryFloorBytes: floorBytes, lock: lock.holder, artifacts, sessions: [],
    classification: 'Bench = runner PID tree, including Chrome, inline server and sampler. Agent roots come from hc live pi/claude-code/codex terminals; other node/build/browser/VM never inherits agent status. All non-bench CPU is outside; no CPU/load cutoff applied.',
    limitations: ['No gate verdict, no baseline and no preflight bound is established by this experiment.',
        'Open Vault wall-clock latency is NOT the autosave main-thread CPU metric; absolute 1ms projections below do not certify that save gate.',
        'Root-n projections are planning estimates under a regular location model, NOT distribution-free confidence intervals for unobserved sample counts.',
        'CPU accounting can overestimate outside CPU when short-lived bench processes exit between samples. Raw observations and CDP CPU readouts are retained.'] };
async function persist() {
    const temp = `${output}.${process.pid}.tmp`;
    await writeFile(temp, serialise(report)); await rename(temp, output);
}
function validity(before, after, cpu) {
    // The experiment measures the load/CPU floor, so neither is an exclusion.
    // Retain the already-agreed non-load safeguards; never mix swapped sessions.
    const causes = [];
    for (const [phase, sample] of [['before', before], ['after', after]]) {
        if (sample.freeBytes === null || sample.freeBytes < floorBytes) causes.push(`${phase}: free memory below/unreadable at 6GiB floor`);
        if (sample.powerSource !== 'AC') causes.push(`${phase}: AC power required`);
        if (sample.throttled) causes.push(`${phase}: thermal/performance throttling`);
    }
    const swapins = before.pages.swapins === null || after.pages.swapins === null ? null : after.pages.swapins - before.pages.swapins;
    if (swapins !== 0) causes.push(`swap-in delta ${swapins} (zero required)`);
    if (cpu.samplingError) causes.push(`CPU measurement unavailable: ${cpu.samplingError}`);
    return { valid: causes.length === 0, causes, swapins,
        loadAndCPU: 'Recorded as experimental evidence, not gated; the preflight bound awaits vr-lead amendment.' };
}
function descriptive(values) {
    const lowerQuartile = percentile(values, 0.25), upperQuartile = percentile(values, 0.75);
    return { count: values.length, median: median(values), lowerQuartile, upperQuartile, iqr: upperQuartile - lowerQuartile,
        min: Math.min(...values), max: Math.max(...values) };
}
function inference(a, b) {
    const arms = { A: a.map(x => ({ values: [x] })), B: b.map(x => ({ values: [x] })) };
    const corrected = summarize(arms, relativeMetric, { looks: 10 });
    return { sampleCountPerArm: a.length,
        relativeHL95: shiftInterval(a, b, { relative: true }),
        absoluteHL95Ms: shiftInterval(a, b),
        median95: { A: quantileInterval(a), B: quantileInterval(b) },
        // Discard the gate-shaped verdict: this experiment supplies evidence,
        // not acceptance. Keep precisely the V-04 corrected interval/width.
        v04CorrectedRelative: { interval: corrected.interval, halfWidth: corrected.halfWidth,
            requiredHalfWidth: corrected.requiredHalfWidth, plannedLooks: 10 } };
}
try {
    await mkdir(artifacts, { recursive: true });
    await mkdir(join(scratch, 'measure'), { recursive: true });
    const handle = await open(output, 'wx'); await handle.close(); ownsOutput = true;
    report.sources = await Promise.all([
        fileURLToPath(import.meta.url),
        ...['browser.mjs', 'cpuMeasurement.mjs', 'machine.mjs', 'stats.mjs', 'lock.mjs'].map(name => fileURLToPath(new URL(`../lib/bench/${name}`, import.meta.url))),
    ].map(async path => ({ path, source: await readFile(path, 'utf8') })));
    report.agentRoots = await collectAgentRoots();
    adapter = await openVaultAdapter({ mode: 'calibration', arms: { A: { dist }, B: { dist } }, methodCheck: true }, artifacts);
    report.identities = adapter.identities; report.browserPin = adapter.browserPin; report.driverVersion = adapter.driverVersion;
    if (adapter.identities.A.sha256 !== adapter.identities.B.sha256) throw new Error('Control arms must be the same build');
    await persist();
    const arms = { A: [], B: [] };
    while (arms.A.length < count || arms.B.length < count) {
        const arm = ['A', 'B', 'B', 'A'][(arms.A.length + arms.B.length) % 4];
        let completed = false;
        for (let retry = 0; retry < 3; retry++) {
            await lock.assertHeld();
            const id = String(report.sessions.length + 1).padStart(3, '0');
            const dir = join(artifacts, id); await mkdir(dir);
            const session = { id, arm, retry, artifacts: dir, before: await machineSnapshot() };
            report.sessions.push(session);
            const cpu = await startCPUMeasurement(report.agentRoots);
            try {
                session.measurement = await adapter.measure({ arm, artifacts: dir, temperature: 'cold' });
            } finally {
                session.cpu = await cpu.stop(session.measurement);
                session.after = await machineSnapshot();
            }
            session.validity = validity(session.before, session.after, session.cpu);
            await lock.assertHeld();
            if (session.validity.valid) { arms[arm].push(session.measurement.values[0]); completed = true; }
            await persist();
            if (completed) break;
        }
        if (!completed) throw new Error('Memory/power/swap/CPU-measurement invalidity exhausted this calibration slot; raw attempts retained');
    }
    await adapter.recheck();
    for (const source of report.sources) {
        if (await readFile(source.path, 'utf8') !== source.source) throw new Error('Measurement source changed during calibration');
    }
    report.samples = arms;
    report.descriptiveMs = { A: descriptive(arms.A), B: descriptive(arms.B), pooled: descriptive([...arms.A, ...arms.B]) };
    report.observed = [10, 20, 40].filter(n => n <= count).map(n => inference(arms.A.slice(0, n), arms.B.slice(0, n)));
    const observed = inference(arms.A, arms.B);
    report.projections = [10, 20, 40].map(n => {
        // Root-n location-estimator scaling: van der Vaart, Asymptotic
        // Statistics (1998), quantile asymptotic normality. This is NOT a
        // replacement for V-04's exact ranks on actual sessions at that n.
        const scale = Math.sqrt(count / n);
        return { sessionsPerArm: n, anchorSessionsPerArm: count, planningOnly: true, scale,
            relativeHL95HalfWidth: halfWidth(observed.relativeHL95) * scale,
            absoluteHL95HalfWidthMs: halfWidth(observed.absoluteHL95Ms) * scale,
            median95HalfWidthMs: { A: halfWidth(observed.median95.A) * scale, B: halfWidth(observed.median95.B) * scale },
            v04CorrectedRelativeHalfWidth: observed.v04CorrectedRelative.halfWidth * scale,
            requiredNoRegressionHalfWidth: 0.05 / 3, requiredSaveAbsoluteHalfWidthMs: 1 / 3,
            savePrecision: 'NOT measured: this workload opens a note, it does not autosave the mixed 10000-line note.' };
    });
    report.status = 'calibration-complete-NOT-A-GATE';
} catch (error) {
    report.status = 'calibration-incomplete-NOT-A-GATE'; report.error = error.stack;
    process.exitCode = 1;
} finally {
    try { await adapter?.close(); }
    catch (error) { report.status = 'calibration-incomplete-NOT-A-GATE'; report.error = `${report.error ?? ''}\nCleanup: ${error.stack}`; process.exitCode = 1; }
    finally {
        report.finished = new Date().toISOString();
        try { if (ownsOutput) await persist(); }
        finally { await lock.release(); }
    }
}
console.log(output);
