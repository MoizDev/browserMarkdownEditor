import { execFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../../fixtures/lib/cli.mjs';
import { sha256 } from '../../fixtures/lib/output.mjs';
import { openBrowser } from '../../lib/browser.mjs';
import { installVault, seedVault } from '../../lib/vault.mjs';
import { bindServedBodies } from '../../lib/identity.mjs';
import { serveApp } from '../../lib/serve.mjs';
import { createReport } from '../../lib/report.mjs';

// Real-app differential only. The generator is data tooling; no application
// module, extracted step, fake EditorState or mutable measurement hook is called.
const args = parseArgs(process.argv.slice(2), ['reference', 'candidate', 'cases', 'themes']);
if (!args.reference || !args.candidate) throw new Error('Supply --reference/--candidate <prepared benchmark scratch>');
const themes = (args.themes ?? 'dark,light').split(',');
if (!themes.length || themes.some(theme => !['dark', 'light'].includes(theme))) throw new Error('--themes is dark, light or dark,light');
const requested = (args.cases ?? 'g0-exact-000032-duplicates2,g0-exact-000600-dense10').split(',');
const root = resolve(args.out);
await mkdir(root, { recursive: true });
const report = await createReport({ scratch: root, name: 'tb-gr', seed: args.seed,
    contract: 'Compare real graph positions at equal completed steps as doubles, with actual graph counts and screenshots.',
    reloadArm: 'fresh pinned contexts; no reload/structured-clone claim',
    losses: ['Functional, not timing. Geometry sidecars are not applied; G0 uses the app default spiral.',
        'The selected cases are recorded; unselected topology/geometry cases are not exercised.',
        'OPFS, not native-disk/FSEvents. Functional raw-byte routing disables the HTTP cache.'] });
report.data.pairs = [];
const execute = promisify(execFile);
const servers = [];
let activeBindings = [];
async function check(label, expected, actual) {
    await Promise.all(activeBindings.map(binding => binding.check()));
    report.assert(label, expected, actual);
}

async function generate() {
    const directory = await mkdtemp(join(root, 'fixtures-'));
    const { stdout } = await execute(process.execPath, [fileURLToPath(new URL('./graphset.mjs', import.meta.url)),
        '--out', directory, '--seed', String(args.seed), '--set', 'all'], { maxBuffer: 8 * 1024 * 1024 });
    const emitted = stdout.trim().split('\n').map(line => JSON.parse(line));
    const manifest = JSON.parse(await readFile(join(directory, 'graphset-manifest.json'), 'utf8'));
    return { directory, emitted, manifest };
}

function contract(layout, expectedCount) {
    if (!layout || !layout.positions || !Array.isArray(layout.positions.ids) || !Array.isArray(layout.positions.ring)) return 'missing positions ring';
    const { ids, ring } = layout.positions;
    if (layout.steps !== 300) return `settled at ${layout.steps}, not 300`;
    if (ids.length !== expectedCount || new Set(ids).size !== expectedCount) return 'wrong or repeated node ids';
    const steps = new Set();
    for (const frame of ring) {
        if (!Number.isSafeInteger(frame.step) || steps.has(frame.step)) return 'invalid/repeated step tag';
        steps.add(frame.step);
        if (!Array.isArray(frame.x) || !Array.isArray(frame.y) || frame.x.length !== ids.length || frame.y.length !== ids.length) return 'wrong coordinate count';
        if (![...frame.x, ...frame.y].every(Number.isFinite)) return 'nonfinite position';
    }
    for (let step = 1; step <= 300; step++) if (!steps.has(step)) return `missing step ${step}`;
    const byStep = new Map(ring.map(frame => [frame.step, frame]));
    if (!ids.some((_, i) => !Object.is(byStep.get(1).x[i], byStep.get(30).x[i]) || !Object.is(byStep.get(1).y[i], byStep.get(30).y[i]))) return 'no displacement in steps 1..30';
    return null;
}

function firstDifference(reference, candidate) {
    const a = reference.positions, b = candidate.positions;
    const indexB = new Map(b.ids.map((id, i) => [id, i]));
    const framesB = new Map(b.ring.map(frame => [frame.step, frame]));
    const bits = value => { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value); return bytes.toString('hex'); };
    let compared = 0;
    for (const frame of a.ring.filter(frame => frame.step >= 1 && frame.step <= 300).sort((x, y) => x.step - y.step)) {
        const other = framesB.get(frame.step);
        for (let i = 0; i < a.ids.length; i++) {
            const j = indexB.get(a.ids[i]);
            for (const axis of ['x', 'y']) {
                compared++;
                const av = frame[axis][i], bv = other[axis][j];
                if (!Object.is(av, bv)) return { compared, difference: { step: frame.step, node: a.ids[i], axis,
                    reference: av, candidate: bv, referenceBits: bits(av), candidateBits: bits(bv) } };
            }
        }
    }
    return { compared, difference: null };
}

