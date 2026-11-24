import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, differenceImage, sha256, writePng } from './png.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const json = value => `${JSON.stringify(value, null, 2)}\n`;
export const IMAGE_UI_FONT_NOTE = 'Image-only UI text uses bundled KaTeX fallback faces because Google-hosted/native platform faces are unavailable here. These goldens compare the image with itself, not how the app looks to a user.';

export function goldenKey(record) {
    return `${record.fixture.id}|${record.fixture.scenario ?? 'default'}|${record.dpr}|${record.kind}|${record.imageDigest}`;
}

export async function cacheGolden(store, bytes) {
    store = resolve(store);
    if (store === ROOT || store.startsWith(`${ROOT}/`)) throw new Error('Golden PNGs must never enter the repository');
    const hash = sha256(bytes);
    await mkdir(store, { recursive: true });
    const file = `${hash}.png`;
    const path = resolve(store, file);
    try { await writeFile(path, bytes, { flag: 'wx' }); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const previous = await readFile(path);
        if (previous.length !== bytes.length || sha256(previous) !== hash) throw new Error('Golden hash cache is corrupt; not overwriting it');
    }
    return { sha256: hash, bytes: bytes.length, file };
}

/** Stage ONLY a proposal. This never changes an approved manifest or chooses a new baseline.
 * A reviewed expected/actual/difference triple is required even for an initial identical pair.
 */
export async function proposeGoldens({ expectedDir, actualDir, comparisonDir, store, outDir, manifestPath = resolve(ROOT, 'verify/goldens.manifest.json') }) {
    const comparisonBytes = await readFile(resolve(comparisonDir, 'comparison.json'));
    const comparison = JSON.parse(comparisonBytes);
    if (comparison.status !== 'passed' || comparison.stage !== 'picture-comparison' || comparison.comparisons.filter(row => row.kind === 'A' && row.passed).length !== 3) throw new Error('A passing real-app two-container comparison is required before proposing goldens');
    const expected = JSON.parse(await readFile(resolve(expectedDir, 'capture.json'), 'utf8'));
    const actual = JSON.parse(await readFile(resolve(actualDir, 'capture.json'), 'utf8'));
    if (!expected.passed || !actual.passed || expected.dpr !== actual.dpr || expected.image.imageId !== actual.image.imageId) throw new Error('Golden proposal capture identities differ');
    let manifest = { schema: 1, goldens: [] };
    try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (manifest.schema !== 1) throw new Error('Unknown golden manifest schema');
    await mkdir(outDir, { recursive: false });
    const records = [];
    for (const name of ['note', 'pdf', 'drawing']) {
        const a = expected.frames.find(frame => frame.name === name);
        const b = actual.frames.find(frame => frame.name === name);
        if (!a || !b || a.file !== `${name}.png` || b.file !== `${name}.png` || a.fixture.id !== b.fixture.id || a.fixture.sha256 !== b.fixture.sha256) throw new Error(`Golden proposal lost its source identity: ${name}`);
        let expectedBytes = await readFile(resolve(expectedDir, a.file));
        const actualBytes = await readFile(resolve(actualDir, b.file));
        if (sha256(expectedBytes) !== a.sha256 || sha256(actualBytes) !== b.sha256) throw new Error('Capture changed after its comparison');
        const key = goldenKey({ fixture: b.fixture, dpr: actual.dpr, kind: 'A', imageDigest: actual.image.imageId });
        const previous = manifest.goldens.find(record => goldenKey(record) === key);
        if (previous) {
            if (!/^[a-f0-9]{64}$/.test(previous.sha256)) throw new Error('Invalid approved golden hash');
            if (previous.fixture.sha256 !== b.fixture.sha256) throw new Error('Source fixture changed under the same ID; add a reviewed new fixture identity');
            expectedBytes = await readFile(resolve(store, `${previous.sha256}.png`));
            if (sha256(expectedBytes) !== previous.sha256) throw new Error('Approved expected golden absent/changed; never replace it with a new matching pair');
        }
        const candidate = await cacheGolden(store, actualBytes);
        const expectedFile = resolve(outDir, `${name}.expected.png`);
        const actualFile = resolve(outDir, `${name}.actual.png`);
        await writeFile(expectedFile, expectedBytes, { flag: 'wx' });
        await writeFile(actualFile, actualBytes, { flag: 'wx' });
        const difference = await writePng(resolve(outDir, `${name}.difference.png`), differenceImage(decodePng(expectedBytes), decodePng(actualBytes)));
        records.push({
            fixture: b.fixture, dpr: actual.dpr, kind: 'A', imageDigest: actual.image.imageId,
            browserVersion: actual.browser.version, driverVersion: actual.browser.driverVersion,
            uiFontFallback: { note: IMAGE_UI_FONT_NOTE, requestedBodyFont: actual.requestedBodyFont, actualNoteFaces: actual.notePlatformFonts },
            ...candidate, appBuildManifestSha256: actual.build.manifestSha256, previousSha256: previous?.sha256 ?? null,
            stablePairExpectedSha256: a.sha256,
            reviewSet: { expected: `${name}.expected.png`, expectedSha256: sha256(expectedBytes), actual: `${name}.actual.png`, actualSha256: b.sha256, difference: { ...difference, path: `${name}.difference.png` } },
        });
    }
    const proposal = { schema: 1, status: 'awaiting-review', comparisonSha256: sha256(comparisonBytes), records,
        losses: ['One host only; no cross-host equality claim.', 'These are classic-app environment goldens, not the new platform GPU first-pixel gate.'] };
    const path = resolve(outDir, 'proposal.json');
    await writeFile(path, json(proposal), { flag: 'wx' });
    return { path, sha256: sha256(Buffer.from(json(proposal))), records: records.length };
}

