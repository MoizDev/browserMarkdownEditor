import { EditorView, keymap } from '@codemirror/view';
import type { KeyBinding } from '@codemirror/view';
import { countColumn, EditorState, Prec } from '@codemirror/state';
import type { Extension, Line } from '@codemirror/state';
import { ensureSyntaxTree, getIndentUnit, indentString, indentUnit, syntaxTree } from '@codemirror/language';
import { indentLess, indentMore } from '@codemirror/commands';
import { acceptCompletion } from '@codemirror/autocomplete';
import type { SyntaxNode, Tree } from '@lezer/common';
import { canWrite } from './readingMode';

export interface ListMarker {
    ws: string;
    marker: string;
    ordered: boolean;
    delim: string;
    num: number;
    prefixLen: number;
}

const LIST_RE = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]*)/;

const MD_TAB = 4;

export function parseListMarker(text: string): ListMarker | null {
    const m = LIST_RE.exec(text);
    if (!m) return null;
    const [, ws, marker, spaces] = m;
    if (!spaces.length && m[0].length !== text.length) return null;
    const ordered = marker.length > 1;
    const contentSpaces = spaces.length > 4 ? 1 : spaces.length;
    return {
        ws,
        marker,
        ordered,
        delim: ordered ? marker[marker.length - 1] : marker,
        num: ordered ? parseInt(marker, 10) : 0,
        prefixLen: ws.length + marker.length + contentSpaces,
    };
}

export function indentSettings(tabSize: number): Extension {
    const size = clampTabSize(tabSize);
    return [indentUnit.of(' '.repeat(size)), EditorState.tabSize.of(size)];
}

export function clampTabSize(tabSize: number): number {
    const n = Math.round(tabSize);
    return Number.isFinite(n) ? Math.min(8, Math.max(1, n)) : 4;
}

const PARSE_MARGIN = 20000;
const PARSE_TIMEOUT = 100;

interface ItemInfo {
    node: SyntaxNode;
    lineNo: number;
    indent: number;
    contentCol: number;
    ordered: boolean;
    delim: string;
    num: number;
    numFrom: number;
    numTo: number;
    lastLine: number;
    parentFrom: number;
    newIndent: number;
    newContentCol: number;
    assigned: number;
}

interface LineChange { from: number; to: number; insert: string }

function isList(node: SyntaxNode): boolean {
    return node.name === 'BulletList' || node.name === 'OrderedList';
}

function ownerItem(item: SyntaxNode): SyntaxNode | null {
    const owner = item.parent?.parent;
    return owner && owner.name === 'ListItem' ? owner : null;
}

function prevSiblingItem(item: SyntaxNode): SyntaxNode | null {
    for (let n = item.prevSibling; n; n = n.prevSibling) if (n.name === 'ListItem') return n;
    return null;
}

function prevItem(item: SyntaxNode): SyntaxNode | null {
    const own = prevSiblingItem(item);
    if (own) return own;
    const before = item.parent?.prevSibling;
    if (before && isList(before)) {
        for (let n = before.lastChild; n; n = n.prevSibling) if (n.name === 'ListItem') return n;
    }
    return null;
}

function lastChildList(item: SyntaxNode): SyntaxNode | null {
    for (let n = item.lastChild; n; n = n.prevSibling) if (isList(n)) return n;
    return null;
}

function firstItem(list: SyntaxNode): SyntaxNode | null {
    for (let n = list.firstChild; n; n = n.nextSibling) if (n.name === 'ListItem') return n;
    return null;
}

function lastLineOf(state: EditorState, from: number, to: number): number {
    let end = to;
    if (end > from && state.doc.lineAt(end).from === end) end--;
    return state.doc.lineAt(end).number;
}

function itemInfo(state: EditorState, node: SyntaxNode): ItemInfo | null {
    const line = state.doc.lineAt(node.from);
    const m = parseListMarker(line.text);
    if (!m) return null;
    const indent = countColumn(m.ws, MD_TAB);
    const numFrom = line.from + m.ws.length;
    return {
        node,
        lineNo: line.number,
        indent,
        contentCol: countColumn(line.text.slice(0, m.prefixLen), MD_TAB),
        ordered: m.ordered,
        delim: m.delim,
        num: m.num,
        numFrom,
        numTo: numFrom + (m.ordered ? m.marker.length - 1 : 0),
        lastLine: lastLineOf(state, node.from, node.to),
        parentFrom: ownerItem(node)?.from ?? -1,
        newIndent: indent,
        newContentCol: 0,
        assigned: m.num,
    };
}

