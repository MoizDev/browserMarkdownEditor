import type { ConnectorGeometry } from '../geom/connectorTypes';
import type { BoardVectorGeometry } from './vectorGeometry';
import type { InkCoverage } from '../ink/outline';
import { inkCoverageBytes } from '../ink/packedCoverage';
import type { TextPaint } from '../text/paint';
import { inkCoverageChunks, type PaintNode } from './paintStream';

export function inkChunkBytes(chunk: InkCoverage): number {
    return 256 + inkCoverageBytes(chunk);
}

export function textPaintBytes(paint: TextPaint): number {
    let bytes = 256 + (paint.backgrounds.length + paint.decorations.length) * 48 + paint.lines.length * 96;
    for (const line of paint.lines) for (const fragment of line.fragments) bytes += 96 + fragment.text.length * 2;
    return bytes;
}

export function vectorBytes(vector: BoardVectorGeometry): number {
    let bytes = 256;
    for (const path of vector.paths) bytes += 64 + path.ops.length * 48;
    for (const label of vector.text) bytes += 64 + textPaintBytes(label.paint);
    if (vector.attachments) bytes += 64 + vector.attachments.outline.length * 48;
    return bytes;
}

export function connectorBytes(connector: ConnectorGeometry): number {
    let bytes = 512 + connector.body.length * 48;
    for (const head of connector.heads) bytes += 64 + head.length * 48;
    if (connector.label) bytes += 64 + textPaintBytes(connector.label.paint);
    return bytes;
}

export function paintNodeBytes(node: PaintNode): number {
    let bytes = 256;
    for (const items of [node.underlay ?? [], node.content]) for (const item of items) {
        if (item.kind === 'path') bytes += 128 + item.d.length * 48;
        else if (item.kind === 'ink') for (const chunk of inkCoverageChunks(item.coverage)) bytes += inkChunkBytes(chunk);
        else bytes += 192;
    }
    return bytes;
}
