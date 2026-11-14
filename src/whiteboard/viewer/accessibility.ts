import type { RenderToken } from '../../platform/render/types';
import type { NodeId } from '../model/ids';
import type { Node } from '../model/nodes';
import type { SceneSpatial } from '../scene/types';
import type { SelectionState } from '../selection';
import type { BoardSession } from '../session/BoardSession';
import type { ViewerAccessibilityItem, ViewerAccessibilitySnapshot, ViewerAccessibilitySource } from './types';

// Provenance: viewer accessibility window, session selection and scene contracts;
// independent bounded projection without third-party source.
function labelText(value: string): string {
    if (value.length <= 1000) return value;
    let end = 1000;
    const previous = value.charCodeAt(end - 1), next = value.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    return value.slice(0, end);
}
export function createViewerAccessibility(options: {
    token: RenderToken; session: BoardSession; selection: SelectionState; scene: SceneSpatial;
    visibleIds: () => Iterable<NodeId>; label: (node: Readonly<Node>) => string; maxItems?: number;
}): ViewerAccessibilitySource & { invalidate(): void; dispose(): void } {
    const maxItems = options.maxItems ?? 200;
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 1000) throw new RangeError('Invalid accessibility window size');
    const token = Object.freeze({ ...options.token }), listeners = new Set<() => void>();
    const { session, selection, scene } = options;
    let cached: ViewerAccessibilitySnapshot | undefined, disposed = false;
    const invalidate = () => {
        if (disposed) return;
        cached = undefined;
        for (const listener of [...listeners]) listener();
    };
    const unsubscribeSelection = selection.subscribe(invalidate), unsubscribeSession = session.subscribe(invalidate);
    return {
        getSnapshot() {
            if (cached) return cached;
            if (disposed) throw new Error('Accessibility source disposed');
            const state = selection.getSnapshot(), doc = session.doc, revision = scene.revision, docRevision = doc.rev;
            const members = doc.bySheet.get(state.sheet);
            const items: ViewerAccessibilityItem[] = [], seen = new Set<NodeId>();
            const add = (id: NodeId) => {
                if (items.length >= maxItems || seen.has(id)) return;
                seen.add(id);
                const node = doc.nodes.get(id);
                if (!node || !members?.has(id)) return;
                const name = options.label(node);
                if (typeof name !== 'string') throw new TypeError('Accessibility label must be a string');
                items.push(Object.freeze({ id, label: labelText(name), selected: selection.has(id) }));
            };
            if (state.active) add(state.active);
            if (state.focus !== state.sheet) add(state.focus as NodeId);
            let selectedVisited = 0;
            for (const id of state.selected) { if (items.length >= maxItems || selectedVisited++ >= maxItems * 8 + 256) break; add(id); }
            if (items.length < maxItems) {
                let visited = 0;
                for (const id of options.visibleIds()) {
                    if (items.length >= maxItems || visited++ >= maxItems * 8 + 256) break;
                    add(id);
                }
            }
            if (selection.getSnapshot() !== state || scene.revision !== revision || doc.rev !== docRevision) throw new Error('Accessibility view changed during snapshot');
            cached = Object.freeze({ token, sceneRevision: revision, sheetName: doc.sheets.get(state.sheet)?.name ?? '',
                total: members?.size ?? 0, items: Object.freeze(items), selectedCount: state.selected.length, focusedId: state.active });
            return cached;
        },
        subscribe(listener) {
            if (disposed) return () => {};
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        invalidate,
        dispose() {
            if (disposed) return;
            disposed = true; unsubscribeSelection(); unsubscribeSession(); listeners.clear(); cached = undefined;
        },
    };
}
