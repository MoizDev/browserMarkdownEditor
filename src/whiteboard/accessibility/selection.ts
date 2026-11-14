import type { NodeId } from '../model/ids';
import type { SelectionState } from '../selection';
import type { RenderToken } from '../../platform/render/types';
import type { ViewerAccessibilitySnapshot, ViewerAccessibilitySource } from '../viewer/types';

export interface BoardAccessibilityItem {
    readonly id: string; readonly label: string; readonly selected: boolean;
    readonly name: string; readonly kind: string; readonly locked: boolean; readonly order: number;
}

export interface AccessibilityNode {
    readonly id: NodeId; readonly name: string; readonly kind: string; readonly locked: boolean; readonly order: number;
}
export interface AccessibilityWindow {
    readonly token: RenderToken;
    readonly sceneRevision: number;
    readonly sheetName: string;
    readonly total: number;
    readonly items: readonly AccessibilityNode[];
}
export interface AccessibilityWindowSource {
    getSnapshot(): AccessibilityWindow;
    subscribe(listener: () => void): () => void;
    node(id: NodeId): AccessibilityNode | null;
    label(node: AccessibilityNode): string;
}

// The scene supplies its bounded viewport window; selection contributes at most
// 500 extra entries, not a synchronous document walk on every focus change.
export function selectionAccessibility(selection: SelectionState, window: AccessibilityWindowSource): ViewerAccessibilitySource {
    return {
        getSnapshot(): ViewerAccessibilitySnapshot {
            const view = window.getSnapshot(), state = selection.getSnapshot();
            const byId = new Map<NodeId, BoardAccessibilityItem>();
            const put = (node: AccessibilityNode) => byId.set(node.id, { ...node, selected: selection.has(node.id), label: window.label(node) });
            for (const item of view.items) put(item);
            for (const id of state.selected.slice(0, 500)) {
                if (byId.has(id)) continue;
                const node = window.node(id);
                if (node) put(node);
            }
            if (state.active && !byId.has(state.active)) {
                const node = window.node(state.active);
                if (node) put(node);
            }
            const items = [...byId.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
            const current = window.getSnapshot();
            if (current.sceneRevision !== view.sceneRevision || current.token.session !== view.token.session
                || current.token.vaultEpoch !== view.token.vaultEpoch || current.token.documentId !== view.token.documentId
                || current.token.bytesGeneration !== view.token.bytesGeneration || selection.getSnapshot() !== state) {
                throw new Error('Accessibility window changed while building the snapshot');
            }
            return { token: view.token, sceneRevision: view.sceneRevision, sheetName: view.sheetName, total: view.total,
                items, selectedCount: state.selected.length, focusedId: state.active };
        },
        subscribe(listener) {
            const a = selection.subscribe(listener), b = window.subscribe(listener);
            return () => { a(); b(); };
        },
    };
}
