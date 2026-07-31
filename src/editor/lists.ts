import { EditorView, keymap } from '@codemirror/view';
import type { KeyBinding } from '@codemirror/view';
import { countColumn, EditorState, Prec } from '@codemirror/state';
import type { Extension, Line } from '@codemirror/state';
import { ensureSyntaxTree, getIndentUnit, indentString, indentUnit, syntaxTree } from '@codemirror/language';
import { indentLess, indentMore } from '@codemirror/commands';
import { acceptCompletion } from '@codemirror/autocomplete';
import type { SyntaxNode, Tree } from '@lezer/common';

/* ─────────────────────────────────────────────────────────────────────────
 * MARKDOWN LISTS — the one place that knows what a list line looks like
 *
 * Two consumers share this module:
 *   - livePreview, which hides the marker and draws the rendered bullet;
 *   - the Tab / Shift-Tab commands below, which re-nest whole items.
 * They must agree on what counts as a marker, or a line can render as a
 * bullet and refuse to indent (or the reverse).
 * ───────────────────────────────────────────────────────────────────────── */

/** One list line's marker, parsed from the line text alone. */
export interface ListMarker {
    /** The leading whitespace, verbatim (may contain tabs). */
    ws: string;
    /** The marker itself: `-`, `*`, `+`, or `12.` / `3)`. */
    marker: string;
    /** True for `1.` / `1)` markers. */
    ordered: boolean;
    /** `-` | `*` | `+` for bullets; `.` | `)` for ordered lists. */
    delim: string;
    /** The ordered marker's number (0 for bullets). */
    num: number;
    /** Characters from line start through the space(s) after the marker —
     *  i.e. where this item's CONTENT begins. */
    prefixLen: number;
}

/** `<indent><marker><spaces>`. All three CommonMark bullets, both ordered
 *  delimiters, and up to 9 digits (10+ is not a list marker). */
const LIST_RE = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]*)/;

/**
 * The tab stop markdown measures indentation with — always FOUR columns, no
 * matter what the editor's tab size is (CommonMark; `@lezer/markdown`'s
 * `countIndent` hard-codes `4 - indent % 4`).
 *
 * Every column that decides list STRUCTURE has to use the parser's ruler
 * rather than the view's, or the two disagree the moment a line is indented
 * with a tab: at tab size 8 a nested item would be re-indented past the
 * parser's 4-column code-block threshold and stop being a list item at all.
 * `EditorState.tabSize` still governs how wide a tab *looks*, which is what
 * `plainTab` measures with.
 */
const MD_TAB = 4;

/**
 * Parse a line's list marker, or null when the line isn't a list item.
 *
 * Deliberately permissive about the tree: it answers "does this text look like
 * a marker", and callers that care whether it really IS one (a `- x` inside a
 * fenced code block is not) check the syntax tree separately.
 */