function listItemAt(state: EditorState, tree: Tree, line: Line): SyntaxNode | null {
    const m = parseListMarker(line.text);
    if (!m) return null;
    let node: SyntaxNode | null = tree.resolveInner(line.from + m.ws.length, 1);
    while (node && node.name !== 'ListItem') node = node.parent;
    if (!node) return null;
    return state.doc.lineAt(node.from).number === line.number ? node : null;
}

function outerListRange(item: SyntaxNode): { from: number; to: number } | null {
    let list = item.parent;
    if (!list || !isList(list)) return null;
    for (let p = list.parent; p; p = p.parent) {
        if (isList(p)) list = p;
        else if (p.name !== 'ListItem' && p.name !== 'Document') return null;
    }
    let from = list.from;
    let to = list.to;
    for (let n = list.prevSibling; n && isList(n); n = n.prevSibling) from = n.from;
    for (let n = list.nextSibling; n && isList(n); n = n.nextSibling) to = n.to;
    return { from, to };
}

function collectItems(state: EditorState, tree: Tree, from: number, to: number): ItemInfo[] {
    const items: ItemInfo[] = [];
    tree.iterate({
        from,
        to,
        enter(node) {
            if (node.name !== 'ListItem') return;
            const info = itemInfo(state, node.node);
            if (info) items.push(info);
        },
    });
    return items;
}

function indentTarget(state: EditorState, item: ItemInfo, unit: number): number | null {
    const prev = prevItem(item.node);
    if (!prev) return null;
    const prevInfo = itemInfo(state, prev);
    if (!prevInfo) return null;

    const sub = lastChildList(prev);
    const first = sub ? firstItem(sub) : null;
    const firstInfo = first ? itemInfo(state, first) : null;
    if (firstInfo && firstInfo.indent > item.indent) return firstInfo.indent;

    return Math.min(Math.max(item.indent + unit, prevInfo.contentCol), prevInfo.contentCol + 3);
}

function dedentTarget(state: EditorState, item: ItemInfo): number | null {
    const owner = ownerItem(item.node);
    const ownerInfo = owner ? itemInfo(state, owner) : null;
    if (ownerInfo && ownerInfo.indent < item.indent) return ownerInfo.indent;
    return item.indent > 0 ? 0 : null;
}

function buildChanges(
    state: EditorState,
    items: ItemInfo[],
    movedFrom: number,
    movedTo: number,
    delta: number,
): LineChange[] {
    const changes: LineChange[] = [];

    const shift = new Map<number, number>();
    const bump = (from: number, to: number, by: number) => {
        if (!by) return;
        for (let n = from; n <= to; n++) shift.set(n, (shift.get(n) ?? 0) + by);
    };
    bump(movedFrom, movedTo, delta);

    const root = { contentCol: -1, owner: null as ItemInfo | null, last: null as ItemInfo | null };
    const frames = [root];
    for (const item of items) {
        item.newIndent = Math.max(0, item.indent + (shift.get(item.lineNo) ?? 0));
        item.newContentCol = item.newIndent + (item.contentCol - item.indent);

        while (frames.length > 1 && item.newIndent < frames[frames.length - 1].contentCol) frames.pop();
        const frame = frames[frames.length - 1];
        const prev = frame.last;
        const sibling = prev && prev.ordered === item.ordered && prev.delim === item.delim ? prev : null;

        if (!item.ordered || item.lineNo < movedFrom) {
            item.assigned = item.num;
        } else if (sibling) {
            item.assigned = sibling.assigned + 1;
        } else {
            const sameParent = item.parentFrom === (frame.owner ? frame.owner.node.from : -1);
            item.assigned = sameParent && !prevSiblingItem(item.node) ? item.num : 1;
        }

        if (item.ordered && item.assigned !== item.num) {
            const digits = String(item.assigned);
            changes.push({ from: item.numFrom, to: item.numTo, insert: digits });
            const grew = digits.length - (item.numTo - item.numFrom);
            item.newContentCol += grew;
            bump(item.lineNo + 1, item.lastLine, grew);
        }

        frame.last = item;
        frames.push({ contentCol: item.newContentCol, owner: item, last: null });
    }

    for (const [n, by] of shift) {
        const line = state.doc.line(n);
        if (!/\S/.test(line.text)) continue;
        const ws = /^[ \t]*/.exec(line.text)![0];
        const insert = indentString(state, Math.max(0, countColumn(ws, MD_TAB) + by));
        if (insert !== ws) changes.push({ from: line.from, to: line.from + ws.length, insert });
    }

    return changes;
}

