// t21's timing-floor evidence, step 3 ONLY. Not a gate, baseline or preflight bound.
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openVaultAdapter } from '../lib/bench/browser.mjs';
import { acquireBenchLock, scratch } from '../lib/bench/lock.mjs';
import { machineSnapshot, sessionValidity } from '../lib/bench/machine.mjs';
import { inspectProcessOwnership } from '../lib/bench/environment.mjs';
import { noteOpenDefinition } from '../lib/bench/noteOpenMetric.mjs';
import { publishOpeningCalibration } from '../lib/bench/windowCalibration.mjs';
import { collectAgentRoots, startCPUMeasurement } from '../lib/bench/cpuMeasurement.mjs';
import { median, percentile, quantileInterval, shiftInterval, summarize } from '../lib/bench/stats.mjs';

const [distArg = join(scratch, 'v-c/dist'), countArg = '20', outputArg = join(scratch, 'measure/note-open-calibration-20.json'), mode = 'window'] = process.argv.slice(2);
if (!['window', 'exploratory'].includes(mode)) throw new Error('Explicit window/exploratory mode required');
const count = Number(countArg);
if (!Number.isInteger(count) || count < 10 || count > 40 || count % 2) throw new Error('Use an even session count per arm in [10,40]');
const dist = resolve(distArg);
const output = resolve(outputArg);
if (!output.startsWith(`${scratch}/`)) throw new Error('Calibration output must stay in run scratch');
if (mode === 'window' && count < 20) throw new Error('Window opening calibration requires20+20');
const serialise = value => JSON.stringify(value, (_key, x) => typeof x === 'number' && !Number.isFinite(x) ? String(x) : x, 4) + '\n';
const halfWidth = interval => (interval.upper - interval.lower) / 2;
const relativeMetric = { name: 'noteOpenToPaintMs', unit: 'ms', rule: 'no-regression', comparison: 'relative', threshold: 0.05, lowerIsBetter: true };
const floorBytes = 6 * 1024 ** 3;
const lock = await acquireBenchLock(mode === 'window' ? 'accepted' : 'exploratory');
const artifacts = join(scratch, 'v-c/floor-calibration', `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
let adapter, ownsOutput = false;
const report = { schema: 2, purpose: 'metric-version opening calibration', mode, metricDefinition: noteOpenDefinition,
    status: 'calibration-running-NOT-A-GATE',
    label: mode === 'exploratory' ? 'EXPLORATORY, MACHINE SHARED: no accepted floor, bound or gate verdict' : 'Window calibration under session bounds1–5; new floors are recorded, never compared with themselves',
    started: new Date().toISOString(), temperature: 'cold', sessionsPerArm: count, totalPlannedSessions: count * 2,
    memoryFloorBytes: floorBytes, lock: lock.holder, artifacts, sessions: [],
    classification: 'Bench=runner PID tree. Agent roots from hc; other runtimes never inherit agent status. Window mode enforces amendment session bounds1–5, no aggregate CPU cutoff. Exploratory machine-invalid samples are labelled development-only; swaps are never averaged.',
    limitations: ['No gate verdict, no baseline and no preflight bound is established by this experiment.',
        'Note-open latency is NOT autosave main-thread CPU; absolute1ms projections do not certify that save gate.',
        'Root-n projections are planning estimates under a regular location model, NOT distribution-free confidence intervals for unobserved sample counts.',
        'CPU accounting can overestimate outside CPU when short-lived bench processes exit between samples. Raw observations and CDP CPU readouts are retained.'] };
async function persist() {
    const temp = `${output}.${process.pid}.tmp`;
    await writeFile(temp, serialise(report)); await rename(temp, output);
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
    await mkdir(dirname(output), { recursive: true });
    const handle = await open(output, 'wx'); await handle.close(); ownsOutput = true;
    report.sources = await Promise.all([
        fileURLToPath(import.meta.url),
        ...['browser.mjs', 'cpuMeasurement.mjs', 'machine.mjs', 'stats.mjs', 'lock.mjs', 'environment.mjs', 'noteOpenMetric.mjs', 'windowCalibration.mjs', 'metricFloors.mjs', 'benchProcesses.mjs'].map(name => fileURLToPath(new URL(`../lib/bench/${name}`, import.meta.url))),
    ].map(async path => ({ path, source: await readFile(path, 'utf8') })));
    report.agentRoots = await collectAgentRoots();
    const machineOptions = { agentRoots: report.agentRoots, grantPid: lock.holder.grant.grant.pid };
    adapter = await openVaultAdapter({ mode: 'calibration', metricDefinition: noteOpenDefinition,
        arms: { A: { dist }, B: { dist } }, methodCheck: true }, artifacts);
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
            const session = { id, arm, retry, artifacts: dir, before: await machineSnapshot(machineOptions) };
            report.sessions.push(session);
            const cpu = await startCPUMeasurement(report.agentRoots, sample => inspectProcessOwnership(sample, machineOptions.grantPid));
            try {
                session.measurement = await adapter.measure({ arm, artifacts: dir, temperature: 'cold' });
            } finally {
                session.cpu = await cpu.stop(session.measurement);
                session.after = await machineSnapshot(machineOptions);
            }
            session.validity = sessionValidity(session.before, session.after, { memoryFloorBytes: floorBytes, maxLoad: 3 }, session.cpu);
            session.usedForExploration = mode === 'exploratory' && !session.validity.valid && session.validity.swapins === 0 && !session.cpu.samplingError;
            await lock.assertHeld();
            if (session.validity.valid || session.usedForExploration) { arms[arm].push(session.measurement.values[0]); completed = true; }
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
    report.status = mode === 'window' ? 'calibration-complete-NOT-A-GATE' : 'exploratory-complete-MACHINE-SHARED';
    if (mode === 'window') report.windowOpening = await publishOpeningCalibration(lock, report, output);
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