export function parseListMarker(text: string): ListMarker | null {
    const m = LIST_RE.exec(text);
    if (!m) return null;
    const [, ws, marker, spaces] = m;
    // A marker needs whitespace after it — unless it ends the line, which is
    // CommonMark's empty list item (`-`).
    if (!spaces.length && m[0].length !== text.length) return null;
    const ordered = marker.length > 1;
    // CommonMark: 1-4 spaces after the marker set the content column; a run of
    // 5+ means content starts one space in and the rest is indented code.
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

/**
 * The editor's indentation settings, as a compartment payload.
 *
 * `indentUnit` (spaces, never tabs) is what every indent command inserts, and
 * `tabSize` is the column width the same commands measure with — they are one
 * setting here, so keep them equal.
 */
export function indentSettings(tabSize: number): Extension {
    const size = clampTabSize(tabSize);
    return [indentUnit.of(' '.repeat(size)), EditorState.tabSize.of(size)];
}

/** Settings are user input (and localStorage is editable): keep it sane. */
export function clampTabSize(tabSize: number): number {
    const n = Math.round(tabSize);
    return Number.isFinite(n) ? Math.min(8, Math.max(1, n)) : 4;
}

/* ─────────────────────────────────────────────────────────────────────────
 * TAB / SHIFT-TAB
 *
 * On a list item, Tab makes it a sub-point of the item above and Shift-Tab
 * lifts it back out — Google Docs behaviour, with the whole sub-tree moving
 * along and ordered markers renumbered on both sides of the move. Anywhere
 * else Tab is an ordinary soft tab. Either way it is HANDLED: Tab must never
 * escape an EDITABLE view and land focus on the address bar. Reading mode is
 * the deliberate exception — nothing there is editable, so Tab is left to the
 * browser and moves focus on, the way it does on any read-only page.
 * ───────────────────────────────────────────────────────────────────────── */

/** How far past the selection we ask the (lazy) markdown parser to reach. */
const PARSE_MARGIN = 20000;
const PARSE_TIMEOUT = 100;

interface ItemInfo {
    node: SyntaxNode;
    lineNo: number;
    /** Column the marker starts at, measured the parser's way (see MD_TAB). */
    indent: number;
    /** Column the item's content starts at. */
    contentCol: number;
    ordered: boolean;
    delim: string;
    num: number;
    /** Document range of the ordered marker's digits (empty for bullets). */
    numFrom: number;
    numTo: number;
    /** Last line of this item INCLUDING its nested items and continuations. */
    lastLine: number;
    /** Position of the ListItem that owns this one, or -1 at the top level. */
    parentFrom: number;
    // ── filled in by the renumber pass ──
    newIndent: number;
    newContentCol: number;
    assigned: number;
}

interface LineChange { from: number; to: number; insert: string }

function isList(node: SyntaxNode): boolean {
    return node.name === 'BulletList' || node.name === 'OrderedList';
}

/** The ListItem this one hangs off (ListItem → list → ListItem), or null. */
function ownerItem(item: SyntaxNode): SyntaxNode | null {
    const owner = item.parent?.parent;
    return owner && owner.name === 'ListItem' ? owner : null;
}

/** The item above this one in its OWN list — null when it heads that list. */
function prevSiblingItem(item: SyntaxNode): SyntaxNode | null {
    for (let n = item.prevSibling; n; n = n.prevSibling) if (n.name === 'ListItem') return n;
    return null;
}

/** The item directly above this one at the same level — the one it would
 *  become a sub-point of. */
function prevItem(item: SyntaxNode): SyntaxNode | null {
    const own = prevSiblingItem(item);
    if (own) return own;
    // The first item of a list can still have one above it: markdown starts a
    // NEW list wherever the bullet character or the delimiter changes, so
    // "- a" followed by "1. b" is two adjacent lists at the same level, and
    // "a" is plainly the item "b" sits under.
    const before = item.parent?.prevSibling;
    if (before && isList(before)) {
        for (let n = before.lastChild; n; n = n.prevSibling) if (n.name === 'ListItem') return n;
    }
    return null;
}

/** The last sub-list inside an item — the one a new sub-point would join. */
function lastChildList(item: SyntaxNode): SyntaxNode | null {
    for (let n = item.lastChild; n; n = n.prevSibling) if (isList(n)) return n;
    return null;
}

function firstItem(list: SyntaxNode): SyntaxNode | null {
    for (let n = list.firstChild; n; n = n.nextSibling) if (n.name === 'ListItem') return n;
    return null;
}

/** Last line a range covers. A range ending exactly at a line start belongs to
 *  the line before it. */
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
        // The digits are the marker minus its delimiter — measured from the
        // source, so `01.` keeps its width unless the number itself changes.
        numTo: numFrom + (m.ordered ? m.marker.length - 1 : 0),
        lastLine: lastLineOf(state, node.from, node.to),
        parentFrom: ownerItem(node)?.from ?? -1,
        newIndent: indent,
        newContentCol: 0,
        assigned: m.num,
    };
}

/**
 * The ListItem whose MARKER sits on `line` — null for anything else, including
 * a line that merely continues an item and a list-looking line inside a fenced
 * code block (the tree knows the difference; the regex alone does not).
 */
function listItemAt(state: EditorState, tree: Tree, line: Line): SyntaxNode | null {
    const m = parseListMarker(line.text);
    if (!m) return null;
    let node: SyntaxNode | null = tree.resolveInner(line.from + m.ws.length, 1);
    while (node && node.name !== 'ListItem') node = node.parent;
    if (!node) return null;
    return state.doc.lineAt(node.from).number === line.number ? node : null;
}

/**
 * The region whose numbering a move can disturb: the outermost list around the
 * item, plus any lists directly adjacent to it. Adjacent ones count because
 * markdown starts a NEW list at every change of bullet character or delimiter,
 * so "- a" followed by "1. b" is two lists — and `prevItem` will happily move
 * an item from one into the other, which renumbers both.
 *
 * Bails on anything exotic in the ancestry (a list inside a blockquote carries
 * `> ` prefixes this module's column maths ignores).
 */
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

