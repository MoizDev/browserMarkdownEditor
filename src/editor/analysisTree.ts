import type { ChangeDesc } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import type { CharRange } from '../utils/rangeSearch';

/** Coalesce overlapping tree and scanner invalidations before passing them to the renderer. */
export function mergeAnalysisRanges(input: readonly CharRange[]): CharRange[] {
    const ranges = input.map(range => ({ ...range })).sort((a, b) => a.from - b.from || a.to - b.to);
    const result: CharRange[] = [];
    for (const range of ranges) {
        const last = result[result.length - 1];
        if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
        else result.push(range);
    }
    return result;
}

/** Compare node type and mapped extent, without relying on Lezer subtree identity. */
export function sameMappedNode(old: SyntaxNode, next: SyntaxNode, changes: ChangeDesc): boolean {
    return old.type.id === next.type.id && changes.mapPos(old.from, 1) === next.from
        && changes.mapPos(old.to, -1) === next.to;
}

/** The parser frontier may finish inside nested containers, not at a top-level block. */
export function lastLeafStart(tree: Tree): number {
    let node = tree.topNode;
    while (node.lastChild) node = node.lastChild;
    while (node.parent && node.name !== 'Paragraph' && node.name !== 'FencedCode'
        && node.name !== 'CodeBlock' && node.name !== 'HTMLBlock'
        && !/^ATXHeading|^SetextHeading|^HorizontalRule/.test(node.name)) node = node.parent;
    return node.from;
}
