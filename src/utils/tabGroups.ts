// What the tab bar shows, and where each open document is drawn.
//
// A tab-bar entry is a GROUP of one or more open documents laid out side by
// side (see types/index.ts). Merging tab B into tab A is what produces a group
// of two; the panes are equal-width columns, and a group holds at most
// MAX_SPLIT_PANES of them.
//
// TWO STRUCTURES, ON PURPOSE. `App.tabs` stays a flat list of every open
// document — per-tab autosave, the asset diff, the vault-search overlay, rename
// and move all index it by path and none of them care how the documents are
// arranged — and this module owns the arrangement alone. Folding the two
// together would have put a group walk in front of every one of those lookups
// for a feature none of them are about.
//
// THE INVARIANT the two share: every open path appears in exactly one group,
// and every path in a group is an open document. App keeps it by pairing each
// setTabs with the matching layout transition below; nothing here reads `tabs`,
// so a violation shows up as a pane with no document rather than as corruption.
//
// Every operation is a (layout, …) => layout applied inside a setState updater:
// the group list and the active id move together, so no intermediate state can
// name a group that the same update removed. Returning the SAME object when
// nothing changed matters too — the layout's identity is the persist effect's
// dependency.
//
// All are pure but two: openTab and splitOff mint a group id from the counter
// below, so StrictMode's double-invoked updater burns an id and discards a
// group object. Harmless — ids only have to be unique among the groups that
// exist at one moment, and both invocations produce unique ones — but it is
// why those two are not the drop-in pure functions the rest are.

import type { TabGroup, TabLayout } from '../types';

/**
 * How many documents may share one tab.
 *
 * Five is the point past which the panes stop being useful rather than an
 * implementation limit: at the width of a sidebar-flanked window a sixth column
 * is narrower than a line of prose, and the fit logic in editor/tableFit.ts is
 * already shrinking tables to reach it.
 */
export const MAX_SPLIT_PANES = 5;

export const EMPTY_LAYOUT: TabLayout = { groups: [], activeId: null };

/** Session-unique group ids. Never persisted — the stored session records each
 *  group's PATHS, so ids are re-minted on restore and only have to be unique
 *  among the groups that exist at one moment. */
let idSeq = 0;
export function newGroupId(): string {
    return `tg${(++idSeq).toString(36)}`;
}

export function groupOf(layout: TabLayout, path: string): TabGroup | null {
    return layout.groups.find(g => g.paths.includes(path)) ?? null;
}

export function groupById(layout: TabLayout, id: string | null): TabGroup | null {
    return id === null ? null : layout.groups.find(g => g.id === id) ?? null;
}

/** The group whose panes are on screen. */
export function activeGroup(layout: TabLayout): TabGroup | null {
    return groupById(layout, layout.activeId);
}

/** The document the header actions, ⌘E, ⌘S and the file tree's highlight all
 *  mean — the focused pane of the group on screen. */
export function focusedPath(layout: TabLayout): string | null {
    return activeGroup(layout)?.activePath ?? null;
}

/** Every path currently drawn, i.e. the active group's panes. */
export function visiblePaths(layout: TabLayout): string[] {
    return activeGroup(layout)?.paths ?? [];
}

/** Put the focus on an already-open document: its group comes to the front and
 *  that pane within it takes focus. A path this layout doesn't know is ignored
 *  rather than guessed at (see openTab for the opening case). */
export function focusTab(layout: TabLayout, path: string): TabLayout {
    const group = groupOf(layout, path);
    if (!group) return layout;
    if (layout.activeId === group.id && group.activePath === path) return layout;
    return {
        activeId: group.id,
        groups: group.activePath === path
            ? layout.groups
            : layout.groups.map(g => (g.id === group.id ? { ...g, activePath: path } : g)),
    };
}

/** Open a document as a tab of its own, at the end of the bar. Already open —
 *  in any group, as any pane — means focus it instead, which is what makes this
 *  safe to call from the two paths that race each other on a double click. */
export function openTab(layout: TabLayout, path: string): TabLayout {
    if (groupOf(layout, path)) return focusTab(layout, path);
    const id = newGroupId();
    return { groups: [...layout.groups, { id, paths: [path], activePath: path }], activeId: id };
}

export function selectGroup(layout: TabLayout, id: string): TabLayout {
    return layout.activeId === id || !groupById(layout, id) ? layout : { ...layout, activeId: id };
}

/** Where focus lands once the group at `index` is gone: the tab that slid into
 *  its place, else the one before it, else nothing. Mirrors what closing a
 *  single-document tab has always done. */
