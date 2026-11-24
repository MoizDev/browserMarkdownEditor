import type { Camera, Rect, Viewport } from '../../platform/types';
import { pagedPosition, type ViewportInsets } from '../../platform/render/camera';
import { pageAt } from '../../platform/render/pageStack';
import type { SheetId } from '../model/ids';
import { boardPageStack } from '../model/pages';
import type { AgentViewSnapshot } from './agentProjection';
import type { BoardRuntime } from './runtime';

export interface RecordedNativeAgentView {
    readonly sheet: SheetId;
    readonly region: Readonly<Rect>;
    readonly view: AgentViewSnapshot;
}
/** A board's own camera, as the view presents it right now. */
export interface NativeAgentViewInput {
    readonly camera: Readonly<Camera>;
    readonly viewport: Readonly<Viewport>;
    readonly insets: Readonly<ViewportInsets>;
    /** The view's own dark-mode page inversion (a PDF ink board's pages). */
    readonly inverted?: boolean;
}
// Metadata only: hiding/unmounting a view must not destroy the logical region
// the agent was shown. Neither a CameraController nor mutable content lives here.
const recorded = new WeakMap<BoardRuntime, RecordedNativeAgentView>();

/** What a camera shows of this board, without recording it. Null when the camera cannot describe a view (unmeasured). */
export function snapshotNativeAgentView(runtime: BoardRuntime, input: NativeAgentViewInput): RecordedNativeAgentView | null {
    const { camera, viewport } = input, doc = runtime.session.doc;
    if (doc.kind !== 'whiteboard' && doc.kind !== 'notebook' && doc.kind !== 'pdf-ink') return null;
    if (![camera.x, camera.y, camera.z, viewport.width, viewport.height].every(Number.isFinite)
        || camera.z <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
    const selection = runtime.selection.getSnapshot(), sheet = doc.sheets.get(selection.sheet);
    if (!sheet) return null;
    const region = Object.freeze({ x: camera.x, y: camera.y, width: viewport.width / camera.z, height: viewport.height / camera.z });
    const selectedShapeIds = [...selection.selected];
    let view: AgentViewSnapshot;
    if (doc.kind === 'whiteboard') {
        view = { kind: 'drawing', pageName: sheet.name, pageIndex: doc.sheetOrder.findIndex(value => value.id === sheet.id) + 1,
            pageCount: doc.sheetOrder.length, camera: { x: -camera.x, y: -camera.y, z: camera.z },
            viewport: { x: region.x, y: region.y, w: region.width, h: region.height }, selectedShapeIds };
    } else {
        const stack = boardPageStack(doc.host), position = stack && pagedPosition(camera, viewport, stack, input.insets);
        if (!stack || !position || (doc.host.kind !== 'notebook' && doc.host.kind !== 'pdf-ink')) return null;
        const visiblePages: number[] = [];
        const first = Math.max(0, pageAt(stack, region.y)), last = Math.min(stack.rects.length - 1, pageAt(stack, region.y + region.height));
        for (let index = first; index <= last; index++) {
            const page = stack.rects[index];
            if (page.x < region.x + region.width && page.x + page.width > region.x
                && page.y < region.y + region.height && page.y + page.height > region.y) visiblePages.push(index + 1);
        }
        if (doc.host.kind === 'pdf-ink') {
            view = { kind: 'pdf-annotate', surface: 'annotation', pageCount: stack.rects.length, page: position.page + 1,
                offset: position.offset, zoom: position.zoom, visiblePages, selectedText: null,
                inverted: input.inverted ?? false, selectedShapeIds };
        } else {
            const paper = doc.host.paper;
            view = { kind: 'notebook', pageCount: stack.rects.length, page: position.page + 1, offset: position.offset,
                zoom: position.zoom, visiblePages, paper: `${paper.ruling} · ${paper.size} · ${paper.orientation}`, selectedShapeIds };
        }
    }
    return { sheet: selection.sheet, region, view };
}

export function recordNativeAgentViewport(runtime: BoardRuntime, input: NativeAgentViewInput & {
    readonly focused?: boolean;
}): void {
    if (input.focused === false && recorded.has(runtime)) return;
    const next = snapshotNativeAgentView(runtime, input);
    if (next) recorded.set(runtime, next);
}

export function readNativeAgentViewport(runtime: BoardRuntime): RecordedNativeAgentView | null {
    const value = recorded.get(runtime), doc = runtime.session.doc;
    if (!value || !doc.sheets.has(value.sheet)) return null;
    const result = structuredClone(value);
    const selectedShapeIds = result.view.selectedShapeIds?.filter(id => doc.nodes.has(id as Parameters<typeof doc.nodes.has>[0])) ?? [];
    if (result.view.kind === 'drawing') {
        return { ...result, view: { ...result.view, pageName: doc.sheets.get(result.sheet)!.name,
            pageIndex: doc.sheetOrder.findIndex(sheet => sheet.id === result.sheet) + 1,
            pageCount: doc.sheetOrder.length, selectedShapeIds } };
    }
    return { ...result, view: { ...result.view, selectedShapeIds } };
}
