import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { comparePictures } from '../lib/picture/compare.mjs';
import { sha256 } from '../lib/picture/png.mjs';

const options = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pdf-controls') options['--pdf-controls'] = true;
    else if (['--expected', '--actual', '--out'].includes(argv[i]) && argv[i + 1] && options[argv[i]] === undefined) options[argv[i]] = argv[++i];
    else throw new Error(`Unknown, duplicate or missing comparison option: ${argv[i]}`);
}
if (!options['--expected'] || !options['--actual'] || !options['--out']) throw new Error('Expected --expected <capture dir> --actual <capture dir> --out <fresh comparison dir>');
const out = resolve(options['--out']);
const result = { gate: 'V-06', status: 'failed', stage: 'capture-identity', comparisons: [], losses: ['One ARM host only; cross-host equality not covered.', 'B/C repeated classic PDF captures exercise the comparer, not new GPU/2D or tiled/full parity.', 'DPR mutation proves one rejection, not every channel/SSIM/ink threshold boundary.'] };
try {
    if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('A comparisons run only in the pinned Linux amd64 image');
    const lock = JSON.parse(await readFile(new URL('./IMAGE.lock', import.meta.url), 'utf8'));
    const expected = JSON.parse(await readFile(resolve(options['--expected'], 'capture.json'), 'utf8'));
    const actual = JSON.parse(await readFile(resolve(options['--actual'], 'capture.json'), 'utf8'));
    for (const [arm, capture] of [['expected', expected], ['actual', actual]]) {
        if (capture.status !== 'passed' || capture.passed !== true || capture.frames.length !== 3) throw new Error(`${arm} is not a passing three-scene real-app capture`);
        if (capture.image.imageId !== lock.imageId || capture.browser.version !== lock.browser.version || capture.browser.driverVersion !== lock.playwright) throw new Error(`${arm} capture has the wrong image/browser/installed driver identity`);
        if (!capture.softwareWebgl.offered || !/swiftshader/i.test(capture.softwareWebgl.renderer ?? '')) throw new Error(`${arm} capture did not prove software WebGL2`);
        if (capture.actualDpr !== capture.dpr || ![1, 1.25, 2].includes(capture.actualDpr)) throw new Error(`${arm} declared an unobserved DPR`);
        if (capture.servedBinding.faults.length || capture.servedBinding.modules.length === 0) throw new Error(`${arm} did not bind served code`);
    }
    if (expected.build.manifestSha256 !== actual.build.manifestSha256) throw new Error('The two-container stability witness must use one emitted app build');
    result.imageId = lock.imageId;
    result.browser = { version: lock.browser.version, driver: lock.playwright };
    result.expectedDpr = expected.actualDpr;
    result.actualDpr = actual.actualDpr;
    result.buildManifestSha256 = expected.build.manifestSha256;
    result.stage = 'picture-comparison';
    // A deliberately changed DPR is NOT rejected in preparation: the same A comparison
    // below must reject its actual browser-produced pixels and write their difference.
    for (const name of ['note', 'pdf', 'drawing']) {
        const a = expected.frames.find(frame => frame.name === name);
        const b = actual.frames.find(frame => frame.name === name);
        if (!a || !b || a.file !== `${name}.png` || b.file !== `${name}.png` || a.fixture.id !== b.fixture.id || a.fixture.sha256 !== b.fixture.sha256 || a.fixture.scenario !== b.fixture.scenario) throw new Error(`Changed/missing source fixture for ${name}`);
        const expectedBytes = await readFile(resolve(options['--expected'], a.file));
        const actualBytes = await readFile(resolve(options['--actual'], b.file));
        if (sha256(expectedBytes) !== a.sha256 || sha256(actualBytes) !== b.sha256) throw new Error(`Capture bytes changed after the browser witness: ${name}`);
        const kinds = options['--pdf-controls'] && name === 'pdf' ? ['A', 'B', 'C'] : ['A'];
        for (const kind of kinds) {
            const comparison = await comparePictures({ expected: expectedBytes, actual: actualBytes, kind, fixture: a.fixture, outDir: resolve(out, 'differences'), name: `${kind}-${name}` });
            result.comparisons.push({ scene: name, ...comparison });
        }
    }
    if (result.comparisons.length && result.comparisons.every(comparison => comparison.passed)) result.status = 'passed';
    else process.exitCode = 1;
} catch (error) {
    result.error = error.stack;
    process.exitCode = 1;
} finally {
    await writeFile(resolve(out, 'comparison.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ status: result.status, stage: result.stage, expectedDpr: result.expectedDpr, actualDpr: result.actualDpr, comparisons: result.comparisons.map(row => ({ scene: row.scene, kind: row.kind, passed: row.passed, reason: row.reason })), report: '/out/comparison.json' })}\n`);
}