function neighbourId(groups: TabGroup[], index: number): string | null {
    return groups[index]?.id ?? groups[index - 1]?.id ?? null;
}

/** Close a whole tab — every pane in it. */
export function closeGroup(layout: TabLayout, id: string): TabLayout {
    const index = layout.groups.findIndex(g => g.id === id);
    if (index === -1) return layout;
    const groups = layout.groups.filter(g => g.id !== id);
    return {
        groups,
        activeId: layout.activeId === id ? neighbourId(groups, index) : layout.activeId,
    };
}

/** Close ONE document. The last pane of a tab takes the tab with it; otherwise
 *  the tab stays and, if this was its focused pane, focus moves to whatever
 *  slid into its slot. */
export function closePath(layout: TabLayout, path: string): TabLayout {
    const group = groupOf(layout, path);
    if (!group) return layout;

    const index = group.paths.indexOf(path);
    const paths = group.paths.filter(p => p !== path);
    // Emptied — normally because that was the tab's only pane. The test is on
    // what is LEFT rather than on the count going in, because the filter drops
    // every occurrence: a group that had somehow been given the same path twice
    // would otherwise survive as a tab with no panes and no name, drawing the
    // "No file open" overlay with no pane left to close.
    if (paths.length === 0) return closeGroup(layout, group.id);

    const activePath = group.activePath === path
        ? paths[Math.min(index, paths.length - 1)]
        : group.activePath;
    return {
        ...layout,
        groups: layout.groups.map(g => (g.id === group.id ? { ...g, paths, activePath } : g)),
    };
}

/** True when dragging `sourceId` onto the active tab's panes would be accepted:
 *  a tab can't be merged into itself, and five panes is the ceiling. The drop
 *  zone asks this before it offers an insertion point. */
export function canMergeIntoActive(layout: TabLayout, sourceId: string | null): boolean {
    const source = groupById(layout, sourceId);
    const target = activeGroup(layout);
    return !!source && !!target && source.id !== target.id
        && source.paths.length + target.paths.length <= MAX_SPLIT_PANES;
}

/**
 * Merge one tab's documents into the tab on screen, as panes starting at
 * `index` (0 = left of every existing pane, target.paths.length = right of all
 * of them). The source tab ceases to exist.
 *
 * Focus goes to the pane the user just dragged, not to whatever had it before:
 * the drag is a statement about which document they want to be looking at.
 */
export function mergeIntoActive(layout: TabLayout, sourceId: string, index: number): TabLayout {
    if (!canMergeIntoActive(layout, sourceId)) return layout;
    const source = groupById(layout, sourceId)!;
    const target = activeGroup(layout)!;
    const at = Math.max(0, Math.min(index, target.paths.length));
    const paths = [...target.paths.slice(0, at), ...source.paths, ...target.paths.slice(at)];
    return {
        activeId: target.id,
        groups: layout.groups
            .filter(g => g.id !== source.id)
            .map(g => (g.id === target.id ? { ...g, paths, activePath: source.activePath } : g)),
    };
}

/**
 * The inverse of a merge for ONE pane: it leaves the split and becomes a tab of
 * its own, immediately to the right of the tab it came out of — where the eye
 * is already looking — and takes the focus with it.
 */
export function splitOff(layout: TabLayout, path: string): TabLayout {
    const group = groupOf(layout, path);
    if (!group || group.paths.length < 2) return layout;

    const index = group.paths.indexOf(path);
    const paths = group.paths.filter(p => p !== path);
    const trimmed: TabGroup = {
        ...group,
        paths,
        activePath: group.activePath === path ? paths[Math.min(index, paths.length - 1)] : group.activePath,
    };
    const popped: TabGroup = { id: newGroupId(), paths: [path], activePath: path };

    const at = layout.groups.indexOf(group);
    return {
        activeId: popped.id,
        groups: [...layout.groups.slice(0, at), trimmed, popped, ...layout.groups.slice(at + 1)],
    };
}

/** Move a tab so it lands at `toIndex`, which indexes the PRE-removal array
 *  (the tab bar's drop indicator sits between two existing tabs). */
export function reorderGroups(layout: TabLayout, id: string, toIndex: number): TabLayout {
    const from = layout.groups.findIndex(g => g.id === id);
    if (from === -1) return layout;
    const insertAt = toIndex > from ? toIndex - 1 : toIndex;
    if (insertAt === from) return layout;
    const groups = layout.groups.slice();
    const [moved] = groups.splice(from, 1);
    groups.splice(insertAt, 0, moved);
    return { ...layout, groups };
}