function plainTab(view: EditorView, dir: 1 | -1): boolean {
    const { state } = view;
    if (dir < 0) { indentLess(view); return true; }
    if (state.selection.ranges.some(r => !r.empty)) { indentMore(view); return true; }
    const range = state.selection.main;
    const line = state.doc.lineAt(range.head);
    const unit = Math.max(1, getIndentUnit(state));
    const col = countColumn(line.text.slice(0, range.head - line.from), state.tabSize);
    view.dispatch(state.update(state.replaceSelection(' '.repeat(unit - (col % unit))), {
        scrollIntoView: true,
        userEvent: 'input',
    }));
    return true;
}

function shiftListItem(view: EditorView, dir: 1 | -1): boolean {
    const { state } = view;
    // Read mode leaves the view non-editable but still able to see keys; a Tab
    // that reaches us there must not rewrite the document.
    if (!canWrite(state)) return false;
    if (state.selection.ranges.length > 1) return plainTab(view, dir);

    const range = state.selection.main;
    const firstLine = state.doc.lineAt(range.from);
    let lastLine = state.doc.lineAt(range.to);
    if (lastLine.from === range.to && lastLine.number > firstLine.number) {
        lastLine = state.doc.line(lastLine.number - 1);
    }

    const tree = ensureSyntaxTree(state, Math.min(state.doc.length, lastLine.to + PARSE_MARGIN), PARSE_TIMEOUT)
        ?? syntaxTree(state);
    if (tree.length < lastLine.to) return plainTab(view, dir);

    const node = listItemAt(state, tree, firstLine);
    if (!node) return plainTab(view, dir);
    const block = outerListRange(node);
    if (!block) return plainTab(view, dir);

    const items = collectItems(state, tree, block.from, block.to);
    const anchor = items.find(i => i.lineNo === firstLine.number);
    if (!anchor) return plainTab(view, dir);

    const target = dir > 0
        ? indentTarget(state, anchor, Math.max(1, getIndentUnit(state)))
        : dedentTarget(state, anchor);
    if (target === null || target === anchor.indent) return true;

    const blockLastLine = lastLineOf(state, block.from, block.to);
    let movedTo = Math.min(lastLine.number, blockLastLine);
    for (const item of items) {
        if (item.lineNo >= firstLine.number && item.lineNo <= lastLine.number) {
            movedTo = Math.max(movedTo, Math.min(item.lastLine, blockLastLine));
        }
    }

    const changes = buildChanges(state, items, firstLine.number, movedTo, target - anchor.indent);
    if (!changes.length) return true;
    // `ChangeSet.of` only builds one flat set while the ranges arrive in order;
    // anything out of order makes it flush and compose instead. A line's indent
    // insertion and its renumbering start at the same offset when the line has
    // no indentation yet, so the shorter (the pure insertion) has to go first.
    changes.sort((a, b) => a.from - b.from || (a.to - a.from) - (b.to - b.from));

    const changeSet = state.changes(changes);
    view.dispatch(state.update({
        changes: changeSet,
        selection: state.selection.map(changeSet, 1),
        scrollIntoView: true,
        userEvent: dir > 0 ? 'input.indent' : 'delete.dedent',
    }));
    return true;
}

export const listIndentBindings: KeyBinding[] = [{
    key: 'Tab',
    run: view => acceptCompletion(view) || shiftListItem(view, 1),
    shift: view => shiftListItem(view, -1),
}];

export const listIndentKeymap: Extension = Prec.high(keymap.of(listIndentBindings));
