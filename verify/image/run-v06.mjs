import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { prepareApp } from '../lib/serve.mjs';
import { generateCorpus } from '../fixtures/lib/corpus.mjs';
import { isolatedDockerEnv } from './docker.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const execute = promisify(execFile);
const options = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (['--prepare', '--capture', '--compare', '--propose', '--pdf-controls'].includes(key)) options[key] = true;
    else if (['--scratch', '--cache', '--out', '--dpr', '--translation', '--expected', '--actual', '--comparison', '--store', '--theme'].includes(key) && argv[i + 1] && options[key] === undefined) options[key] = argv[++i];
    else throw new Error(`Unknown, duplicate or missing option: ${key}`);
}
if ([options['--prepare'], options['--capture'], options['--compare'], options['--propose']].filter(Boolean).length !== 1 || !options['--scratch']) throw new Error('Choose --prepare, --capture, --compare or --propose and --scratch <external run build directory>');
const scratch = resolve(options['--scratch']);
if (scratch === ROOT || scratch.startsWith(`${ROOT}/`)) throw new Error('Picture build data must be outside the repository');
const image = JSON.parse(await readFile(resolve(ROOT, 'verify/image/IMAGE.lock'), 'utf8'));
if (!/^sha256:[a-f0-9]{64}$/.test(image.imageId)) throw new Error('The local picture image is not built/locked');

