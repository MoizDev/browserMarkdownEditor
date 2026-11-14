import type { PageGeometry } from '../../platform/types';
import { Sha256 } from '../../utils/sha256';
import type { PdfEditableInkSource } from '../session/inkAcquisition.types';
import { hashNotebookOutput } from './verifyNotebookOutput';

function same(a: Readonly<PageGeometry>, b: Readonly<PageGeometry>): boolean {
    return a.index === b.index && a.width === b.width && a.height === b.height && a.rotate === b.rotate && a.userUnit === b.userUnit &&
        a.toUserSpace.length === 6 && b.toUserSpace.length === 6 && a.toUserSpace.every((n, i) => n === b.toUserSpace[i]);
}
async function hashBlob(blob: Blob, guard: () => void): Promise<string> {
    const digest = new Sha256();
    for (let i = 0; i < blob.size; i += 1024 * 1024) {
        guard(); const bytes = await blob.slice(i, i + 1024 * 1024).arrayBuffer(); guard(); digest.update(new Uint8Array(bytes));
    }
    guard(); return digest.digest();
}

/** Returns staged bytes only. App still owns baseline checks and its versioned write. */
export async function rotateNativePdfSource(options: {
    acquisition: PdfEditableInkSource; delta: number; pageIndices?: readonly number[]; signal: AbortSignal;
}): Promise<Uint8Array> {
    const { acquisition, signal } = options;
    const guard = () => { signal.throwIfAborted(); if (!acquisition.isCurrent()) throw new DOMException('PDF rotation source changed', 'AbortError'); };
    guard();
    if (acquisition.kind !== 'plain' || !Number.isFinite(options.delta) || !Number.isSafeInteger(options.delta / 90) ||
        !acquisition.pages.length || acquisition.source.outerFingerprint !== acquisition.source.pristineFingerprint) throw new Error('Only a current plain PDF can be rotated');
    const selected = options.pageIndices === undefined ? undefined : [...options.pageIndices];
    if (selected && (selected.length > acquisition.pages.length || new Set(selected).size !== selected.length ||
        selected.some(page => !Number.isSafeInteger(page) || page < 0 || page >= acquisition.pages.length))) throw new RangeError('Invalid PDF rotation page');
    const source = acquisition.source, originalHash = await hashBlob(source.outer, guard);
    guard();
    if (originalHash !== source.outerFingerprint || await hashBlob(source.pristine, guard) !== originalHash) throw new Error('PDF rotation source fingerprint changed');
    guard();
    const delta = ((options.delta % 360) + 360) % 360, input = { source, delta, ...(selected ? { pageIndices: selected } : {}) };
    const producer = await acquisition.openWriter(signal);
    let output: Awaited<ReturnType<typeof produce>>;
    const produce = () => producer.request('writer.rotate', input, { priority: 0, signal });
    try { guard(); output = await produce(); guard(); } finally { await producer.close(); }
    guard();
    if (output.sourceFingerprint !== originalHash || output.geometries.length !== acquisition.pages.length) throw new Error('PDF rotation output identity changed');
    const selection = selected && new Set(selected);
    for (let i = 0; i < acquisition.pages.length; i++) {
        const before = acquisition.pages[i], expected = output.geometries[i], changed = !selection || selection.has(i);
        if (expected.rotate !== (before.rotate + (changed ? delta : 0)) % 360 || (!changed && !same(before, expected))) {
            throw new Error('PDF rotation changed an unexpected page');
        }
    }
    const length = output.bytes.byteLength, outputHash = await hashNotebookOutput(output.bytes, signal);
    guard();
    const verifier = await acquisition.openWriter(signal);
    let verified: Awaited<ReturnType<typeof verify>>;
    const verify = () => verifier.request('writer.verifyRotation', { ...input, bytes: output.bytes, expected: output.geometries }, { priority: 0, signal });
    try { guard(); verified = await verify(); guard(); } finally { await verifier.close(); }
    guard();
    if (verified.bytes.byteLength !== length || verified.sourceFingerprint !== originalHash || verified.outputSha !== outputHash ||
        verified.geometries.length !== output.geometries.length || verified.geometries.some((page, i) => !same(page, output.geometries[i])) ||
        await hashNotebookOutput(verified.bytes, signal) !== outputHash || await hashBlob(source.outer, guard) !== originalHash) {
        throw new Error('PDF rotation output could not be independently verified');
    }
    guard();
    return new Uint8Array(verified.bytes);
}
