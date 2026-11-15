import type { BoardDoc } from '../model/doc';
import type { BoardChangeGeometry } from './changeGeometry';

/**
 * Post-layout admission gate (document-model §9.2, geometry §8.5). It runs on the loaded document, with the
 * real layout and attachment surfaces, before the board becomes editable or is transferred to a session.
 * A received elbow connector with no valid candidate makes the board read-only: the original bytes stay
 * untouched, nothing is converted, rebound or dropped. Returns the refusal reason, or null when every
 * elbow connector routes. A missing layout throws from the geometry, so the caller fails closed.
 */
export function elbowAdmissionRefusal(doc: BoardDoc, geometry: Pick<BoardChangeGeometry, 'elbowRoute'>): string | null {
    for (const node of doc.nodes.values()) {
        if (node.kind !== 'connector' || node.route !== 'elbow') continue;
        if (geometry.elbowRoute(doc, node) === 'unroutable') {
            return `Elbow connector ${node.id} has no valid route; the board opens read-only and the original file is preserved.`;
        }
    }
    return null;
}
