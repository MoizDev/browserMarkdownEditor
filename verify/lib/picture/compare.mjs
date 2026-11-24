import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, differenceImage, sha256, writePng } from './png.mjs';
import { bestShiftSsim } from './ssim.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const MASKS = new URL('./glyph-masks.manifest.json', import.meta.url);

// planning/40-platform/verification.md:236–242. These are the programme's budgets,
// not tunables chosen by a caller or values inferred from an observed difference.
const A_MAX_CHANNEL = 1;
const A_CHANGED_FRACTION = 0.0001; // line 236: 0.01% (not 0.01 as a fraction).
const B_MAX_CHANNEL = 8;
const B_OVER_TWO_FRACTION = 0.005; // line 237: 0.5%.
const B_MIN_SSIM = 0.99;
const B_MASS_MIN = 0.95; // lines 241–242, overall coverage.
const B_MASS_MAX = 1.05;
const CELL_SIZE = 32;
const B_CELL_RELATIVE = 0.1;
const C_MAX_CHANNEL = 4; // line 238: no glyph allowance without a reviewed mask.
const C_GLYPH_MAX_CHANNEL = 8;

function channelDelta(a, ai, b, bi) {
    let delta = 0;
    for (let channel = 0; channel < 4; channel++) delta = Math.max(delta, Math.abs(a[ai + channel] - b[bi + channel]));
    return delta;
}

function nearestDelta(source, target, x, y) {
    const offset = (y * source.width + x) * 4;
    let best = 255;
    for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= target.height) continue;
        for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= target.width) continue;
            best = Math.min(best, channelDelta(source.data, offset, target.data, (yy * target.width + xx) * 4));
            if (best === 0) return 0;
        }
    }
    return best;
}

function inkAt(image, offset, background) {
    return image.data[offset + 3] / 255 * (
        Math.abs(image.data[offset] - background[0]) +
        Math.abs(image.data[offset + 1] - background[1]) +
        Math.abs(image.data[offset + 2] - background[2]));
}

function inkMass(expected, actual, background, shift) {
    const columns = Math.ceil(expected.width / CELL_SIZE);
    const rows = Math.ceil(expected.height / CELL_SIZE);
    const referenceCells = new Float64Array(columns * rows);
    const candidateCells = new Float64Array(columns * rows);
    let reference = 0;
    let candidate = 0;
    const [dx, dy] = shift;
    for (let y = 0; y < expected.height; y++) {
        for (let x = 0; x < expected.width; x++) {
            const offset = (y * expected.width + x) * 4;
            const massA = inkAt(expected, offset, background);
            const massB = inkAt(actual, offset, background);
            reference += massA;
            candidate += massB;
            const cell = Math.floor(y / CELL_SIZE) * columns + Math.floor(x / CELL_SIZE);
            referenceCells[cell] += massA;
            const xx = x + dx;
            const yy = y + dy;
            // Outside the translated image there is no candidate ink. Full-image totals
            // above still include ALL original pixels, not just the translated overlap.
            if (xx >= 0 && xx < actual.width && yy >= 0 && yy < actual.height) {
                candidateCells[cell] += dx || dy ? inkAt(actual, (yy * actual.width + xx) * 4, background) : massB;
            }
        }
    }
    const ratio = reference === 0 ? null : candidate / reference;
    const overallPassed = reference === 0 ? candidate === 0 : ratio >= B_MASS_MIN && ratio <= B_MASS_MAX;
    const failures = [];
    for (let cell = 0; cell < referenceCells.length; cell++) {
        const a = referenceCells[cell];
        const b = candidateCells[cell];
        // vr-lead's explicit zero/tiny-cell ruling: NO positive-mass floor or absolute
        // epsilon. An AA-only false failure stays visible for an evidence-based review.
        const passed = a === 0 ? b === 0 : Math.abs(b - a) <= a * B_CELL_RELATIVE;
        if (!passed) failures.push({ column: cell % columns, row: Math.floor(cell / columns), reference: a, candidate: b, ratio: a === 0 ? null : b / a });
    }
    return {
        definition: 'alpha-weighted RGB L1 distance from declared background; channel-levels times pixels',
        background, reference, candidate, ratio, overallPassed,
        cells: { size: CELL_SIZE, columns, rows, shift, zeroPolicy: 'reference zero requires exact candidate zero; every positive reference uses relative 10%, no floor', failures },
        passed: overallPassed && failures.length === 0,
    };
}