if (options['--prepare']) {
    if (!options['--cache']) throw new Error('--prepare needs --cache <external fixture cache>');
    await mkdir(scratch, { recursive: false });
    const app = await prepareApp({ root: ROOT, scratch: resolve(scratch, 'app'), mode: 'production' });
    const generated = await generateCorpus(resolve(scratch, 'fixtures'));
    const manifests = [];
    for (const stream of ['core', 'platform']) manifests.push(...JSON.parse(await readFile(resolve(ROOT, 'verify/fixtures', stream, 'manifest.json'), 'utf8')).fixtures);
    for (const record of generated) {
        const frozen = manifests.find(fixture => fixture.id === record.id);
        if (!frozen || frozen.sha256 !== record.sha256 || frozen.bytes !== record.bytes) throw new Error(`Freeze V-05 first: missing/changed generated identity ${record.id}`);
    }
    const find = id => {
        const record = generated.find(record => record.id === id);
        if (!record) throw new Error(`Missing registered input ${id}`);
        return record;
    };
    const readGenerated = record => readFile(resolve(scratch, 'fixtures', record.invocation, record.file));
    const vault = JSON.parse(await readGenerated(find('core/vault-100/vault-100.json')));
    const pdfRecord = find('GEN-01/geometry.pdf');
    const pdf = await readGenerated(pdfRecord);
    const noteRecord = find('core/notes/Every construct.md');
    const note = vault.files.find(file => file.path === 'Every construct.md');
    if (!note || hash(Buffer.from(note.content)) !== noteRecord.sha256) throw new Error('Seeded note differs from its frozen standalone identity');
    const whiteboard = JSON.parse(await readFile(resolve(ROOT, 'verify/fixtures/whiteboard/manifest.json'), 'utf8')).fixtures.find(fixture => fixture.id === 'CLASSIC-ONE-STROKE');
    if (!whiteboard || whiteboard.file !== 'classic-one-stroke.tldraw') throw new Error('Missing classic drawing identity; never relabel it native .drawing');
    let drawing;
    try { drawing = await readFile(resolve(options['--cache'], whiteboard.sha256)); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await writeFile(resolve(scratch, 'not-run.json'), json({ status: 'not run', fixture: whiteboard.id, sha256: whiteboard.sha256, reason: 'Required authored classic drawing absent from external cache; no automatic replacement identity' }), { flag: 'wx' });
        process.exitCode = 2;
    }
    if (drawing) {
        if (drawing.length !== whiteboard.bytes || hash(drawing) !== whiteboard.sha256) throw new Error('Classic drawing cache identity mismatch');
        const data = resolve(scratch, 'data');
        await mkdir(data);
        const input = {
            schema: 1, name: 'V06-Fixture',
            files: [...vault.files, { path: 'geometry.pdf', encoding: 'base64', content: pdf.toString('base64') }, { path: whiteboard.file, encoding: 'base64', content: drawing.toString('base64') }],
            scenes: {
                note: { id: noteRecord.id, sha256: noteRecord.sha256, scenario: 'v06/reading/default-dark/en-US/1440x1000' },
                pdf: { id: pdfRecord.id, sha256: pdfRecord.sha256, scenario: 'v06/page-1/no-inversion/en-US/1440x1000' },
                drawing: { id: whiteboard.id, sha256: whiteboard.sha256, scenario: 'v06/classic-drawing/file-session/default-dark/en-US/1440x1000' },
            },
        };
        await writeFile(resolve(data, 'input.json'), json(input), { flag: 'wx' });
        await writeFile(resolve(data, 'metadata.json'), json({ schema: 1, image, build: app.identity }), { flag: 'wx' });
        await writeFile(resolve(scratch, 'picture-prepared.json'), json({ schema: 1, root: ROOT, scratch, data, dist: app.distDir, imageId: image.imageId, inputSha256: hash(Buffer.from(json(input))), metadataSha256: hash(Buffer.from(json({ schema: 1, image, build: app.identity }))) }), { flag: 'wx' });
        process.stdout.write(`${JSON.stringify({ prepared: scratch, imageId: image.imageId, fixtures: generated.length })}\n`);
    }
} else {
    if (!options['--out']) throw new Error('Runtime needs --out <fresh external artifact directory>');
    const out = resolve(options['--out']);
    if (out === ROOT || out.startsWith(`${ROOT}/`)) throw new Error('Picture artifacts must be outside the repository');
    const prepared = JSON.parse(await readFile(resolve(scratch, 'picture-prepared.json'), 'utf8'));
    if (prepared.root !== ROOT || prepared.scratch !== scratch || prepared.imageId !== image.imageId) throw new Error('Prepared picture source/image identity changed; prepare again');
    if ([prepared.data, prepared.dist].some(directory => out === directory || out.startsWith(`${directory}/`))) throw new Error('Artifacts must not modify the frozen input/build directories');
    await mkdir(out, { recursive: false });
    const env = await isolatedDockerEnv(scratch);
    const metadataBytes = await readFile(resolve(prepared.data, 'metadata.json'));
    if (hash(metadataBytes) !== prepared.metadataSha256 || hash(await readFile(resolve(prepared.data, 'input.json'))) !== prepared.inputSha256) throw new Error('Prepared input/metadata changed');
    // Binding checks fetched code; freeze ALL emitted files here too, including HTML with
    // inline code and font/image bytes, before mounting this seat's dist read-only.
    for (const file of JSON.parse(metadataBytes).build.files) {
        const path = resolve(prepared.dist, file.path);
        if (!path.startsWith(`${prepared.dist}/`)) throw new Error('Emitted path escapes dist');
        const bytes = await readFile(path);
        if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`Prepared emitted file changed: ${file.path}`);
    }
    const mounts = [[resolve(ROOT, 'verify'), '/work/verify', true], [out, '/out', false]];
    const command = [];
    if (options['--capture']) {
        const dpr = Number(options['--dpr']);
        const translation = options['--translation'];
        if (![1, 1.25, 2].includes(dpr) || !['rosetta', 'qemu', 'native-x86'].includes(translation)) throw new Error('Capture needs declared --dpr 1|1.25|2 and --translation rosetta|qemu|native-x86');
        await writeFile(resolve(out, 'capture-metadata.json'), json({ ...JSON.parse(metadataBytes), translation }), { flag: 'wx' });
        mounts.push([prepared.dist, '/work/dist', true], [prepared.data, '/input', true]);
        command.push('/work/verify/image/capture.mjs', '--dist', '/work/dist', '--input', '/input/input.json', '--metadata', '/out/capture-metadata.json', '--out', '/out', '--dpr', String(dpr), '--theme', options['--theme'] ?? 'dark');
    } else {
        if (!options['--expected'] || !options['--actual']) throw new Error('Compare needs --expected and --actual capture directories');
        mounts.push([resolve(options['--expected']), '/expected', true], [resolve(options['--actual']), '/actual', true]);
        if (options['--propose']) {
            if (!options['--comparison'] || !options['--store']) throw new Error('Proposal needs --comparison and external --store');
            const store = resolve(options['--store']);
            if (store === ROOT || store.startsWith(`${ROOT}/`)) throw new Error('Goldens must remain outside the repository');
            await mkdir(store, { recursive: true });
            mounts.push([resolve(options['--comparison']), '/comparison', true], [store, '/goldens', false]);
            command.push('/work/verify/image/goldens.mjs', '--propose', '--expected', '/expected', '--actual', '/actual', '--comparison', '/comparison', '--store', '/goldens', '--out', '/out/review');
        } else {
            command.push('/work/verify/image/compare-captures.mjs', '--expected', '/expected', '--actual', '/actual', '--out', '/out');
            if (options['--pdf-controls']) command.push('--pdf-controls');
        }
    }
    const cidFile = resolve(out, 'container.id');
    const args = ['run', '--rm', '--init', '--platform', 'linux/amd64', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '4g', '--cpus', '2', '--pids-limit', '512', '--shm-size', '512m', '--tmpfs', '/tmp:rw,nosuid,nodev,size=1g', '--user', `${process.getuid()}:${process.getgid()}`, '--cidfile', cidFile, '--entrypoint', 'node'];
    for (const [source, target, readonly] of mounts) {
        if (source.includes(',') || source.includes('\n')) throw new Error('Unsupported comma/newline in mount path');
        args.push('--mount', `type=bind,src=${source},dst=${target}${readonly ? ',readonly' : ''}`);
    }
    args.push(image.imageId, ...command);
    const stopContainer = async () => {
        let id;
        try { id = (await readFile(cidFile, 'utf8')).trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (id && /^[a-f0-9]{64}$/.test(id)) await execute('docker', ['rm', '--force', id], { env, timeout: 10000 }).catch(() => {});
    };
    let child;
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, async () => {
        await stopContainer();
        child?.kill('SIGTERM');
        process.exit(128 + { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal]);
    });
    try {
        const code = await new Promise((accept, reject) => {
            child = spawn('docker', args, { env, stdio: 'inherit' });
            child.once('error', reject);
            child.once('exit', (code, signal) => signal ? reject(new Error(`Picture container terminated by ${signal}`)) : accept(code));
        });
        process.exitCode = code ?? 1;
    } finally { await stopContainer(); }
}
