import type { Node } from '../model/nodes';

// Provenance: local geometry providers and shared text-layout contracts. Nested
// model values are immutable by ownership; no document-sized hashing or scanning.
export function localGeometrySignature(node: Readonly<Node>, fontEpoch: number, zoom: number): readonly unknown[] {
    let parts: unknown[];
    switch (node.kind) {
        case 'stroke':
            parts = [node.kind, node.samples, node.sx, node.sy, node.widthModel, node.geomVersion,
                node.fairTol, node.width, node.dash, node.tool, node.pressure, node.closed, node.complete];
            break;
        case 'figure':
            parts = [node.kind, node.shape, node.w, node.h, node.growY, node.flipX, node.flipY,
                node.width, node.dash, node.fill, node.size, node.font, node.label, node.labelScale,
                node.align, node.valign, ...(node.label ? [fontEpoch] : [])];
            break;
        case 'text':
            parts = [node.kind, node.text, node.autoSize, node.w, node.scale, node.font, node.size, node.align, fontEpoch];
            break;
        case 'sticky':
            parts = [node.kind, node.text, node.scale, node.growY, node.fit, node.font, node.size, node.align, node.valign, fontEpoch];
            break;
        case 'connector':
            // Attachment target geometry and placement are separate service dependencies.
            parts = [node.kind, node.route, node.start, node.end, node.bend, node.elbowMid, node.headStart, node.headEnd,
                node.width, node.dash, node.label, node.font, node.size, node.labelScale, node.labelAt,
                ...(node.label ? [fontEpoch] : [])];
            break;
        case 'polyline':
            parts = [node.kind, node.points, node.spline, node.width, node.dash, node.size];
            break;
        case 'frame':
            parts = [node.kind, node.w, node.h, node.name, fontEpoch, zoom];
            break;
        case 'picture':
            parts = [node.kind, node.w, node.h, node.media, node.crop?.circle ?? false];
            break;
        case 'clip':
            parts = [node.kind, node.w, node.h, node.media];
            break;
        case 'linkcard': case 'embed':
            parts = [node.kind, node.w, node.h];
            break;
        case 'opaque':
            parts = [node.kind, node.raw];
            break;
        case 'group':
            parts = [node.kind];
            break;
    }
    return Object.freeze(parts);
}
export function sameGeometrySignature(a: readonly unknown[], b: readonly unknown[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
}
