import type { PaintNodeSource } from '../render/paintStream';

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
            for (let part = parts.length - 1; part >= 0; part--) {
                if (index >= starts[part]!) return parts[part]!.readNode(index - starts[part]!);
            }
            throw new RangeError('Paint node index is outside the joined sheets');
        },
    };
}
