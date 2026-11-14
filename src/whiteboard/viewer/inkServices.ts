import type { CameraController } from '../../platform/render/camera';
import { pageAt } from '../../platform/render/pageStack';
import { notebookGrowthOp } from '../commands/pagesAndSheets';
import { styleGeometryMetrics } from '../geom/styleMetrics';
import type { BoardRuntime } from '../host/runtime';
import type { BoardInputServices } from '../input/attach';
import { createInkContinuation } from '../input/continueInk';
import type { MappingHistory } from '../input/pointer';
import type { InputToken, RealSample } from '../input/tool';
import { SampleStore } from '../ink/samples';
import { boardPageStack } from '../model/pages';
import type { UiBlock } from '../model/styles';

// Sequence is shared by every view of a session, not reset when a pane remounts.
const sequences = new WeakMap<object, number>();
export interface BoardInkServicesOptions {
    readonly runtime: BoardRuntime;
    readonly samples: SampleStore;
    readonly token: InputToken;
    readonly current: (token: InputToken) => boolean;
    /** A fresh read at pointer down; colour and width stay fixed for that stroke. */
    readonly style: () => Pick<UiBlock, 'next' | 'penWidth'>;
    readonly camera: CameraController;
    /** PointerAcquisition has already applied this history to every RealSample. */
    readonly mappings: MappingHistory;
    readonly invalidate: () => void;
    readonly onError: (error: unknown) => void;
}

/** Concrete authoring services; sessionInkTool owns the one atomic transaction. */
export function createBoardInkServices(options: BoardInkServicesOptions): Pick<BoardInputServices, 'ink' | 'continueInk'> {
    const { runtime, samples, camera } = options, session = runtime.session;
    if (session.samples !== samples) throw new TypeError('Ink requires the session-owned sample store');
    return {
        continueInk: createInkContinuation({ session, samples, current: () => options.current(options.token),
            sheet: () => runtime.selection.getSnapshot().sheet, declaredMaxScale: () => Math.max(8, camera.camera.z * 8) }),
        ink(tool: 'pen' | 'highlighter', first: RealSample) {
            if (!options.current(options.token) || session.isReadOnly) throw new Error('Ink view is no longer editable');
            if (![first.x, first.y, camera.camera.z, camera.viewport.dpr].every(Number.isFinite)
                || camera.camera.z <= 0 || camera.viewport.dpr <= 0) throw new RangeError('Invalid ink input mapping');
            const sheet = runtime.selection.getSnapshot().sheet;
            if (!session.doc.sheets.has(sheet)) throw new Error('Ink target sheet is unavailable');
            const stack = boardPageStack(session.doc.host);
            const page = stack ? pageAt(stack, first.y) : 0;
            const origin = stack?.rects[page];
            if (stack && !origin) throw new Error('Ink target page is unavailable');
            const offset = { x: origin?.x ?? 0, y: origin?.y ?? 0 };
            const ui = options.style();
            const color = tool === 'pen' ? ui.next.color : ui.next.highlighterColor;
            const width = styleGeometryMetrics.fromPen(tool === 'pen' ? 'stroke:pen' : 'stroke:highlighter', ui.penWidth);
            if (!Number.isFinite(width) || width <= 0) throw new RangeError('Invalid ink width');
            const captureDeviceScale = camera.camera.z * camera.viewport.dpr;
            const declaredMaxScale = Math.max(8, camera.camera.z * 8);
            return {
                sheet, page, color, width, captureDeviceScale, declaredMaxScale,
                nextSequence() {
                    const next = (sequences.get(session) ?? 0) + 1;
                    if (!Number.isSafeInteger(next)) throw new RangeError('Ink gesture sequence exhausted');
                    sequences.set(session, next); return next;
                },
                admit: builder => samples.commit(builder),
                retainWet: ref => samples.retain(ref),
                invalidate: options.invalidate,
                error: options.onError,
                // The acquired input and keyboard cursor already use shared-camera world coordinates.
                mapPoint: sample => ({ x: sample.x - offset.x, y: sample.y - offset.y }),
                localToWorld: point => [1, 0, 0, 1, point.x + offset.x, point.y + offset.y],
                planStroke(node, summary) {
                    if (session.doc.host.kind !== 'notebook' || !summary) return [];
                    // Use only the sealed real-sample prefix: prediction never grows a page.
                    const [, y, , height] = summary.localBounds;
                    const deepest = offset.y + node.y + y + height + node.width + node.fairTol;
                    const growth = notebookGrowthOp(session.doc, deepest);
                    return growth ? [growth] : [];
                },
            };
        },
    };
}
