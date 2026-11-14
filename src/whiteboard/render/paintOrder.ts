import type { NodeId } from '../model/ids';

/** Canonical preorder; null is a cooperative checkpoint, not a node or an end marker.
 * A culled run must still yield checkpoints so iterator.next() cannot scan a whole vault. */
export type PaintNodeOrder = Iterable<NodeId | null>;
