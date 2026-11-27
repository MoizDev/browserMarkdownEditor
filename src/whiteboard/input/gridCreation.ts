import { BOARD_GRID_STEP } from '../geom/gridSnap';
import type { FigureNode, FrameNode, StickyNode, TextNode } from '../model/nodes';

export function gridBox<T extends FigureNode | FrameNode>(node: T, parent: Readonly<{ x: number; y: number; rotation: number }>): T {
    if (![node.x, node.y, node.w, node.h, parent.x, parent.y, parent.rotation].every(Number.isFinite)) throw new RangeError('Invalid grid creation geometry');
    if (parent.rotation !== 0) return node;
    const round = (value: number) => Math.round(value / BOARD_GRID_STEP) * BOARD_GRID_STEP;
    return { ...node, x: round(parent.x + node.x) - parent.x, y: round(parent.y + node.y) - parent.y,
        w: Math.max(1, round(node.w)), h: Math.max(1, round(node.h)) };
}

export function gridPoint(point: Readonly<{ x: number; y: number }>): { x: number; y: number } {
    const round = (value: number) => Math.round(value / BOARD_GRID_STEP) * BOARD_GRID_STEP;
    return { x: round(point.x), y: round(point.y) };
}

export function gridAnchored<T extends TextNode | StickyNode>(node: T, parent: Readonly<{ x: number; y: number; rotation: number }>): T {
    if (![node.x, node.y, parent.x, parent.y, parent.rotation].every(Number.isFinite)) throw new RangeError('Invalid grid creation geometry');
    const round = (value: number) => Math.round(value / BOARD_GRID_STEP) * BOARD_GRID_STEP;
    if (node.kind === 'text') return { ...node, x: round(parent.x + node.x) - parent.x, y: round(parent.y + node.y) - parent.y };
    const half = 100 * node.scale;
    return { ...node, x: round(parent.x + node.x + half) - parent.x - half, y: round(parent.y + node.y + half) - parent.y - half };
}
