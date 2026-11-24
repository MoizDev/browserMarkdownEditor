import type { RenderToken } from '../../platform/render/types';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { ExternalClipboardAdmission, ExternalClipboardSource } from '../clipboard/paste';
import type { ExcalidrawBindingRequest } from '../clipboard/excalidraw';
import type { HtmlClipboardSource } from '../clipboard/htmlPaste';
import { worldPose } from '../change/coordinates';
import type { Affine } from '../../platform/types';
import { inverse, transformPoint } from '../geom/affine';
import { SampleStore } from '../ink/samples';
import type { BoardDoc } from '../model/doc';
import type { MediaEntry, MediaId } from '../model/media';
import type { SheetId } from '../model/ids';
import type { Attachment, Node } from '../model/nodes';
import { MediaStore } from '../media/store';
import { createBoardRenderServices } from '../render/services';
import type { JobContext } from '../security/admission';
import { importDeadline } from '../workers/client';
import { validBoardIdentity, type BoardJobIdentity } from '../workers/protocol';
import { admitLoadedClipboard, admitNativeClipboardRecords, type ClipboardAdmissionContext } from './clipboardAdmission';
import { acquireLegacyBoard } from './legacyAcquisition';
import { acquireNativeBoard } from './nativeAcquisition';
import { encodeExternalNativeSource } from './nativeSourceBuilder';
import { yieldToHost } from '../../platform/yieldToHost';

// Provenance: external clipboard source semantics composed from the native source builder,
// C5 admission, and the canonical attachment surface of the target node; no third-party source.

export interface ExternalClipboardAdmitterOptions {
    /** The render owner token the copying board runtime was created with. */
    readonly token: RenderToken;
    /** Host's maximum CSS-px/world-unit scale, as the encoder and legacy preparation require. */
    readonly zMax: number;
    readonly memory: MemoryAllocator;
    /** Reads one media entry's bytes from the copying host for native sources. */
    readBlob(entry: MediaEntry, signal: AbortSignal): Promise<Blob | null>;
    /** App alone resolves relative legacy resources; absent means relative resources are refused. */
    readAsset?(src: string, signal: AbortSignal): Promise<Blob | null>;
    isCurrent(identity: BoardJobIdentity): boolean;
    cooperate?(): Promise<void>;
}

export interface ExternalClipboardAdmitter {
    admitExternal(source: ExternalClipboardSource, context: JobContext, identity: BoardJobIdentity): Promise<ExternalClipboardAdmission>;
    resolveBinding(request: ExcalidrawBindingRequest, context: { readonly actualDraftDoc: BoardDoc; readonly signal: AbortSignal }): Promise<Attachment>;
}

function clipboardContext(options: ExternalClipboardAdmitterOptions, context: JobContext, identity: BoardJobIdentity,
    readBlob: ClipboardAdmissionContext['readBlob']): ClipboardAdmissionContext {
    return { token: options.token, identity, isCurrent: options.isCurrent, readBlob, signal: context.signal,
        ...(options.cooperate ? { cooperate: options.cooperate } : {}) };
}

/** Converted nodes are encoded as one native file and then admitted through the same C5 path as
 * any native clipboard, so nothing bypasses the real acquisition. Their media blobs are the
 * converter's own inspected blobs, read once through the source. */
async function admitConvertedNodes(source: { sheet: SheetId; nodes: readonly Node[]; media: readonly MediaEntry[];
    blobs: ReadonlyMap<MediaId, Blob>; samples: SampleStore },
    options: ExternalClipboardAdmitterOptions, context: JobContext, identity: BoardJobIdentity): Promise<ExternalClipboardAdmission> {
    const cooperate = options.cooperate ?? yieldToHost;
    const bytes = await encodeExternalNativeSource(source, { token: options.token, zMax: options.zMax, signal: context.signal, cooperate });
    return admitNativeClipboardRecords(bytes, clipboardContext(options, context, identity, async (entry, signal) =>
        source.blobs.get(entry.id) ?? options.readBlob(entry, signal)));
}

/** Legacy content is admitted through the real legacy conversion, whose native result is then
 * measured like any other admission. Its native probe supplies the actual report legacy scanning needs. */