async function glyphMask(fixture, expectedHash, width, height) {
    const manifestBytes = await readFile(MASKS);
    const manifest = JSON.parse(manifestBytes);
    if (manifest.schema !== 1) throw new Error('Unknown glyph-mask manifest schema');
    const record = manifest.masks.find(record => record.fixture === fixture.id && record.dpr === fixture.dpr && record.expectedImageSha256 === expectedHash);
    if (!record || record.review?.approvedBy !== 'p-lead' || !record.review.reference || record.fixtureSha256 !== fixture.sha256) {
        throw new Error('No p-lead-reviewed mask for this exact named fixture, DPR, source hash and expected capture; C has no allowance');
    }
    if (!/^[a-f0-9]{64}$/.test(record.sha256) || !record.file || record.file.includes('\\')) throw new Error('Invalid reviewed mask identity');
    const path = resolve(ROOT, record.file);
    if (!path.startsWith(`${ROOT}/`)) throw new Error('Glyph mask must be repository-relative');
    const bytes = await readFile(path);
    if (sha256(bytes) !== record.sha256) throw new Error('Reviewed glyph mask changed');
    const mask = decodePng(bytes);
    if (mask.width !== width || mask.height !== height) throw new Error('Reviewed glyph mask dimensions differ from the capture');
    const allowed = new Uint8Array(width * height);
    for (let i = 0; i < allowed.length; i++) {
        const offset = i * 4;
        const r = mask.data[offset], g = mask.data[offset + 1], b = mask.data[offset + 2], a = mask.data[offset + 3];
        if (r === 255 && g === 255 && b === 255 && a === 255) allowed[i] = 1;
        else if (a !== 0 && (r !== 0 || g !== 0 || b !== 0)) throw new Error('Reviewed glyph mask must be binary white/black or transparent');
    }
    return { allowed, identity: record, manifestSha256: sha256(manifestBytes) };
}

/** Compare PNG bytes captured from the real app. No golden is created or changed here.
 * B requires an explicit background and a capture cropped to the document surface, not
 * app chrome; otherwise page/chrome ink would drown a missing stroke's coverage.
 */
export async function comparePictures({ expected: expectedBytes, actual: actualBytes, kind, fixture, outDir, name, useGlyphMask = false }) {
    if (!['A', 'B', 'C'].includes(kind) || !fixture?.id || !/^[a-f0-9]{64}$/.test(fixture.sha256 ?? '') || !/^[a-z0-9][a-z0-9._-]*$/i.test(name ?? '')) throw new Error('Comparison needs A/B/C, a named/hash-bound fixture and a portable artifact name');
    if (![1, 1.25, 2].includes(fixture.dpr)) throw new Error('Picture DPR must be declared as 1, 1.25 or 2');
    const expected = decodePng(expectedBytes);
    const actual = decodePng(actualBytes);
    const result = {
        kind, fixture, expectedSha256: sha256(expectedBytes), actualSha256: sha256(actualBytes),
        expectedSize: [expected.width, expected.height], actualSize: [actual.width, actual.height],
        passed: false, metrics: {},
    };
    if (expected.width === actual.width && expected.height === actual.height) {
        const pixels = expected.width * expected.height;
        let mask = null;
        if (useGlyphMask) {
            if (kind !== 'C') throw new Error('Only C may use the reviewed glyph-mask allowance');
            mask = await glyphMask(fixture, result.expectedSha256, expected.width, expected.height);
            result.glyphMask = { ...mask.identity, manifestSha256: mask.manifestSha256 };
        }
        let maxChannel = 0;
        let changed = 0;
        let overTwo = 0;
        let outsideBudget = 0;
        for (let y = 0; y < expected.height; y++) {
            for (let x = 0; x < expected.width; x++) {
                const i = y * expected.width + x;
                let delta = channelDelta(expected.data, i * 4, actual.data, i * 4);
                const allowance = kind === 'C' && mask?.allowed[i] === 1;
                if (kind === 'B' || allowance) {
                    delta = Math.max(nearestDelta(expected, actual, x, y), nearestDelta(actual, expected, x, y));
                }
                maxChannel = Math.max(maxChannel, delta);
                if (delta > 0) changed++;
                if (delta > 2) overTwo++;
                if (kind === 'C' && delta > (allowance ? C_GLYPH_MAX_CHANNEL : C_MAX_CHANNEL)) outsideBudget++;
            }
        }
        result.metrics = { pixels, maxChannel, changed, changedFraction: changed / pixels, overTwo, overTwoFraction: overTwo / pixels, outsideBudget };
        if (kind === 'A') result.passed = maxChannel <= A_MAX_CHANNEL && changed / pixels <= A_CHANGED_FRACTION;
        if (kind === 'C') result.passed = outsideBudget === 0;
        if (kind === 'B') {
            const background = fixture.background;
            if (!Array.isArray(background) || background.length !== 3 || background.some(value => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error('B needs the fixture\'s explicit RGB background');
            const ssim = bestShiftSsim(expected, actual, background);
            const mass = inkMass(expected, actual, background, ssim.shift);
            result.metrics.ssim = ssim;
            result.metrics.ink = mass;
            result.passed = maxChannel <= B_MAX_CHANNEL && overTwo / pixels <= B_OVER_TWO_FRACTION && ssim.value >= B_MIN_SSIM && mass.passed;
        }
    } else {
        result.reason = 'Capture dimensions differ';
    }
    if (!result.passed) {
        await mkdir(outDir, { recursive: true });
        const expectedPath = resolve(outDir, `${name}.expected.png`);
        const actualPath = resolve(outDir, `${name}.actual.png`);
        await writeFile(expectedPath, expectedBytes, { flag: 'wx' });
        await writeFile(actualPath, actualBytes, { flag: 'wx' });
        const difference = differenceImage(expected, actual);
        result.artifacts = {
            expected: expectedPath, actual: actualPath,
            difference: { ...await writePng(resolve(outDir, `${name}.difference.png`), difference), canvasScope: difference.canvasScope },
        };
    }
    return result;
}
