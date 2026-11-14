import { parseArgs } from '../../lib/cli.mjs';
import { compareNames, fixtureWriter, jsonBytes, sha256 } from '../../lib/output.mjs';
import { seededRandom } from '../../lib/random.mjs';

// Data only: no src imports, clock, filesystem ordering or unseeded randomness.
const { out, seed, set = 'all' } = parseArgs(process.argv.slice(2), ['set']);
if (!['all', 'exact', 'timed', 'geometry'].includes(set)) throw new Error('--set must be all, exact, timed or geometry');
const generator = 'verify/fixtures/core/generators/graphset.mjs';
const version = 1;
const write = fixtureWriter(out);
const records = [];
const counts = [500, 2000, 5000, 10000, 20000];
const pad = value => String(value).padStart(6, '0');
const tag = (role, count, family) => `g0-${role}-${pad(count)}-${family}`;
const fileFor = id => `graphs/${id}.json`;
const rights = { tier: 1, licence: 'NOASSERTION', proposedLicence: 'CC0-1.0',
    sourceNotice: 'Newly authored deterministic Markdown and geometry, no external content or assets.' };

function randomFor(id) {
    const digest = sha256(Buffer.from(id, 'utf8'));
    return seededRandom((seed ^ Number.parseInt(digest.slice(0, 8), 16)) >>> 0);
}

function pathsFor(count, duplicates) {
    return Array.from({ length: count }, (_, i) => duplicates && i <= 20
        ? `part-${pad(i)}/${i === 0 || i === 20 ? 'coincident' : `node-${pad(i)}`}.md`
        : `node-${pad(i)}.md`);
}

function targetsFor(i, count, family, random) {
    const degree = family === 'dense10' ? 10 : 2;
    const duplicates = family === 'duplicates2';
    if (duplicates && (i === 0 || i === 20)) return [1, 2];
    const components = family === 'components2' ? 4 : 1;
    const group = Math.floor(i * components / count);
    const first = Math.ceil(group * count / components);
    const end = Math.ceil((group + 1) * count / components);
    const targets = new Set();
    const add = target => {
        if (target >= first && target < end && target !== i && !(duplicates && (target === 0 || target === 20))) targets.add(target);
    };
    if (family === 'hubs2') add(0);
    add(first + (i - first + 1) % (end - first));
    for (let attempt = 0; targets.size < degree && attempt < degree * 16 + 64; attempt++) add(first + Math.floor(random() * (end - first)));
    // A bounded deterministic fallback also handles unusual seeds without a
    // rejection loop whose completion depends on getting a lucky PRNG draw.
    for (let target = first; targets.size < degree && target < end; target++) add(target);
    if (targets.size !== degree) throw new Error(`Not enough distinct targets for ${count}/${family}`);
    return [...targets];
}

async function emit(id, value, metadata) {
    const result = await write(fileFor(id), jsonBytes(value));
    records.push({ id, ...result, ...rights, generator, version, seed, args: ['--set', set], ...metadata });
    return result;
}

async function vault(definition) {
    const { id, count, family, role } = definition;
    const paths = pathsFor(count, family === 'duplicates2');
    const random = randomFor(id);
    const edges = [];
    const files = paths.map((path, i) => {
        const targets = targetsFor(i, count, family, random);
        const links = targets.map(target => {
            edges.push([path, paths[target]]);
            // Duplicate basenames are NEVER destinations: otherwise reference's
            // historical last-wins bug and the fixed reader would change the
            // topology, confounding a force-kernel differential (D08).
            return `[[${paths[target].split('/').at(-1).slice(0, -3)}]]`;
        });
        return { path, encoding: 'utf8', content: `# Vertex ${pad(i)}\n\nG0-GRAPHSET-v1 ${id}; seed ${seed}; vertex ${i}.\n\n${links.join(' ')}\n` };
    });
    const value = { schema: 1, kind: 'topology', name: `Graph-${id}`, seed, noteCount: count,
        edgeCount: edges.length, seeding: 'app-default-golden-spiral',
        canonicalOrder: 'directories-first DFS; lowercase ASCII names with six-digit ordinals',
        files, oracle: { ids: paths, edges },
        ...(family === 'duplicates2' ? { duplicateBasenames: { name: 'coincident', paths: [paths[0], paths[20]], indices: [0, 20],
            note: 'Names do not imply coincident positions. Only the G1 geometry sidecar creates coincidence.' } } : {}) };
    const record = await emit(id, value, { purpose: `${count}-node ${family} graph (${role})`,
        gates: role === 'exact' ? ['TB-GR', 'G-L1', 'G-L4', 'G-R1'] : ['G0', 'G-L3', 'G-R2', 'G-R4', 'G-R5'],
        features: ['topology', family], expected: { kind: 'topology', role, noteCount: count, edgeCount: edges.length } });
    return { ...record, id, paths };
}

const definitions = [];
for (const count of [5, 32, 150, 500, 600]) definitions.push({ id: tag('exact', count, 'sparse2'), count, family: 'sparse2', role: 'exact' });
for (const family of ['hubs2', 'dense10', 'components2', 'duplicates2']) for (const count of [32, 600]) definitions.push({ id: tag('exact', count, family), count, family, role: 'exact' });
for (const count of counts) for (const family of ['sparse2', 'hubs2', 'dense10']) definitions.push({ id: tag('timed', count, family), count, family, role: 'timed' });
for (const family of ['components2', 'duplicates2']) definitions.push({ id: tag('shape', 5000, family), count: 5000, family, role: 'geometry-vault' });
const wanted = definitions.filter(definition => set === 'all' || definition.role === set
    || set === 'geometry' && (definition.role === 'geometry-vault' || definition.count === 5000 && definition.role === 'timed'
        || definition.role === 'exact' && definition.family === 'duplicates2'));