async function openGraph(session, server, bundle, theme, name) {
    await installVault(session.context, { name: bundle.name });
    const bound = { name, data: {} };
    (report.data.servedBindings ??= []).push(bound);
    const binding = await bindServedBodies(session.context, { identity: server.identity, origin: server.url, report: bound,
        mode: 'raw-route', buildMode: 'benchmark', blockExternalOrigins: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://cdn.tldraw.com'] });
    activeBindings.push(binding);
    const page = await session.context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.url);
    const files = Object.fromEntries(bundle.files.map(file => {
        if (file.encoding !== 'utf8') throw new Error('G0 accepts authored UTF-8 notes only');
        return [file.path, file.content];
    }));
    await seedVault(page, { name: bundle.name, files });
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    await page.locator('.vault-switcher').waitFor();
    if (theme === 'light') await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
    await check(`${name} theme`, theme === 'light', await page.evaluate(() => document.documentElement.dataset.theme === 'light'));
    const path = bundle.oracle.ids[0], parts = path.split('/');
    for (let i = 1; i < parts.length; i++) await page.locator(`.tree-item[data-path=${JSON.stringify(parts.slice(0, i).join('/'))}]`).click();
    await page.locator(`.tree-item[data-path=${JSON.stringify(path)}]`).click();
    await page.locator('.cm-content').waitFor();
    await check(`${name} fixture visible in reader`, true, (await page.locator('.cm-content').innerText()).includes('G0-GRAPHSET-v1'));
    await page.getByRole('button', { name: 'Neural Brain — graph view', exact: true }).click();
    await page.locator('.graph-stats').filter({ hasText: `${bundle.noteCount} notes · ${bundle.edgeCount} links` }).waitFor({ timeout: 60000 });
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.fonts.ready);
    await check(`${name} benchmark graph live`, true, await page.evaluate(() => typeof window.__perf?.graph?.positions === 'function'));
    await page.waitForFunction(() => window.__perf.graph.steps >= 300, undefined, { timeout: 60000 });
    const read = () => page.evaluate(() => ({ positions: window.__perf.graph.positions(), edges: window.__perf.graph.snapshot(), steps: window.__perf.graph.steps }));
    const layout = await read();
    // Negative observation of rest, not a completion sleep: the full snapshot
    // must stay identical for this interval after the working-step target.
    await page.waitForTimeout(1000);
    await check(`${name} stable after settle`, true, isDeepStrictEqual(layout, await read()));
    await check(`${name} application errors`, [], errors);
    return { page, layout, errors, identity: session.identity };
}

