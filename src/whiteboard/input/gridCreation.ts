import { BOARD_GRID_STEP } from '../geom/gridSnap';
import type { FigureNode, StickyNode, TextNode } from '../model/nodes';

/** The measured grid gesture rounds a rectangle's origin and dimensions, not
 * its far corner: (103,153)+(84,63) becomes (100,150)+(80,60). */
export function gridRectangle(node: Readonly<FigureNode>, parent: Readonly<{ x: number; y: number; rotation: number }>): FigureNode {
    if (![node.x, node.y, node.w, node.h, parent.x, parent.y, parent.rotation].every(Number.isFinite)) throw new RangeError('Invalid grid creation geometry');
    // The finite grid witness is axis-aligned. Do not change a rotated frame's
    // local geometry on the strength of a different, unmeasured coordinate space.
    if (node.shape !== 'rectangle' || parent.rotation !== 0) return node;
    const round = (value: number) => Math.round(value / BOARD_GRID_STEP) * BOARD_GRID_STEP;
    return { ...node, x: round(parent.x + node.x) - parent.x, y: round(parent.y + node.y) - parent.y,
        w: Math.max(1, round(node.w)), h: Math.max(1, round(node.h)) };
}

/** Creation rounding for text and notes, in world space: a text's origin, or a note's centre, lands on the grid. */
export function gridAnchored<T extends TextNode | StickyNode>(node: T, parent: Readonly<{ x: number; y: number; rotation: number }>): T {
    if (![node.x, node.y, parent.x, parent.y, parent.rotation].every(Number.isFinite)) throw new RangeError('Invalid grid creation geometry');
    const round = (value: number) => Math.round(value / BOARD_GRID_STEP) * BOARD_GRID_STEP;
    if (node.kind === 'text') return { ...node, x: round(parent.x + node.x) - parent.x, y: round(parent.y + node.y) - parent.y };
    const half = 100 * node.scale;
    return { ...node, x: round(parent.x + node.x + half) - parent.x - half, y: round(parent.y + node.y + half) - parent.y - half };
}