const emitted = new Map();
for (const definition of wanted.sort((a, b) => compareNames(a.id, b.id))) emitted.set(definition.id, await vault(definition));

function coordinates(shape, count, random) {
    const extent = 30 + 12 * Math.sqrt(count);
    const x = [], y = [];
    if (shape === 'coincident') {
        const other = Array.from({ length: count }, (_, i) => i).filter(i => i !== 0 && i !== 20);
        x[0] = x[20] = 0; y[0] = y[20] = 0;
        for (let pair = 0; pair < other.length; pair += 2) {
            const angle = random() * Math.PI * 2, radius = extent * (2 + random());
            const px = Math.cos(angle) * radius, py = Math.sin(angle) * radius;
            const a = other[pair], b = other[pair + 1];
            x[a] = px; y[a] = py; x[b] = -px; y[b] = -py;
        }
        // Mirrored other points and the pair's symmetric targets 1/2 keep y
        // unclamped, so the index-20 near-coincidence fallback is observable.
        return { x, y };
    }
    for (let i = 0; i < count; i++) {
        if (shape === 'spiral') {
            const angle = i * 2.399963, radius = 30 + 12 * Math.sqrt(i);
            x.push(Math.cos(angle) * radius); y.push(Math.sin(angle) * radius);
        } else if (shape === 'collinear') {
            x.push(-extent + 2 * extent * i / (count - 1)); y.push(0);
        } else if (shape === 'clustered' || shape === 'components') {
            const groups = shape === 'components' ? 4 : 8;
            const group = shape === 'components' ? Math.floor(i * groups / count) : i % groups;
            const angle = 2 * Math.PI * group / groups;
            x.push(Math.cos(angle) * extent * 0.65 + (random() - 0.5) * extent * 0.08);
            y.push(Math.sin(angle) * extent * 0.65 + (random() - 0.5) * extent * 0.08);
        } else {
            x.push((random() * 2 - 1) * extent); y.push((random() * 2 - 1) * extent);
        }
    }
    if (shape === 'hubs') { x[0] = 0; y[0] = 0; }
    return { x, y };
}

if (set === 'all' || set === 'geometry') {
    const geometries = [
        ['uniform', 'sparse2'], ['spiral', 'sparse2'], ['collinear', 'sparse2'], ['clustered', 'sparse2'],
        ['hubs', 'hubs2'], ['components', 'components2'], ['sparse', 'sparse2'], ['dense', 'dense10'], ['coincident', 'duplicates2'],
    ];
    for (const [shape, family] of geometries) {
        const vaultId = tag(family === 'components2' || family === 'duplicates2' ? 'shape' : 'timed', 5000, family);
        const linked = emitted.get(vaultId);
        if (!linked) throw new Error(`Missing geometry's vault ${vaultId}`);
        const id = `g1-geometry-005000-${shape}`;
        const points = coordinates(shape, 5000, randomFor(id));
        await emit(id, { schema: 1, kind: 'geometry-sidecar', seed, shape, units: 'world units', nodeCount: 5000,
            vault: { file: linked.file, sha256: linked.sha256 }, ids: linked.paths, ...points,
            vx: Array(5000).fill(0), vy: Array(5000).fill(0),
            ...(shape === 'coincident' ? { coincidentPairs: [{ indices: [0, 20], ids: [linked.paths[0], linked.paths[20]], indexSeparation: 20 }] } : {}),
            application: 'G1 seed-patched reference/candidate browser builds only. G0 does not apply coordinates or add a mutable hook.' },
        { purpose: `5000-node ${shape} kernel input, not an alternate G0 app seed`, gates: ['G1', 'G-L2'],
            features: ['geometry-sidecar', shape], expected: { kind: 'geometry-sidecar', role: 'G1', nodeCount: 5000, coincidentIndexSeparation: shape === 'coincident' ? 20 : null } });
    }
}

if (['all', 'exact', 'geometry'].includes(set)) {
    for (const count of [32, 600]) {
        const linked = emitted.get(tag('exact', count, 'duplicates2'));
        const id = `g1-geometry-${pad(count)}-coincident`;
        await emit(id, { schema: 1, kind: 'geometry-sidecar', seed, shape: 'coincident', units: 'world units', nodeCount: count,
            vault: { file: linked.file, sha256: linked.sha256 }, ids: linked.paths, ...coordinates('coincident', count, randomFor(id)),
            vx: Array(count).fill(0), vy: Array(count).fill(0),
            coincidentPairs: [{ indices: [0, 20], ids: [linked.paths[0], linked.paths[20]], indexSeparation: 20 }],
            application: 'G1 seed-patched exact-kernel browser builds only; never applied by G0.' },
        { purpose: `${count}-node index-20 near-coincidence exactness input`, gates: ['G1', 'G-L1'],
            features: ['geometry-sidecar', 'coincident'], expected: { kind: 'geometry-sidecar', role: 'G1', nodeCount: count, coincidentIndexSeparation: 20 } });
    }
}

await write('graphset-manifest.json', jsonBytes({ schema: 1, stream: 'core', generator, version, seed, selectedSet: set,
    fixtures: records.sort((a, b) => compareNames(a.id, b.id)),
    losses: ['Geometry sidecars are not applied by G0; current app always seeds a golden spiral.',
        'Duplicate basenames do not create coincident positions; no ambiguous basename is used as a link destination.',
        'Cross-machine byte determinism and redistribution licence approval remain separate V-05 obligations.'] }));