/** Only an explicit reviewed note can admit a proposal. Ordinary runs never call this.
 * review.proposalSha256 binds the review to the exact triple, not the latest convenient image.
 */
export async function admitGoldens({ proposalPath, reviewPath, store, manifestPath }) {
    const proposalBytes = await readFile(proposalPath);
    const proposal = JSON.parse(proposalBytes);
    const reviewBytes = await readFile(reviewPath);
    const review = JSON.parse(reviewBytes);
    if (proposal.schema !== 1 || proposal.status !== 'awaiting-review' || review.status !== 'approved' || review.proposalSha256 !== sha256(proposalBytes) || !review.reviewer || !review.note) throw new Error('An explicit approved review bound to this proposal is required');
    let manifest = { schema: 1, store: 'external-sha256-pngs', goldens: [] };
    try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (manifest.schema !== 1) throw new Error('Unknown golden manifest schema');
    for (const record of proposal.records) {
        if (!/^[a-f0-9]{64}$/.test(record.sha256) || record.file !== `${record.sha256}.png`) throw new Error('Bad golden cache identity');
        const bytes = await readFile(resolve(store, record.file));
        if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) throw new Error('Reviewed golden is absent or changed in the cache');
        for (const [file, expectedHash] of [[record.reviewSet.expected, record.reviewSet.expectedSha256], [record.reviewSet.actual, record.reviewSet.actualSha256], [record.reviewSet.difference.path, record.reviewSet.difference.sha256]]) {
            if (!/^[a-z0-9][a-z0-9._-]*\.png$/i.test(file)) throw new Error('Reviewed image set must be relative PNG filenames beside the proposal');
            if (sha256(await readFile(resolve(dirname(proposalPath), file))) !== expectedHash) throw new Error('Reviewed image set changed');
        }
        const previous = manifest.goldens.findIndex(item => goldenKey(item) === goldenKey(record));
        if (previous >= 0 && manifest.goldens[previous].fixture.sha256 !== record.fixture.sha256) throw new Error('Source fixture changed under the same golden key');
        const admitted = { fixture: record.fixture, dpr: record.dpr, kind: record.kind, imageDigest: record.imageDigest, browserVersion: record.browserVersion, driverVersion: record.driverVersion,
            sha256: record.sha256, bytes: record.bytes, file: record.file, appBuildManifestSha256: record.appBuildManifestSha256, uiFontFallback: record.uiFontFallback,
            review: { reviewer: review.reviewer, noteSha256: sha256(reviewBytes), proposalSha256: sha256(proposalBytes), expectedSha256: record.reviewSet.expectedSha256, actualSha256: record.reviewSet.actualSha256, differenceSha256: record.reviewSet.difference.sha256 } };
        if (previous < 0) {
            if (record.previousSha256 !== null) throw new Error('Reviewed previous golden is no longer in the manifest');
            manifest.goldens.push(admitted);
        } else if (manifest.goldens[previous].sha256 !== admitted.sha256) {
            const old = manifest.goldens[previous];
            if (old.fixture.sha256 !== record.fixture.sha256 || old.sha256 !== record.previousSha256 || old.sha256 !== record.reviewSet.expectedSha256) throw new Error('Golden update did not review the currently approved expected image');
            manifest.goldens[previous] = { ...admitted, history: [...(old.history ?? []), { sha256: old.sha256, bytes: old.bytes, appBuildManifestSha256: old.appBuildManifestSha256, review: old.review }] };
        }
    }
    manifest.goldens.sort((a, b) => goldenKey(a) < goldenKey(b) ? -1 : goldenKey(a) > goldenKey(b) ? 1 : 0);
    await writeFile(manifestPath, json(manifest));
    return { manifestPath, goldens: manifest.goldens.length };
}