async function admitLegacyEnvelope(content: Blob, options: ExternalClipboardAdmitterOptions, context: JobContext, identity: BoardJobIdentity)
    : Promise<ExternalClipboardAdmission> {
    const cooperate = options.cooperate ?? yieldToHost;
    const probe = await acquireNativeBoard({ bytes: content, kind: 'whiteboard',
        identity: { session: identity.session, epoch: identity.epoch, generation: identity.revision },
        signal: context.signal, deadlineMs: importDeadline(content.size), cooperate });
    const nativeReport = { format: probe.report.format, complete: probe.report.complete, bytesRead: probe.report.bytesRead };
    probe.dispose();
    const legacy = await acquireLegacyBoard({ bytes: content, kind: 'whiteboard', host: { kind: 'whiteboard' }, token: options.token,
        zMax: options.zMax, memory: options.memory, nativeReport, identity, isCurrent: options.isCurrent, signal: context.signal, cooperate, urgent: true,
        ...(options.readAsset ? { readAsset: options.readAsset } : {}) });
    if (legacy.status !== 'editable') {
        legacy.dispose();
        throw new Error('Legacy clipboard content could not be converted without loss');
    }
    // Owned legacy media are the blobs the conversion verified; no other source can supply them.
    return admitLoadedClipboard({ load: legacy.native.load, samples: legacy.native.samples, report: legacy.native.report, dispose: legacy.dispose },
        clipboardContext(options, context, identity, async entry => legacy.media.get(entry.id) ?? null));
}

/** Pure canonical attachment: an Excalidraw fixed point is a normalized anchor on the target's logical box,
 * otherwise the endpoint is taken in that box's local space. Both use the connector surface convention. */
function anchorOf(request: ExcalidrawBindingRequest, box: { x: number; y: number; width: number; height: number }, inverseMatrix: Affine)
    : { anchor: { x: number; y: number }; exact: boolean; snap: Attachment['snap'] } {
    if (request.fixedPoint) return { anchor: { x: request.fixedPoint[0], y: request.fixedPoint[1] }, exact: true, snap: 'none' };
    const local = transformPoint(inverseMatrix, request.endWorld);
    const coordinate = (value: number, start: number, size: number) => size === 0 ? 0.5 : Math.max(0, Math.min(1, (value - start) / size));
    return { anchor: { x: coordinate(local.x, box.x, box.width), y: coordinate(local.y, box.y, box.height) }, exact: false,
        snap: 'edge' };
}

export function createExternalClipboardAdmitter(options: ExternalClipboardAdmitterOptions): ExternalClipboardAdmitter {
    return {
        async admitExternal(source, context, identity) {
            context.signal.throwIfAborted();
            if (!validBoardIdentity(identity)) throw new TypeError('External clipboard admission requires a valid job identity');
            switch (source.kind) {
                case 'native-records': return admitNativeClipboardRecords(source.bytes,
                    clipboardContext(options, context, identity, (entry, signal) => options.readBlob(entry, signal)));
                case 'legacy': return admitLegacyEnvelope(source.decoded.content, options, context, identity);
                case 'excalidraw': return admitConvertedNodes({ sheet: source.draft.sheet, nodes: source.draft.nodes, media: source.draft.media,
                    blobs: source.draft.blobs, samples: source.draft.samples }, options, context, identity);
                case 'html': {
                    const html: HtmlClipboardSource = source.source;
                    return admitConvertedNodes({ sheet: html.provisionalSheet, nodes: html.nodes, media: html.media, blobs: html.blobs,
                        samples: new SampleStore() }, options, context, identity);
                }
            }
        },
        async resolveBinding(request, context) {
            context.signal.throwIfAborted();
            const doc = context.actualDraftDoc;
            // The target is read from the draft document itself, never from a caller's copy.
            const target = doc.nodes.get(request.targetId);
            if (!target) throw new Error('Excalidraw binding target is not in the draft document');
            const services = createBoardRenderServices({ doc, samples: new SampleStore(), media: new MediaStore(), token: options.token });
            try {
                const prepared = await services.prepareForPick(target, context.signal, doc);
                const box = prepared.vector?.attachments?.logicalBox;
                if (!box) throw new Error(`Excalidraw binding target ${request.targetId} has no attachment surface`);
                const pose = worldPose(doc, request.targetId), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
                const localToWorld: Affine = [c, s, -s, c, pose.x, pose.y];
                const inverseMatrix = inverse(localToWorld, 1e12);
                if (!inverseMatrix) throw new Error('Excalidraw binding target transform is not invertible');
                const { anchor, exact, snap } = anchorOf(request, box, inverseMatrix);
                return { target: request.targetId, anchor, exact, precise: true, snap };
            } finally { services.dispose(); }
        },
    };
}
