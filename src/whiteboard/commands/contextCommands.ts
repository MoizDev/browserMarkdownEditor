import { selectedRoots } from '../change/commands';
import type { BoardDoc } from '../model/doc';
import type { NodeId, ParentId, SheetId } from '../model/ids';
import type { Node } from '../model/nodes';
import { structuralRootsBlock, ungroupEligibility, type SelectionBlock } from './selection';

// Provenance: enabling rules derived from this repository's own command preconditions; independent composition.

export type ContextCommandBlock = SelectionBlock | 'read-only' | 'busy' | 'too-few' | 'not-linkable';
export type ContextCommandState = { readonly enabled: true } | { readonly enabled: false; readonly reason: ContextCommandBlock };
export interface ContextCommandGate { readonly readOnly: boolean; readonly busy: boolean }

/**
 * Minimum selected roots per command. The plan records observed counts only (six align, two
 * distribute), so these are decisions, not rules quoted from the plan: align and stack or pack
 * need two roots, distribute needs three to have a middle item, and every other command needs one.
 */
const MINIMUM: Readonly<Record<string, number>> = {
    group: 2, alignLeft: 2, alignRight: 2, alignTop: 2, alignBottom: 2, alignHorizontal: 2, alignVertical: 2,
    distributeHorizontal: 3, distributeVertical: 3, stackHorizontal: 2, stackVertical: 2, pack: 2,
};
/** Restructuring commands refuse locked or out-of-scope content, exactly as the structural command scope does. */
const STRUCTURAL = new Set(['group', 'ungroup', 'flatten', 'frameSelection', 'delete', 'cut', 'duplicate', 'alignLeft', 'alignRight',
    'alignTop', 'alignBottom', 'alignHorizontal', 'alignVertical', 'distributeHorizontal', 'distributeVertical', 'stackHorizontal',
    'stackVertical', 'pack', 'stretchHorizontal', 'stretchVertical', 'sendBack', 'sendBackward', 'bringForward', 'bringFront',
    'rotateClockwise', 'rotateCounterclockwise']);
/** Commands that change the document; a read-only or gesture-busy session refuses them all. */
const MUTATING = new Set([...STRUCTURAL, 'paste', 'toggleLocked', 'editLink']);

function selected(doc: BoardDoc, ids: Iterable<NodeId>): readonly Node[] {
    try { return selectedRoots(doc, ids); } catch { return []; } // a stale selection has nothing enabled; the next selection event refreshes it.
}

/** Enabled state of one context-menu command for the current document, selection, focus and session gate. */
export function contextCommandState(doc: BoardDoc, ids: Iterable<NodeId>, state: { readonly sheet: SheetId; readonly focus: ParentId },
    command: string, gate: ContextCommandGate): ContextCommandState {
    const off = (reason: ContextCommandBlock): ContextCommandState => ({ enabled: false, reason });
    if (command === 'selectAll') return gate.busy ? off('busy') : { enabled: true };
    if (gate.readOnly && MUTATING.has(command)) return off('read-only');
    if (gate.busy && MUTATING.has(command)) return off('busy');
    if (command === 'paste') return { enabled: true };
    if (command === 'ungroup') {
        const eligible = ungroupEligibility(doc, ids, state);
        return eligible.enabled ? { enabled: true } : off(eligible.reason ?? 'no-selection');
    }
    const roots = selected(doc, ids);
    if (!roots.length) return off('no-selection');
    if (roots.length < (MINIMUM[command] ?? 1)) return off('too-few');
    if (command === 'editLink' && (roots.length !== 1 || (roots[0].kind !== 'linkcard' && roots[0].kind !== 'embed'))) return off('not-linkable');
    if (STRUCTURAL.has(command)) {
        const block = structuralRootsBlock(doc, roots, state);
        if (block) return off(block);
    }
    return { enabled: true };
}
