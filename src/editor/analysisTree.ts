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
    newDoc: Text, oldDoc?: Text): CharRange[] {
    const dirty: CharRange[] = [], edits: CharRange[] = [];
    const editsOld: CharRange[] = [], editsNew: CharRange[] = [];
    changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        editsOld.push({ from: fromA, to: toA });
        editsNew.push({ from: fromB, to: toB });
        const from = newDoc.lineAt(fromB).from, to = newDoc.lineAt(toB).to;
        edits.push({ from, to });
        dirty.push({ from, to });
    });
    if (edits.length) {
        const oldFrom = editsOld[0].from, oldTo = editsOld[editsOld.length - 1].to;
        const newFrom = edits[0].from, newTo = edits[edits.length - 1].to;
        const mappedFrom = (node: SyntaxNode) => changes.mapPos(node.from, 1);
        const mappedTo = (node: SyntaxNode) => changes.mapPos(node.to, -1);
        const narrowFence = (a: SyntaxNode, b: SyntaxNode): boolean => {
            if (!oldDoc || a.name !== 'FencedCode' || b.name !== 'FencedCode') return false;
            const markA = a.getChild('CodeMark'), markB = b.getChild('CodeMark');
            if (!markA || !markB) return false;
            const firstA = oldDoc.lineAt(markA.from), firstB = newDoc.lineAt(markB.from);
            const lastA = oldDoc.lineAt(Math.max(a.from, a.to - 1));
            const lastB = newDoc.lineAt(Math.max(b.from, b.to - 1));
            const closedA = a.lastChild?.name === 'CodeMark' && a.lastChild.from !== markA.from;
            const closedB = b.lastChild?.name === 'CodeMark' && b.lastChild.from !== markB.from;
            const info = oldDoc.sliceString(markA.to, firstA.to);
            return firstA.text === firstB.text && closedA === closedB && lastA.text === lastB.text
                && !/^\s*mermaid(?:\s|$)/i.test(info)
                && oldFrom > firstA.to && oldTo < lastA.from;
        };
        const compareRun = (oldParent: SyntaxNode, newParent: SyntaxNode): void => {
            // Find an unchanged predecessor, walking backwards across every
            // mismatched sibling rather than assuming the immediate neighbour is stable.
            let a = oldParent.childBefore(Math.min(oldTo + 1, oldParent.to));
            let b = newParent.childBefore(Math.min(newTo + 1, newParent.to));
            while (a && b) {
                if (a.to < oldFrom && b.to < newFrom && sameMappedNode(a, b, changes)) break;
                const af = mappedFrom(a);
                if (af >= b.from) a = a.prevSibling;
                if (af <= b.from) b = b.prevSibling;
            }
            // Only a matched pair is an anchor; otherwise start at the first child.
            const anchored = !!a && !!b;
            a = anchored ? a!.nextSibling : oldParent.firstChild;
            b = anchored ? b!.nextSibling : newParent.firstChild;
            const oldRun: SyntaxNode[] = [], newRun: SyntaxNode[] = [];
            while (a || b) {
                if (a && b && a.from >= oldTo && b.from >= newTo && sameMappedNode(a, b, changes)) break;
                if (!b) { oldRun.push(a!); a = a!.nextSibling; continue; }
                if (!a) { newRun.push(b); b = b.nextSibling; continue; }
                const af = mappedFrom(a);
                if (af <= b.from) { oldRun.push(a); a = a.nextSibling; }
                if (af >= b.from) { newRun.push(b); b = b.nextSibling; }
            }
            if (oldRun.length === 1 && newRun.length === 1) {
                const oldNode = oldRun[0], newNode = newRun[0];
                if (oldNode.name === newNode.name && oldNode.from <= oldFrom && oldNode.to >= oldTo
                    && newNode.from <= editsNew[0].from && newNode.to >= editsNew[editsNew.length - 1].to) {
                    if (CONTAINERS.has(newNode.name)) { compareRun(oldNode, newNode); return; }
                    if (narrowFence(oldNode, newNode)) return;
                }
            }
            for (const node of oldRun) dirty.push({ from: mappedFrom(node), to: mappedTo(node) });
            for (const node of newRun) dirty.push({ from: node.from, to: node.to });
        };
        compareRun(oldTree.topNode, newTree.topNode);
        const mappedLength = changes.mapPos(oldTree.length, -1);
        if (mappedLength !== newTree.length) {
            const start = mappedLength < newTree.length ? changes.mapPos(lastLeafStart(oldTree), -1) : lastLeafStart(newTree);
            dirty.push({ from: Math.max(0, start), to: Math.max(mappedLength, newTree.length) });
        }
        return mergeAnalysisRanges(dirty.map(range => {
            const from = Math.max(0, Math.min(newDoc.length, range.from));
            const to = Math.max(from, Math.min(newDoc.length, range.to));
            return { from: newDoc.lineAt(from).from, to: newDoc.lineAt(to).to };
        }));
    }
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