/**
 * Follow a document that was renamed or moved. The layout indexes documents by
 * path, so missing this leaves a pane pointing at a file that no longer answers
 * to that name.
 *
 * `to` MAY already be open: renameFile/moveFile deliberately overwrite an
 * existing name (an explicit move onto a name is the user saying so), and the
 * file that was sitting there is now gone. Renaming `from` in place would then
 * put one path in two panes — React draws one of them, the tab bar counts both,
 * and closing it takes every copy at once. So the old occupant is REMOVED here
 * rather than left to collide, and a group emptied by that goes with it. App
 * closes the shadowed tab alongside; this keeps the transition alone from being
 * able to produce the broken shape.
 */
export function renamePath(layout: TabLayout, from: string, to: string): TabLayout {
    if (!groupOf(layout, from) || from === to) return layout;

    const groups: TabGroup[] = [];
    for (const g of layout.groups) {
        if (!g.paths.includes(from) && !g.paths.includes(to)) { groups.push(g); continue; }
        // Drop any pre-existing `to` everywhere, then let `from` become it — so
        // whichever group held `from` ends up with exactly one `to`, and a
        // group that held only the overwritten file disappears.
        const paths = g.paths.filter(p => p !== to).map(p => (p === from ? to : p));
        if (paths.length === 0) continue;
        // The focused pane follows the rename; if it was the pane the rename
        // just overwrote, focus falls to the leftmost survivor.
        const moved = g.activePath === from ? to : g.activePath;
        groups.push({ ...g, paths, activePath: paths.includes(moved) ? moved : paths[0] });
    }
    const activeId = groups.some(g => g.id === layout.activeId)
        ? layout.activeId
        : groups[0]?.id ?? null;
    return { groups, activeId };
}

/** localStorage holds whatever an older build (or a hand edit) wrote. */
function isPathMatrix(value: unknown): value is string[][] {
    return Array.isArray(value)
        && value.every(group => Array.isArray(group) && group.every(p => typeof p === 'string'));
}

/** The per-group focused pane, stored alongside the grouping rather than inside
 *  it so `openTabGroups` keeps the exact shape every build has written. */
function isStringList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(p => typeof p === 'string');
}

/**
 * Rebuild the tab bar from a restored session.
 *
 * `restored` is the paths whose files were actually re-read, in stored order;
 * `stored` is the recorded grouping, which may be missing (a session written
 * before split tabs existed), stale (a note deleted on disk since), or invalid.
 * Anything a stored group can't account for still opens — as its own tab, which
 * is exactly what every session used to restore as.
 *
 * `storedFocus` names each stored group's focused pane, positionally. It is read
 * before any filtering, so it stays aligned with `stored` however much of the
 * session has gone stale, and a session written without it (or with a pane since
 * deleted) simply falls back to the group's leftmost.
 */
export function restoreLayout(
    restored: string[],
    stored: unknown,
    storedFocus: unknown,
    wantActive: string | null,
): TabLayout {
    const available = new Set(restored);
    const placed = new Set<string>();
    const groups: TabGroup[] = [];
    const focus = isStringList(storedFocus) ? storedFocus : [];

    if (isPathMatrix(stored)) {
        for (const [entryIndex, entry] of stored.entries()) {
            // `placed` is consulted AND added to as the entry is walked, so a
            // path repeated inside one stored group is dropped just as one
            // repeated across two groups is — a group holding the same path
            // twice would draw one pane while the tab bar counted two.
            const paths: string[] = [];
            for (const p of entry) {
                if (!available.has(p) || placed.has(p) || paths.includes(p)) continue;
                paths.push(p);
            }
            // A group recorded wider than the cap allows (a lowered limit, a
            // hand-edited session) keeps its first panes and lets the rest fall
            // through to the singleton pass below, rather than closing them.
            const capped = paths.slice(0, MAX_SPLIT_PANES);
            if (!capped.length) continue;
            for (const p of capped) placed.add(p);
            const wanted = focus[entryIndex];
            groups.push({
                id: newGroupId(),
                paths: capped,
                activePath: wanted && capped.includes(wanted) ? wanted : capped[0],
            });
        }
    }

    for (const path of restored) {
        if (placed.has(path)) continue;
        placed.add(path);
        groups.push({ id: newGroupId(), paths: [path], activePath: path });
    }

    const layout: TabLayout = { groups, activeId: groups[0]?.id ?? null };
    return wantActive && available.has(wantActive) ? focusTab(layout, wantActive) : layout;
}
