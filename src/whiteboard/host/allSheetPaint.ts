import type { PaintNodeSource } from '../render/paintStream';

// Provenance: one paint source over every sheet of a paged board, joined in sheet order; independent of any third-party code.

/**
 * Joins one whole-sheet paint source per sheet into one source, so a physical page carries every sheet's ink (R-12). A
 * node index walks the sheets in turn and the first sheet's nodes come first, so the first sheet paints lowest.
 * `sessionRasters` and `rasterVariant` belong to one sheet's dense-raster cache and are left out: the joined source takes
 * the ordinary raster path, which paints the same pixels without that cache.
 */
export function concatPaintSources(parts: readonly PaintNodeSource[]): PaintNodeSource {
    const first = parts[0];
    if (!first) throw new RangeError('A paged export needs at least one sheet');
    const starts: number[] = [];
    let nodeCount = 0;
    for (const part of parts) { starts.push(nodeCount); nodeCount += part.nodeCount; }
    const sensitive = new Set<string>();
    for (const part of parts) for (const id of part.sensitiveNodes ?? []) sensitive.add(id);
    return {
        token: first.token, sceneRevision: first.sceneRevision, nodeCount,
        ...(sensitive.size ? { sensitiveNodes: sensitive } : {}),
        isCurrent: () => parts.every(part => part.isCurrent()),
        readNode(index) {
            // The last sheet starting at or before the index owns it.
            for (let part = parts.length - 1; part >= 0; part--) {
                if (index >= starts[part]!) return parts[part]!.readNode(index - starts[part]!);
            }
            throw new RangeError('Paint node index is outside the joined sheets');
        },
    };
}