/**
 * Where an item lands when it is indented — or null when it can't be.
 *
 * The first item of a list has nothing to become a sub-point of, and markdown
 * cannot express it: indenting it would read as an indented code block, not a
 * deeper bullet. So Tab leaves it alone (it is still swallowed, never handed
 * to the browser).
 */
function indentTarget(state: EditorState, item: ItemInfo, unit: number): number | null {
    const prev = prevItem(item.node);
    if (!prev) return null;
    const prevInfo = itemInfo(state, prev);
    if (!prevInfo) return null;

    // The new parent may already have a sub-list; join it at ITS indent. One
    // tab stop could otherwise overshoot and make this item a child of that
    // sub-list's last item — Tab moves exactly one level, never two.
    const sub = lastChildList(prev);
    const first = sub ? firstItem(sub) : null;
    const firstInfo = first ? itemInfo(state, first) : null;
    if (firstInfo && firstInfo.indent > item.indent) return firstInfo.indent;

    // Otherwise the sub-list is new: one tab stop in, but clamped to where a
    // sub-item can actually live. CommonMark reads a line indented 4+ columns
    // past its parent's content column as an indented CODE BLOCK inside that
    // parent, and anything short of that column as a sibling — so the landing
    // zone is [contentCol, contentCol + 3], and a tab size outside it gives.
    return Math.min(Math.max(item.indent + unit, prevInfo.contentCol), prevInfo.contentCol + 3);
}

/** Where an item lands when it is out-dented — its parent's column. */
function dedentTarget(state: EditorState, item: ItemInfo): number | null {
    const owner = ownerItem(item.node);
    const ownerInfo = owner ? itemInfo(state, owner) : null;
    if (ownerInfo && ownerInfo.indent < item.indent) return ownerInfo.indent;
    // Top-level already; only stray leading spaces are left to remove.
    return item.indent > 0 ? 0 : null;
}

/**
 * Every edit the move implies: re-indent the travelling lines, then renumber
 * the ordered markers the move re-parented — on BOTH sides, since the item
 * left one list ("4." becomes the sub-list's "1.") and the items it left
 * behind close the gap.
 *
 * Numbering is rebuilt from the post-move indentation with a plain
 * parent-stack walk (an item is a child of the last item whose content column
 * it reaches past), because the syntax tree still describes the old shape.
 * Items ABOVE the move keep their numbers verbatim — the move can't affect
 * them, and rewriting them would quietly "fix" hand-written numbering.
 */
function buildChanges(
    state: EditorState,
    items: ItemInfo[],
    movedFrom: number,
    movedTo: number,
    delta: number,
): LineChange[] {
    const changes: LineChange[] = [];

    // How far each line's indentation moves. The travelling lines all shift by
    // the same delta — nested items, wrapped text and embedded code alike, so
    // the sub-tree keeps its shape — and renumbering adds to that: a marker
    // that gains or loses a digit moves its own content column, so everything
    // underneath has to follow it.
    const shift = new Map<number, number>();
    const bump = (from: number, to: number, by: number) => {
        if (!by) return;
        for (let n = from; n <= to; n++) shift.set(n, (shift.get(n) ?? 0) + by);
    };
    bump(movedFrom, movedTo, delta);

    // ── the numbering ──
    const root = { contentCol: -1, owner: null as ItemInfo | null, last: null as ItemInfo | null };
    const frames = [root];
    for (const item of items) {
        // Items come in document order, so any shift an ancestor's renumbering
        // implies is already recorded by the time we reach this line.
        item.newIndent = Math.max(0, item.indent + (shift.get(item.lineNo) ?? 0));
        item.newContentCol = item.newIndent + (item.contentCol - item.indent);

        while (frames.length > 1 && item.newIndent < frames[frames.length - 1].contentCol) frames.pop();
        const frame = frames[frames.length - 1];
        const prev = frame.last;
        // A different bullet character or delimiter starts a NEW list, so the
        // item before it is not a sibling to count from.
        const sibling = prev && prev.ordered === item.ordered && prev.delim === item.delim ? prev : null;

        if (!item.ordered || item.lineNo < movedFrom) {
            item.assigned = item.num;
        } else if (sibling) {
            item.assigned = sibling.assigned + 1;
        } else {
            // It heads a list now. It keeps its start number only if it ALREADY
            // headed the same list before the move — that is what leaves a list
            // deliberately starting at "5." alone. If it only became first
            // because the item above it moved away, or because the move landed
            // it under a new parent, the list it now heads starts at 1.
            const sameParent = item.parentFrom === (frame.owner ? frame.owner.node.from : -1);
            item.assigned = sameParent && !prevSiblingItem(item.node) ? item.num : 1;
        }

        if (item.ordered && item.assigned !== item.num) {
            const digits = String(item.assigned);
            changes.push({ from: item.numFrom, to: item.numTo, insert: digits });
            // "9." → "10." pushes this item's content column one to the right;
            // a child sitting exactly on the old column would fall out of the
            // item altogether, so the whole sub-tree moves with the marker.
            const grew = digits.length - (item.numTo - item.numFrom);
            item.newContentCol += grew;
            bump(item.lineNo + 1, item.lastLine, grew);
        }

        frame.last = item;
        frames.push({ contentCol: item.newContentCol, owner: item, last: null });
    }

    // ── the lines that move ──
    for (const [n, by] of shift) {
        const line = state.doc.line(n);
        if (!/\S/.test(line.text)) continue;          // never indent a blank line
        const ws = /^[ \t]*/.exec(line.text)![0];
        const insert = indentString(state, Math.max(0, countColumn(ws, MD_TAB) + by));
        if (insert !== ws) changes.push({ from: line.from, to: line.from + ws.length, insert });
    }

    return changes;
}

