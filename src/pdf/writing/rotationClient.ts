import { getSharedPdfPool } from '../session/startup';
import type { RotationRefusal } from './protocol';
import { typedPdfWriter } from './writerClient';

export type PdfRotationResult =
    | { kind: 'refused'; cause: RotationRefusal }
    | { kind: 'unchanged' }
    | { kind: 'update'; bytes: Uint8Array; base: number; pageCount: number; before: number[]; rotations: number[] };

/**
 * Turns pages by appending an incremental update (rotationUpdate.ts), proven before it is returned.
 * Returns bytes only: App still owns the baseline check and its versioned write.
 *
 * Two writers, in turn: one plans the appended section from `source`, a fresh one proves the result
 * (exact prefix, section shape, pdf-lib and PDFium re-reads) — the planner never vouches for itself.
 * The result is assembled HERE from `source`'s own first `base` bytes, so the original reaches the
 * file as a byte-exact prefix by construction, and the verifier checks that again.
 */
export async function rotatePdfIncrementally(options: {
    source: Blob; turns: { all: number; pages: Array<[number, number]> }; signal: AbortSignal;
}): Promise<PdfRotationResult> {
    const { source, turns, signal } = options;
    const pool = getSharedPdfPool();
    const planner = typedPdfWriter(await pool.writer({ signal }));
    let plan: Awaited<ReturnType<typeof planner.request<'writer.rotate'>>>;
    try { plan = await planner.request('writer.rotate', { source, turns }, { priority: 0, signal }); }
    finally { await planner.close(); }
    signal.throwIfAborted();
    if (plan.kind !== 'update') return plan;
    const { base, appendix } = plan;
    const output = new Uint8Array(base + appendix.byteLength);
    output.set(new Uint8Array(await source.slice(0, base).arrayBuffer()));
    output.set(new Uint8Array(appendix), base);
    signal.throwIfAborted();
    const verifier = typedPdfWriter(await pool.writer({ signal }));
    let proof: Awaited<ReturnType<typeof verifier.request<'writer.verifyRotation'>>>;
    // The output buffer is transferred to the verifier and comes back as proof.bytes.
    const length = output.byteLength;
    try { proof = await verifier.request('writer.verifyRotation', { source, bytes: output.buffer, base, rotations: plan.rotations }, { priority: 0, signal }); }
    finally { await verifier.close(); }
    signal.throwIfAborted();
    if (proof.bytes.byteLength !== length || proof.pageCount !== plan.pageCount) throw new Error('PDF rotation output could not be independently verified');
    return { kind: 'update', bytes: new Uint8Array(proof.bytes), base, pageCount: plan.pageCount, before: plan.before, rotations: plan.rotations };
}
