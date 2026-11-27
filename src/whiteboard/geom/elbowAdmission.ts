import type { BoardDoc } from '../model/doc';
import type { BoardChangeGeometry } from './changeGeometry';

export function elbowAdmissionRefusal(doc: BoardDoc, geometry: Pick<BoardChangeGeometry, 'elbowRoute'>): string | null {
    for (const node of doc.nodes.values()) {
        if (node.kind !== 'connector' || node.route !== 'elbow') continue;
        if (geometry.elbowRoute(doc, node) === 'unroutable') {
            return `Elbow connector ${node.id} has no valid route; the board opens read-only and the original file is preserved.`;
        }
    }
    return null;
}