/** Tab / Shift-Tab away from a list: a plain soft tab. */
function plainTab(view: EditorView, dir: 1 | -1): boolean {
    const { state } = view;
    // Both of these only decline on a read-only state, which the caller has
    // already ruled out — but Tab is swallowed either way.
    if (dir < 0) { indentLess(view); return true; }
    if (state.selection.ranges.some(r => !r.empty)) { indentMore(view); return true; }
    // Advance to the next tab stop rather than always inserting a full unit,
    // so columns line up the way a real tab would.
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

/** Tab (dir 1) / Shift-Tab (dir -1). Always returns true in an editable view. */
function shiftListItem(view: EditorView, dir: 1 | -1): boolean {
    const { state } = view;
    // Read mode leaves the view non-editable but still able to see keys; a Tab
    // that reaches us there must not rewrite the document.
    if (state.readOnly || !state.facet(EditorView.editable)) return false;
    // Multiple cursors have no single "the item" to move.
    if (state.selection.ranges.length > 1) return plainTab(view, dir);

    const range = state.selection.main;
    const firstLine = state.doc.lineAt(range.from);
    let lastLine = state.doc.lineAt(range.to);
    // A selection ending exactly at a line start does not include that line —
    // the rule the built-in indent commands use, and what "select the whole
    // item and press Tab" means.
    if (lastLine.from === range.to && lastLine.number > firstLine.number) {
        lastLine = state.doc.line(lastLine.number - 1);
    }

    // Markdown parses lazily, so a big file's tree may not reach the selection
    // yet. Ask for a parse that covers it; if that can't be had in time, treat
    // the line as ordinary text rather than guess at list structure.
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
    // No legal move (the first item of a list, or an item already at the top
    // level) — swallow the key anyway: focus must stay in the editor.
    if (target === null || target === anchor.indent) return true;

    // A selection spanning several items moves them together, by the delta the
    // FIRST one needs, so their relative nesting survives. Each moved item
    // takes its sub-tree with it; leaving children behind would re-parent them
    // to whatever ends up above them. The moved region never leaves the list.
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
        // Map with assoc 1 so a cursor sitting in the indentation stays before
        // the marker instead of being pushed behind the inserted spaces.
        selection: state.selection.map(changeSet, 1),
        scrollIntoView: true,
        userEvent: dir > 0 ? 'input.indent' : 'delete.dedent',
    }));
    return true;
}

/**
 * Tab and Shift-Tab, above the default keymap (which deliberately leaves Tab
 * to the browser). Tab first accepts an open [[wikilink]] suggestion, the way
 * every other editor's completion behaves.
 */
export const listIndentBindings: KeyBinding[] = [{
    key: 'Tab',
    run: view => acceptCompletion(view) || shiftListItem(view, 1),
    shift: view => shiftListItem(view, -1),
}];

export const listIndentKeymap: Extension = Prec.high(keymap.of(listIndentBindings));
