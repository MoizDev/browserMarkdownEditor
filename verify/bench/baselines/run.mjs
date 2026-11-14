// CLI is quick UNQUALIFIED readings only. Accepted imports belong to post-K7 review.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runBenchmark } from '../../lib/bench/runner.mjs';
import { loadScenarioFixture } from './fixtures.mjs';
import { baselineAdapter } from './adapter.mjs';
export const scenarios = ['startup-markdown', 'startup-mixed-note', 'startup-mixed-pdf', 'typing', 'pdf-open', 'pdf-scroll', 'save-plain', 'save-embed-drop'];
export const startupFields = ['firstPixelsMs', 'readableMs', 'bytesBeforeFirstPixels', 'requestsBeforeFirstPixels',
    'bytesBeforeReadable', 'requestsBeforeReadable', 'longTaskMsBeforeFirstPixels', 'longTaskMsBeforeReadable',
    'workersBeforeFirstPixels', 'workersBeforeReadable'];
export async function runBaseline({ preparedPath, scenario, temperature = 'cold', buildMode = 'benchmark', field = 'readableMs',
    mode = 'exploratory', noiseReport = null, confirmReport = null }) {
    if (!preparedPath || !scenarios.includes(scenario) || !['cold', 'warm'].includes(temperature) || !['production', 'benchmark', 'compare'].includes(buildMode)
        || (scenario.startsWith('startup-') && !startupFields.includes(field))) throw new Error('Unknown baseline scenario, build mode, cache regime or metric field');
    const prepared = JSON.parse(await readFile(resolve(preparedPath), 'utf8'));
    if (prepared.status !== 'prepared-only') throw new Error('Expected reference preparation, NOT a baseline report');
    const fixture = await loadScenarioFixture(prepared, scenario);
    const modes = buildMode === 'compare' ? { A: 'production', B: 'benchmark' } : { A: buildMode, B: buildMode };
    const metric = { name: `${scenario}-${scenario.startsWith('startup-') ? field : 'cost'}`, unit: 'ms', rule: 'no-regression',
        comparison: 'relative', threshold: 0.05, lowerIsBetter: true };
    if (['typing', 'pdf-scroll'].includes(scenario)) metric.percentile = 0.95;
    if (scenario.startsWith('save-')) Object.assign(metric, { comparison: 'absolute', threshold: 1,
        resolutionJustification: 'Binding save-path contract: HL upper(candidate-reference) <+1ms; renderer-main busy sum, NOT wall latency.' });
    if (scenario.startsWith('startup-') && !['firstPixelsMs', 'readableMs'].includes(field)) {
        metric.unit = field.startsWith('bytes') ? 'bytes' : field.startsWith('longTask') ? 'ms' : 'count';
        Object.assign(metric, { comparison: 'absolute', threshold: 1,
            resolutionJustification: 'Zero-capable count/diagnostic resolution floor. Shipping byte/worker allowances are separate gates, not certified by this baseline.' });
    }
    const scriptFiles = [...['run.mjs', 'adapter.mjs', 'fixtures.mjs', 'observers.mjs', 'trace.mjs'].map(file => fileURLToPath(new URL(file, import.meta.url))),
        ...['bench/browser.mjs', 'vault.mjs', 'input.mjs', 'identity.mjs'].map(file => fileURLToPath(new URL(`../../lib/${file}`, import.meta.url)))];
    const sources = await Promise.all(scriptFiles.map(async path => ({ path, source: await readFile(path, 'utf8') })));
    const definition = { id: metric.name, hash: createHash('sha256').update(JSON.stringify({ scenario, field, temperature, metric,
        fixtureHash: fixture.sha256, sources, pin: JSON.parse(await readFile(new URL('../../browser-pin.json', import.meta.url), 'utf8')) })).digest('hex'),
        scenario, metric, fixtureHash: fixture.sha256,
        profile: 'Fresh persistent profile; restore metadata seeded on blank origin. Warm discards one same-profile prime, restores fixture; HTTP/code/shader caches retained. Files read once; not cold disk.' };
    return runBenchmark({ gate: `v08-${scenario}`, mode, temperature, noiseReport, confirmReport,
        arms: Object.fromEntries(['A', 'B'].map(arm => [arm, { dist: prepared.builds[modes[arm]].dist }])),
        metric, metricDefinition: definition, scriptFiles, exploratorySessions: 1,
        inputScript: [scenario, `Frozen reference ${prepared.referenceCommit}; registered generated fixture ${fixture.sha256}`,
            definition.profile, 'Real driver keys/wheel/mouse; outside DOM/performance/trace read-outs; no paused target'],
        witness: 'Expected restored document or trusted edit/scroll/save is visible; exact save result read back; screenshot retained.',
        identity: 'Frozen reference production/benchmark manifests and V-01a node-refetch served bodies, outside measured action.',
        mutant: 'Deferred to the post-K7 review phase by charter0; no new mutant or proof run.',
        falsePass: 'Implementation smoke cannot receive pass/baseline status. V-04 per-session estimators, schedule, precision and noise prerequisite remain unchanged.',
        losses: [mode === 'exploratory' ? 'UNQUALIFIED shared-machine implementation reading, NEVER a recorded baseline or accepted gate.' : 'Review-phase timing; all acceptance prerequisites apply.',
            'One machine, headless, generated OPFS vault; no cold-disk or photon-latency claim.',
            'First pixels: expected note text / nonzero rendered PDF canvas +rAF. Readable: stable geometry, fonts and PDF text layer.',
            'Worker boundary uses Node receipt-time proxy, never paused targets; instrumentation overhead review deferred.',
            'All startup fields are retained; one selected scalar gets its own V-04 report/schedule.'],
    }, baselineAdapter({ prepared, fixture, scenario, modes, metricField: field }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [preparedPath, scenario, temperature = 'cold', buildMode = 'benchmark', field = 'readableMs'] = process.argv.slice(2);
    if (!preparedPath) throw new Error('Usage: bme-lock run -- node verify/bench/baselines/run.mjs <prepared.json> <scenario> [cold|warm] [production|benchmark|compare] [startup-field]');
    const result = await runBaseline({ preparedPath, scenario, temperature, buildMode, field });
    console.log(JSON.stringify({ label: 'UNQUALIFIED — NOT A BASELINE', scenario, temperature, buildMode,
        status: result.status, reportPath: result.reportPath }, null, 4));
    process.exitCode = result.status === 'exploratory' ? 0 : 1;
}
