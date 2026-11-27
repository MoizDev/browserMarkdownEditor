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

export async function rotateNativePdf(runtime: PdfiumRuntime, args: Rotate['args'], context: WorkerContext): Promise<Rotate['result']> {
    if (!(args.source instanceof Blob) || !args.source.size || args.source.size >= 0x80000000) throw new PdfEngineError('InvalidPdf', 'Invalid rotation source');
    const bytes = new Uint8Array(await args.source.arrayBuffer());
    await context.slice();
    const role = await inspectPdfRole(bytes, '');
    await context.slice();
    const safety = role.writeSafety;
    if (safety.kind === 'signed') return refusal('signed');
    if (safety.kind === 'encrypted' || role.kind === 'unreadable' && role.reason === 'encrypted') return refusal('encrypted');
    if (role.kind === 'annotated') return refusal('legacy-annotations');
    if (role.kind === 'unreadable') return refusal('missing-attachment');
    if (role.kind === 'ambiguous') return refusal('unverified');
    if (safety.kind !== 'safe') return refusal('unsafe-policy');
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

export async function verifyNativeRotation(runtime: PdfiumRuntime, args: Verify['args'], context: WorkerContext): Promise<Verify['result']> {
    if (!(args.source instanceof Blob) || !(args.bytes instanceof ArrayBuffer)) throw new PdfEngineError('InvalidPdf', 'Invalid rotation verification');
    const input = new Uint8Array(await args.source.arrayBuffer()), output = new Uint8Array(args.bytes);
    if ((await inspectPdfRole(input, '')).kind === 'newer') await verifyInkRotation(runtime, input, output, args.base, args.rotations, context);
    else await verifyPageTurn(runtime, input, output, args.base, args.rotations, context, PAGE_TURN);
    context.transfer(args.bytes);
    return { bytes: args.bytes, pageCount: args.rotations.length };
}