try {
    const [left, right] = await Promise.all([generate(), generate()]);
    report.data.fixtureGenerations = [left, right].map(value => ({ directory: value.directory, emitted: value.emitted }));
    report.data.fixtures = Object.fromEntries(left.emitted.map(record => [record.file, record.sha256]));
    for (const scratch of [args.reference, args.candidate]) {
        const prepared = JSON.parse(await readFile(join(resolve(scratch), 'prepared.json'), 'utf8'));
        if (prepared.mode !== 'benchmark') throw new Error('TB-GR needs two prepared benchmark builds');
        servers.push(await serveApp({ root: prepared.root, scratch: resolve(scratch), port: 6360 + servers.length, mode: 'benchmark', build: false }));
    }
    report.data.builds = servers.map(server => server.identity);
    const selected = requested[0] === 'all' ? left.manifest.fixtures.filter(record => record.expected.kind === 'topology' && record.expected.role === 'exact')
        : requested.map(id => {
            const record = left.manifest.fixtures.find(record => record.id === id);
            if (!record || record.expected.kind !== 'topology' || record.expected.role !== 'exact') throw new Error(`Not an exact topology fixture: ${id}`);
            return record;
        });
    for (const fixture of selected) for (const theme of themes) {
        const other = right.manifest.fixtures.find(record => record.id === fixture.id);
        const aBytes = await readFile(join(left.directory, fixture.file)), bBytes = await readFile(join(right.directory, other.file));
        const a = JSON.parse(aBytes), b = JSON.parse(bBytes);
        const pair = { fixture: fixture.id, theme, referenceFixtureHash: sha256(aBytes), candidateFixtureHash: sha256(bBytes), captures: [] };
        report.data.pairs.push(pair);
        const sessions = [];
        try {
            sessions.push(await openBrowser({ contextOptions: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } }));
            sessions.push(await openBrowser({ contextOptions: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } }));
            const reference = await openGraph(sessions[0], servers[0], a, theme, `${fixture.id}/${theme}/reference`);
            const candidate = await openGraph(sessions[1], servers[1], b, theme, `${fixture.id}/${theme}/candidate`);
            pair.browsers = [reference.identity, candidate.identity];
            if (!report.data.fixtureDeterminismChecked) {
                await check('independent complete graph-set generation', left.emitted, right.emitted);
                report.data.fixtureDeterminismChecked = true;
            }
            await check(`${fixture.id} independent fixture generation`, pair.referenceFixtureHash, pair.candidateFixtureHash);
            await check(`${fixture.id} fixture manifest binding`, fixture.sha256, pair.referenceFixtureHash);
            for (const [label, result] of [['reference', reference], ['candidate', candidate]]) {
                await check(`${fixture.id}/${label} ring contract`, null, contract(result.layout, a.noteCount));
                await check(`${fixture.id}/${label} node identities`, [...a.oracle.ids].sort(), [...result.layout.positions.ids].sort());
                await check(`${fixture.id}/${label} directed edge count`, a.edgeCount, result.layout.edges.length);
                await check(`${fixture.id}/${label} ordered directed edges`, sha256(Buffer.from(JSON.stringify(a.oracle.edges))), sha256(Buffer.from(JSON.stringify(result.layout.edges))));
                await check(`${fixture.id}/${label} late application errors`, [], result.errors);
                const capture = join(root, `${fixture.id}-${theme}-${label}.png`);
                await result.page.locator('.graph-canvas-wrap canvas').screenshot({ path: capture });
                pair.captures.push(capture);
            }
            const comparison = firstDifference(reference.layout, candidate.layout);
            pair.comparedDoubles = comparison.compared;
            pair.firstDifference = comparison.difference;
            if (comparison.difference) {
                await writeFile(join(root, `${fixture.id}-${theme}-reference-ring.json`), JSON.stringify(reference.layout));
                await writeFile(join(root, `${fixture.id}-${theme}-candidate-ring.json`), JSON.stringify(candidate.layout));
            }
            await check('TB-GR first differing step/node', null, comparison.difference);
            await check(`${fixture.id}/${theme} painted PNG equality`, true, (await readFile(pair.captures[0])).equals(await readFile(pair.captures[1])));
        } finally {
            try { await Promise.all(activeBindings.map(binding => binding.check())); }
            finally {
                const stopped = await Promise.allSettled(activeBindings.map(binding => binding.stop()));
                activeBindings = [];
                const closed = await Promise.allSettled(sessions.map(session => session.close()));
                for (const result of [...stopped, ...closed]) if (result.status === 'rejected') report.fail(result.reason);
            }
        }
    }
} catch (error) {
    report.fail(error);
    process.exitCode = 1;
} finally {
    const cleanup = await Promise.allSettled(servers.map(server => server.stop()));
    for (const result of cleanup) if (result.status === 'rejected') report.fail(result.reason);
    if (report.data.errors.length) process.exitCode = 1;
    const path = await report.finish();
    console.log(`${report.data.passed ? 'PASS' : 'FAIL'} TB-GR ${path}`);
}
