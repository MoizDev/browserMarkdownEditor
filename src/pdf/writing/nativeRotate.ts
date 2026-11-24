import type { WorkerContext } from '../../platform/workers/serve';
import { inspectPdfRole } from '../../utils/pdfAttachmentInventory';
import { canRotatePdfRole } from '../../utils/pdfRole';
import { PdfEngineError } from '../engine/types';
import type { PdfiumRuntime } from '../engine/pdfium/loader';
import { planInkRotation, verifyInkRotation } from './inkRotation';
import { PdfSyntaxError } from './rotationReader';
import { planRotation } from './rotationUpdate';
import { PAGE_TURN, verifyPageTurn } from './rotationVerify';
import type { RotationRefusal, WriterOperations } from './protocol';

type Rotate = WriterOperations['writer.rotate'];
type Verify = WriterOperations['writer.verifyRotation'];

function refusal(cause: RotationRefusal): Rotate['result'] { return { kind: 'refused', cause }; }

/** Builds the appended section in the writer worker. The safety gates are the ones every rotation always had
 * (outer write safety 'safe', a role this writer can carry through a turn); a PDF annotated here turns with
 * its marks (inkRotation.ts), whose own inspection holds the embedded original and board to the same gates. */
export async function rotateNativePdf(runtime: PdfiumRuntime, args: Rotate['args'], context: WorkerContext): Promise<Rotate['result']> {
    if (!(args.source instanceof Blob) || !args.source.size || args.source.size >= 0x80000000) throw new PdfEngineError('InvalidPdf', 'Invalid rotation source');
    const bytes = new Uint8Array(await args.source.arrayBuffer());
    await context.slice();
    const role = await inspectPdfRole(bytes, '');
    await context.slice();
    const safety = role.writeSafety;
    if (safety.kind === 'signed') return refusal('signed');
    if (safety.kind === 'encrypted' || role.kind === 'unreadable' && role.reason === 'encrypted') return refusal('encrypted');
    // Classic (tldraw-era) annotations: their marks are in a format this writer does not rewrite. Annotate converts them.
    if (role.kind === 'annotated') return refusal('legacy-annotations');
    if (role.kind === 'unreadable' || role.kind === 'ambiguous') return refusal('missing-attachment');
    if (safety.kind !== 'safe') return refusal('unsafe-policy');
    // The role reader names every board attachment of this build 'newer' (it predates them); the ink inspection decides.
    if (role.kind === 'newer') return planInkRotation(runtime, bytes, args.turns, context);
    if (!canRotatePdfRole(role)) return refusal('unsafe-policy');
    try {
        const plan = await planRotation(bytes, args.turns, () => context.slice());
        if (!plan) return { kind: 'unchanged' };
        const appendix = plan.appendix.slice().buffer;
        context.transfer(appendix);
        return { kind: 'update', appendix, base: plan.base, pageCount: plan.pageCount, before: plan.before, rotations: plan.rotations };
    } catch (error) {
        if (error instanceof PdfSyntaxError) return refusal(/rotation/.test(error.message) ? 'unsupported-rotation' : 'unsupported-format');
        throw error;
    }
}

/**
 * A fresh writer proves the result before App may write it, with readers other than the one that built it:
 * (1) the result begins with the source's bytes, exactly; (2) whatever follows them is one section in this
 * writer's shape, redefining only page objects; (3) pdf-lib, reading the whole result, finds every page as
 * this writer's reader finds it in the untouched prefix but for /Rotate, at exactly the expected angles, and
 * nothing turned that should not be; (4) PDFium opens it with the same page count, and on a sample of pages
 * reads each size swapped or kept as its turn says and the expected /Rotate. The write safety of the
 * prefix was established by the planner; (3) proves the section adds nothing that could change it.
 */
export async function verifyNativeRotation(runtime: PdfiumRuntime, args: Verify['args'], context: WorkerContext): Promise<Verify['result']> {
    if (!(args.source instanceof Blob) || !(args.bytes instanceof ArrayBuffer)) throw new PdfEngineError('InvalidPdf', 'Invalid rotation verification');
    const input = new Uint8Array(await args.source.arrayBuffer()), output = new Uint8Array(args.bytes);
    // The verifier reads the source's role itself: a planner that took an annotated PDF for a plain one is caught here.
    if ((await inspectPdfRole(input, '')).kind === 'newer') await verifyInkRotation(runtime, input, output, args.base, args.rotations, context);
    else await verifyPageTurn(runtime, input, output, args.base, args.rotations, context, PAGE_TURN);
    context.transfer(args.bytes);
    return { bytes: args.bytes, pageCount: args.rotations.length };
}

