import type { Affine } from '../../platform/types';
import { multiplyAffine, transformBox, validBox, type Box } from '../geom/bounds';
import type { Node } from '../model/nodes';
import type { ParentId, SheetId } from '../model/ids';
import type { TextLayoutEngine, TextLayoutRequest } from '../text/paint';
import type { LegacyWorldBounds } from './pages';

export interface LegacyGeometry {
    // World-space bounds from the same geometry providers that render this node.
    worldBounds(node: Readonly<Node>, transform: Affine): Box | undefined;
}
export interface LegacyTextLayout {
    readonly engine: TextLayoutEngine;
    readonly fontEpoch: () => number;
}
const TEXT_SIZES = { s: 18, m: 24, l: 36, xl: 44 } as const;
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

function matrix(node: Node, parent: Affine): Affine {
    const c = Math.cos(node.rotation), s = Math.sin(node.rotation), out = new Float64Array(6);
    multiplyAffine(out, 0, parent, 0, [c, s, -s, c, node.x, node.y], 0);
    return [out[0], out[1], out[2], out[3], out[4], out[5]];
}
function transformed(box: Box, transform: Affine): Box {
    const out = new Float64Array(4);
    transformBox(out, 0, box, 0, transform);
    return [out[0], out[1], out[2], out[3]];
}
function union(a: Box | undefined, b: Box): Box {
    return a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b;
}

// IMP-3: prepare once for the whole draft; no scan of every shape for each root.
export async function legacyWorldBounds(nodes: readonly Node[], sheets: ReadonlySet<SheetId>,
    text: LegacyTextLayout, geometry: LegacyGeometry): Promise<(node: Node) => LegacyWorldBounds> {
    const children = new Map<ParentId, Node[]>();
    const byId = new Map<Node['id'], Node>();
    for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node);
    for (const node of nodes) {
        let group = children.get(node.parent);
        if (!group) children.set(node.parent, group = []);
        group.push(node);
    }
    const textBoxes = new Map<Node, Box>();
    for (const node of nodes) {
        if (node.kind !== 'text') continue;
        const request: TextLayoutRequest = { text: node.text, revision: node.id,
            style: { font: node.font, size: TEXT_SIZES[node.size],
                ink: { swatch: node.color, role: 'text' }, align: node.align, verticalAlign: 'start',
                padding: { top: 0, right: 0, bottom: 0, left: 0 }, minHeight: 0, overflow: 'allow' },
            width: node.autoSize ? null : node.w, fontEpoch: text.fontEpoch() };
        await text.engine.prepare(request);
        const measured = text.engine.measure({ ...request, fontEpoch: text.fontEpoch() });
        textBoxes.set(node, [0, 0, measured.box.w * node.scale, measured.box.h * node.scale]);
    }
    const result = new Map<Node, LegacyWorldBounds>();
    for (const root of nodes) {
        const parent = byId.get(root.parent as Node['id']);
        if (!sheets.has(root.parent as SheetId) && parent && (parent.kind === 'group' || parent.kind === 'frame')) continue;
        let box: Box | undefined;
        const pending: { node: Node; parent: Affine; depth: number }[] = [{ node: root, parent: IDENTITY, depth: 0 }];
        const seen = new Set<Node>();
        while (pending.length) {
            const current = pending.pop()!;
            if (seen.has(current.node) || current.depth > 64) throw new Error(`Invalid group nesting at ${current.node.id}`);
            seen.add(current.node);
            const transform = matrix(current.node, current.parent);
            let part: Box | undefined;
            if (current.node.kind === 'text') part = transformed(textBoxes.get(current.node)!, transform);
            else if (current.node.kind === 'sticky') part = transformed([0, 0, 200 * current.node.scale,
                (200 + current.node.growY) * current.node.scale], transform);
            else if (current.node.kind === 'figure') part = transformed([0, 0, current.node.w, current.node.h + current.node.growY], transform);
            else if (current.node.kind === 'frame' || current.node.kind === 'picture' || current.node.kind === 'clip'
                || current.node.kind === 'linkcard' || current.node.kind === 'embed') {
                part = transformed([0, 0, current.node.w, current.node.h], transform);
            } else if (current.node.kind !== 'group') part = geometry.worldBounds(current.node, transform);
            if (part) {
                if (!validBox(part)) throw new Error(`Invalid geometry for ${current.node.id}`);
                box = union(box, part);
            } else if (current.node.kind !== 'group') throw new Error(`Geometry is not available for ${current.node.id}`);
            if (current.node.kind === 'group') {
                for (const child of children.get(current.node.id) ?? []) pending.push({ node: child, parent: transform, depth: current.depth + 1 });
            }
        }
        if (!box) box = [root.x, root.y, root.x, root.y];
        result.set(root, { x: box[0], y: box[1], w: box[2] - box[0], h: box[3] - box[1] });
    }
    return node => {
        const bounds = result.get(node);
        if (!bounds) throw new Error(`No root bounds for ${node.id}`);
        return bounds;
    };
}
