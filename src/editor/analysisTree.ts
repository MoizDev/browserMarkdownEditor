import type { ChangeDesc, Text } from '@codemirror/state';
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

const CONTAINERS = new Set(['Document', 'BulletList', 'OrderedList', 'ListItem', 'Blockquote']);

/** Align children by mapped positions and type. A changed non-container is invalidated whole. */
export function treeDelta(oldTree: Tree, newTree: Tree, changes: ChangeDesc,
    newDoc: Text): CharRange[] {
    const dirty: CharRange[] = [], edits: CharRange[] = [];
    changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
        const from = newDoc.lineAt(fromB).from, to = newDoc.lineAt(toB).to;
        edits.push({ from, to });
        dirty.push({ from, to });
    });
    const mapped = (node: SyntaxNode): CharRange => ({
        from: changes.mapPos(node.from, 1), to: changes.mapPos(node.to, -1),
    });
    const key = (name: string, from: number, to: number) => `${name}:${from}:${to}`;
    const touchesEdit = (node: SyntaxNode) => edits.some(r => r.from <= node.to && r.to >= node.from);
    const children = (node: SyntaxNode): SyntaxNode[] => {
        const result: SyntaxNode[] = [];
        for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
        return result;
    };
    const compare = (a: SyntaxNode, b: SyntaxNode) => {
        const oldChildren = children(a), newChildren = children(b);
        const lookup = new Map<string, SyntaxNode[]>();
        for (const child of oldChildren) {
            const range = mapped(child), id = key(child.name, range.from, range.to);
            const group = lookup.get(id);
            if (group) group.push(child); else lookup.set(id, [child]);
        }
        const matched = new Set<SyntaxNode>();
        for (const child of newChildren) {
            const group = lookup.get(key(child.name, child.from, child.to));
            const previous = group?.shift();
            if (!previous) { dirty.push({ from: child.from, to: child.to }); continue; }
            matched.add(previous);
            if (!changes.empty && !touchesEdit(child)) continue;
            if (CONTAINERS.has(child.name)) compare(previous, child);
            else if (touchesEdit(child)) dirty.push({ from: child.from, to: child.to });
            else if (changes.empty) compare(previous, child);
        }
        for (const child of oldChildren) if (!matched.has(child)) dirty.push(mapped(child));
    };
    compare(oldTree.topNode, newTree.topNode);
    const mappedLength = changes.mapPos(oldTree.length, -1);
    if (mappedLength !== newTree.length) {
        const oldShorter = mappedLength < newTree.length;
        const start = oldShorter ? changes.mapPos(lastLeafStart(oldTree), -1) : lastLeafStart(newTree);
        dirty.push({ from: Math.max(0, start), to: Math.max(mappedLength, newTree.length) });
    }
    // A deletion can map both ends onto one position; whole-line widening keeps it observable.
    return mergeAnalysisRanges(dirty.map(range => {
        const from = Math.max(0, Math.min(newDoc.length, range.from));
        const to = Math.max(from, Math.min(newDoc.length, range.to));
        return { from: newDoc.lineAt(from).from, to: newDoc.lineAt(to).to };
    }));
}
