import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquireBenchLock, scratch } from './lock.mjs';
import { machineIdentity, machineSnapshot, sessionValidity } from './machine.mjs';
import { sessionSchedule, summarize } from './stats.mjs';
import { collectAgentRoots, startCPUMeasurement } from './cpuMeasurement.mjs';
import { inspectProcessOwnership } from './environment.mjs';
import { windowCalibration } from './windowCalibration.mjs';

const json = value => JSON.stringify(value, (_key, x) => typeof x === 'number' && !Number.isFinite(x) ? String(x) : x, 2);
const hash = value => createHash('sha256').update(json(value)).digest('hex');
async function atomicWrite(path, text) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, text); await rename(temporary, path);
}
function configuration(config) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(config.gate)) throw new Error('Gate name must be a lowercase slug');
    if (!['exploratory', 'accepted'].includes(config.mode)) throw new Error('Explicit mode required');
    if (!['cold', 'warm'].includes(config.temperature)) throw new Error('Explicit cold/warm temperature required');
    if (!config.scriptFiles?.length) throw new Error('Record the actual gate and adapter source files, not only a verbal input script');
    if (!(config.metric.threshold > 0) || !Number.isFinite(config.metric.threshold)) throw new Error('Declare a finite positive precision/pass threshold before running');
    if (!['target', 'no-regression', 'improvement'].includes(config.metric.rule)) throw new Error('Unknown pass rule');
    if (!['absolute', 'relative'].includes(config.metric.comparison)) throw new Error('Explicit comparison scale required');
    if (config.metric.comparison === 'relative' && config.metric.rule === 'no-regression' && config.metric.threshold !== 0.05) {
        throw new Error('Relative no-regression bound is fixed at 5%, never tuned to pass');
    }
    if (config.metric.rule === 'no-regression' && config.metric.comparison === 'absolute' && !config.metric.resolutionJustification) {
        throw new Error('Absolute floor requires a predeclared reason why 5% is below measurement resolution');
    }
    if (config.metric.rule === 'target' && !Number.isFinite(config.metric.target)) throw new Error('Finite target required');
    if (config.metric.percentile !== undefined && !(config.metric.percentile > 0 && config.metric.percentile <= 1)) throw new Error('Percentile must be in (0, 1]');
    if (config.metric.rule === 'target' && config.metric.lowerIsBetter === false) throw new Error('Target rule requires a cost metric (upper bound <= target)');
    for (const name of ['inputScript', 'witness', 'identity', 'mutant', 'falsePass', 'losses']) {
        if (!config[name]?.length) throw new Error(`Missing gate contract: ${name}`);
    }
}
async function validateMeasurement(measurement, expectedVersion) {
    if (!measurement.witness || !measurement.browserVersion?.includes(expectedVersion)) throw new Error('Missing session witness or browser identity mismatch');
    if (!measurement.values?.length || measurement.values.some(x => !Number.isFinite(x))) throw new Error('Nonfinite/empty metric samples');
    const captures = measurement.captures ?? [];
    try {
        if (!captures.length || !measurement.trace) throw new Error('Capture/trace not supplied by the adapter');
        for (const path of [...captures, measurement.trace]) {
            if (!(await stat(path)).size) throw new Error(`Empty capture: ${path}`);
        }
    } catch (error) { error.invalidCause = `missing capture: ${error.message}`; throw error; }
}
function reportMarkdown(report) {
    const r = report.result;
    return `# ${report.gate}: ${report.status}\n\n${report.mode === 'exploratory' ? '**EXPLORATORY, MACHINE SHARED — not an accepted timing or pass.**' : 'Accepted-window run; a fail or inconclusive result is never a pass.'}\n\n`
        + `- Run: ${report.id}\n- Purpose: ${report.purpose ?? 'preparing'}\n- Temperature: ${report.temperature}\n- Build A: ${report.identities?.A.sha256}\n- Build B: ${report.identities?.B.sha256}\n`
        + `- Memory floor: ${report.policy.memoryFloorBytes} bytes; load limit: ${report.policy.maxLoad}\n`
        + `- Schedule: ${report.schedule.join(', ')} valid sessions per arm; ${report.plannedLooks} planned looks (including one fixed-size, single-analysis confirmation).\n`
        + `- Inference: Bonferroni across planned looks gives simultaneous >=95% coverage under adaptive width stopping.\n`
        + `- Noise report: ${report.noiseReport ?? 'same-build noise recording / exploratory'}\n- Confirmation of: ${report.confirmationOf ?? 'none'}\n`
        + `- Valid/invalid sessions: ${report.sessions.filter(x => x.validity?.valid && x.measurement).length}/${report.sessions.filter(x => !x.validity?.valid).length}\n`
        + (r ? `- Counts: A=${r.counts.A}, B=${r.counts.B}\n- Medians: A=${r.medians.A}, B=${r.medians.B}\n`
            + `- Estimate: ${r.interval.estimate}; interval [${r.interval.lower}, ${r.interval.upper}]\n`
            + `- Half-width: ${r.halfWidth}; required <= ${r.requiredHalfWidth}\n`
            + `- Fixed-n uncorrected 95% result (diagnostic only): ${report.uncorrected?.status}; interval [${report.uncorrected?.interval.lower}, ${report.uncorrected?.interval.upper}]\n`
            + `- Correction alone prevented decision: ${report.correctionPreventedDecision}\n` : '')
        + (report.confirmationIndependent ? `- Independent confirmation: ${report.confirmationIndependent.status}; interval [${report.confirmationIndependent.interval.lower}, ${report.confirmationIndependent.interval.upper}]\n- Confirmation requires BOTH independent and pooled passes; only the independent fixed-n step carries the guarantee.\n` : '')
        + `\n## Gate contract\n\n${['witness', 'identity', 'mutant', 'falsePass'].map(k => `- ${k}: ${report.contract[k]}`).join('\n')}\n`
        + `\n## Losses / not covered\n\n${report.contract.losses.map(x => `- ${x}`).join('\n')}\n`
        + `\n## Invalid sessions (never used for accepted inference; exploratory fits are development only)\n\n${report.sessions.filter(x => !x.validity?.valid).map(x => `- ${x.id} (${x.arm}): ${x.validity?.causes.join('; ') ?? x.error}`).join('\n') || 'None.'}\n`
        + `\n## Invalid-session top CPU consumers\n\n${report.sessions.filter(x => !x.validity?.valid).map(x => `- ${x.id}, start load ${x.before?.load?.[0]}: ${(x.before?.environment?.topConsumers ?? []).slice(0, 5).map(p => `${p.pid} ${p.comm} ${p.pcpu}% (${p.role})`).join('; ')}`).join('\n') || 'None.'}\n`
        + `\n## Session values\n\n| Session | Arm | Metric | Valid | Cause |\n|---|---|---:|---|---|\n`
        + report.sessions.map(s => `| ${s.id} | ${s.arm} | ${s.measurement?.values.join(', ') ?? '—'} | ${s.validity?.valid ?? false} | ${(s.validity?.causes ?? [s.error]).filter(Boolean).join('; ').replaceAll('|', '/')} |`).join('\n')
        + `\n\nAll raw data, machine readings, script, inference history, captures and traces are linked in report.json. No discarded attempt is omitted.\n`
        + (report.error ? `\n## Error\n\n${report.error}\n` : '');
}
function eligibleConfirmation(report) {
    if (report.status !== 'fail' || report.error || report.confirmationOf || !report.result?.precise) return false;
    const { interval, halfWidth } = report.result, metric = report.analysisMetric ?? report.metric;
    const excess = metric.rule === 'target' ? interval.upper - metric.target
        : metric.rule === 'no-regression' ? metric.lowerIsBetter !== false ? interval.upper - metric.threshold : -metric.threshold - interval.lower
            : -interval.lower;
    return excess >= 0 && excess < halfWidth;
}
export async function runBenchmark(config, adapterFactory) {
    configuration(config);
    const lock = await acquireBenchLock(config.mode);
    const id = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const gateRoot = join(scratch, 'v-c/reports', config.gate), dir = join(gateRoot, id);
    const schedule = sessionSchedule(Boolean(config.metric.percentile));
    // vr-lead ruling: one fixed-size confirmation, decided before its first new
    // session, analyzed once after pooling. Its size equals the first final count.
    const plannedLooks = schedule.length + 1;
    const policy = { memoryFloorBytes: 6 * 1024 ** 3, maxLoad: 3, maxInvalidPerSlot: 3, ...config.machinePolicy };
    if (!Number.isFinite(policy.memoryFloorBytes) || !Number.isFinite(policy.maxLoad)
        || policy.memoryFloorBytes < 6 * 1024 ** 3 || policy.maxLoad <= 0 || policy.maxLoad > 3
        || !Number.isInteger(policy.maxInvalidPerSlot) || policy.maxInvalidPerSlot < 1 || policy.maxInvalidPerSlot > 3) {
        await lock.release();
        throw new Error('Invalid machine policy: finite floor >=6GiB, start load in (0,3], retries in [1,3] required');
    }
    let adapter, previous, windowCheck, history = [], historyKey;
    const ledgerPath = join(gateRoot, 'history.json');
    const report = { schema: 1, id, gate: config.gate, mode: config.mode, temperature: config.temperature,
        status: 'running', started: new Date().toISOString(), metric: config.metric, policy, schedule, plannedLooks,
        contract: Object.fromEntries(['inputScript', 'witness', 'identity', 'mutant', 'falsePass', 'losses'].map(k => [k, config[k]])),
        lock: lock.holder, sessions: [], looks: [], noiseReport: config.noiseReport ?? null, confirmationOf: config.confirmReport ?? null };
    const accepted = { A: [], B: [] };
    async function persist() {
        await atomicWrite(join(dir, 'report.json'), json(report));
        await atomicWrite(join(dir, 'report.md'), reportMarkdown(report));
    }
    try {
        await mkdir(dir, { recursive: true });
        await persist(); // even a fatal browser/Node crash leaves a visible incomplete attempt
        report.machine = await machineIdentity();
        const scriptFiles = [...new Set([...(config.scriptFiles ?? []), ...['runner.mjs', 'stats.mjs', 'machine.mjs', 'lock.mjs', 'cpuMeasurement.mjs', 'environment.mjs', 'windowCalibration.mjs']
            .map(name => fileURLToPath(new URL(name, import.meta.url)))])];
        report.sources = await Promise.all(scriptFiles.map(async path => ({ path, source: await readFile(path, 'utf8') })));
        report.inputScriptHash = hash({ input: config.inputScript, sources: report.sources });
        report.agentRoots = await collectAgentRoots();
        const machineOptions = { agentRoots: report.agentRoots, grantPid: lock.holder.grant.grant.pid };
        adapter = await adapterFactory(config, dir);
        report.identities = adapter.identities;
        report.driverVersion = adapter.driverVersion;
        report.expectedBrowserVersion = adapter.expectedBrowserVersion;
        report.browserPin = adapter.browserPin;
        try { history = JSON.parse(await readFile(ledgerPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        historyKey = hash({ builds: ['A', 'B'].map(arm => adapter.identities[arm].sha256), metric: config.metric,
            temperature: config.temperature, input: report.inputScriptHash });
        const sameBuild = adapter.identities.A.sha256 === adapter.identities.B.sha256;
        report.purpose = config.purpose ?? (sameBuild ? 'noise' : 'gate');
        if (!['noise', 'gate'].includes(report.purpose) || (report.purpose === 'noise' && !sameBuild)) throw new Error('Noise phase requires identical builds');
        // A baseline need not meet the future target, and same-build arms cannot
        // demonstrate improvement. Noise therefore ALWAYS uses no-regression,
        // while retaining the intended gate metric for matching the later run.
        const analysisMetric = report.purpose === 'noise' && config.metric.rule !== 'no-regression'
            ? config.noiseMetric ?? { ...config.metric, rule: 'no-regression', comparison: 'relative', threshold: 0.05 }
            : config.metric;
        configuration({ ...config, metric: analysisMetric });
        if (report.purpose === 'noise' && analysisMetric.rule !== 'no-regression') throw new Error('Noise phase must use no-regression');
        report.analysisMetric = analysisMetric;
        if (config.mode === 'accepted') windowCheck = await windowCalibration(lock, config, adapter.identities, join(dir, 'report.json'));
        // Noise is a mandatory prerequisite for a comparison, never inferred from
        // the changed-arm run's spread. It must match this metric, fixture and cache policy.
        if (config.mode === 'accepted' && report.purpose === 'gate') {
            if (!config.noiseReport) throw new Error('Comparison requires an accepted same-build noise report first');
            const noise = JSON.parse(await readFile(config.noiseReport, 'utf8'));
            if (noise.status !== 'pass' || noise.mode !== 'accepted' || noise.purpose !== 'noise' || noise.identities.A.sha256 !== adapter.identities.A.sha256
                || noise.identities.A.sha256 !== noise.identities.B.sha256 || noise.temperature !== config.temperature
                || hash(noise.metric) !== hash(config.metric) || noise.inputScriptHash !== report.inputScriptHash) {
                throw new Error('Noise report is not a passing same-build recording of this exact baseline/metric/script/temperature');
            }
        }
        if (config.confirmReport) {
            previous = JSON.parse(await readFile(config.confirmReport, 'utf8'));
            if (!eligibleConfirmation(previous) || previous.mode !== config.mode || previous.temperature !== config.temperature
                || hash(previous.metric) !== hash(config.metric) || hash(previous.analysisMetric) !== hash(analysisMetric)
                || previous.inputScriptHash !== report.inputScriptHash
                || ['A', 'B'].some(arm => previous.identities[arm].sha256 !== adapter.identities[arm].sha256)) {
                throw new Error('Not eligible for the single near-boundary confirmatory run');
            }
            for (const arm of ['A', 'B']) accepted[arm].push(...previous.sessions.filter(s => s.arm === arm && s.validity.valid && s.measurement).map(s => ({ values: s.measurement.values })));
            report.previousSessions = previous.sessions;
        }
        // A durable per-gate ledger prevents a failed accepted run from quietly
        // disappearing behind another attempt. Invalid runs may be retried; a failed
        // one needs the explicit, eligible confirmation above or a new build/script.
        if (config.mode === 'accepted' && !config.confirmReport && history.some(x => x.key === historyKey && x.mode === 'accepted' && x.status === 'fail')) {
            throw new Error('This build/metric already failed; only an eligible explicit confirmation may re-run it');
        }
        if (config.confirmReport && history.some(x => x.confirmationOf === config.confirmReport && x.status !== 'invalid')) throw new Error('Confirmation was already used');
        const targets = previous ? [previous.result.counts.A] : config.mode === 'exploratory' ? [config.exploratorySessions ?? 2] : schedule;
        report.confirmationPlannedSessions = previous ? previous.result.counts.A : null;
        for (const count of targets) {
            const desired = previous ? count * 2 : count;
            while (accepted.A.length < desired || accepted.B.length < desired) {
                // Completing a balanced block gives A B B A A B B A ... . Invalidity
                // re-runs that slot immediately, without changing the arm order.
                const position = accepted.A.length + accepted.B.length;
                const arm = ['A', 'B', 'B', 'A'][position % 4];
                const chosen = accepted[arm].length < desired ? arm : arm === 'A' ? 'B' : 'A';
                let valid = false;
                for (let retry = 0; retry < policy.maxInvalidPerSlot; retry++) {
                    await lock.assertHeld();
                    const sessionId = String(report.sessions.length + 1).padStart(3, '0');
                    const artifacts = join(dir, sessionId); await mkdir(artifacts);
                    const record = { id: sessionId, arm: chosen, retry, artifacts, before: await machineSnapshot(machineOptions) };
                    report.sessions.push(record);
                    const preflight = sessionValidity(record.before, record.before, policy);
                    try {
                        if (config.mode === 'accepted' && !preflight.valid) record.validity = preflight;
                        else {
                            const cpu = await startCPUMeasurement(report.agentRoots, sample => inspectProcessOwnership(sample, machineOptions.grantPid));
                            try {
                                record.measurement = await adapter.measure({ arm: chosen, artifacts, temperature: config.temperature });
                                await validateMeasurement(record.measurement, adapter.expectedBrowserVersion);
                            } finally {
                                record.cpu = await cpu.stop(record.measurement);
                                record.after = await machineSnapshot(machineOptions);
                            }
                            record.validity = sessionValidity(record.before, record.after, policy, record.cpu);
                            await lock.assertHeld();
                            if (config.mode === 'exploratory') record.exploratory = 'EXPLORATORY, MACHINE SHARED; invalid machine readings may be used only for development, never a verdict';
                            if (record.validity.valid || config.mode === 'exploratory') {
                                accepted[chosen].push({ values: record.measurement.values }); valid = true;
                                await windowCheck?.observe(accepted);
                            }
                        }
                    } catch (error) {
                        record.after ??= await machineSnapshot(machineOptions); record.error = error.stack;
                        if (!error.invalidCause) throw error; // app/identity/witness failure is NOT invalidity
                        record.validity = { valid: false, causes: [error.invalidCause] };
                    }
                    await persist();
                    if (valid) break;
                }
                if (!valid) throw Object.assign(new Error('Invalid session retry budget exhausted; no verdict'), { invalidCause: true });
            }
            const result = summarize(accepted, analysisMetric, { looks: plannedLooks });
            const uncorrected = summarize(accepted, analysisMetric, { looks: 1 });
            if (previous) {
                const independent = Object.fromEntries(['A', 'B'].map(arm => [arm, report.sessions
                    .filter(s => s.arm === arm && s.validity.valid && s.measurement).map(s => ({ values: s.measurement.values }))]));
                report.confirmationIndependent = summarize(independent, analysisMetric, { looks: plannedLooks });
                report.confirmationIndependentUncorrected = summarize(independent, analysisMetric, { looks: 1 });
                // The pooled count was selected using the first run's data, so
                // its ordinary fixed-n CI alone does NOT carry honest coverage.
                // vr-lead ruling: independent fixed-n confirmation must pass too;
                // pooled pass is an additional plan condition, never the guarantee.
                result.inference = 'Pooled interval is an additional condition, not the coverage guarantee; independent confirmation must also pass.';
            }
            report.result = result; report.uncorrected = uncorrected;
            report.correctionPreventedDecision = (result.status === 'inconclusive' && uncorrected.status !== 'inconclusive')
                || (report.confirmationIndependent?.status === 'inconclusive' && report.confirmationIndependentUncorrected?.status !== 'inconclusive');
            report.looks.push({ count, result, uncorrected });
            await persist();
            if (config.mode === 'exploratory' || result.precise || previous) break;
        }
        windowCheck?.assertValid();
        await adapter.recheck();
        for (const source of report.sources) {
            if (await readFile(source.path, 'utf8') !== source.source) throw new Error(`Run script changed during measurement: ${source.path}`);
        }
        await adapter.validate?.(report);
        const statuses = [report.result.status, ...(report.confirmationIndependent ? [report.confirmationIndependent.status] : [])];
        report.status = config.mode === 'exploratory' ? 'exploratory'
            : statuses.every(x => x === 'pass') ? 'pass' : statuses.includes('fail') ? 'fail' : 'inconclusive';
        report.confirmationEligible = eligibleConfirmation(report);
        report.completed = new Date().toISOString();
        await lock.assertHeld();
    } catch (error) {
        report.status = error.invalidCause ? 'invalid' : 'fail'; report.error = error.stack;
    } finally {
        try { await adapter?.close(); }
        catch (error) { report.status = 'fail'; report.error = `${report.error ?? ''}\nAdapter cleanup failed: ${error.stack}`; }
        finally {
            try {
                if (windowCheck) report.windowCalibration = { path: windowCheck.path, record: windowCheck.record ?? 'opening block incomplete' };
                report.finished = new Date().toISOString();
                await mkdir(dir, { recursive: true }); await persist();
                if (historyKey) {
                    history.push({ id, key: historyKey, status: report.status, path: join(dir, 'report.json'),
                        mode: config.mode, confirmationOf: config.confirmReport ?? null });
                    await atomicWrite(ledgerPath, json(history));
                }
            } finally { await lock.release(); }
        }
    }
    return { status: report.status, reportPath: join(dir, 'report.json'), report };
}
