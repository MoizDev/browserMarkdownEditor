// What the tab bar shows, and where each open document is drawn.
//
// A tab-bar entry is a GROUP of one or more open documents laid out side by
// side (see types/index.ts). Merging tab B into tab A is what produces a group
// of two; the panes are columns, equal until the reader drags the divider
// between two of them, and a group holds at most MAX_SPLIT_PANES of them.
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
// WIDTHS RIDE WITH PATHS. `sizes` is indexed against `paths`, so every
// transition that changes the pane list has to re-derive it in the SAME step —
// which is why nothing below rebuilds a group by spreading `{ ...g, paths }`
// and leaving the widths to follow. Two helpers do it: keepSizes() picks the
// survivors out by INDEX and re-shares what the departing panes held among
// them, and mergeSizes() apportions between two groups being joined. Absent
// means equal, and absent is preserved wherever the answer would have been
// equal anyway — so a tab nobody has resized acquires no widths by being merged
// into, closed out of, or restored.
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

/**
 * The smallest share a STORED arrangement may leave a pane holding.
 *
 * Deliberately well below anything the drag can produce (EditorPane clamps in
 * pixels, against the editor's live width), so the two floors never argue: this
 * one exists only so a hand-edited or hand-written session can't open with a
 * pane too narrow to see, let alone to grab the divider beside. Two percent of
 * five panes is a tenth of the tab, so the floors are always satisfiable.
 */
const MIN_PANE_PCT = 2;

/** Equal columns — what an absent `sizes` means. */
function equalSizes(count: number): number[] {
    return new Array<number>(count).fill(100 / count);
}

/** Equal to within float noise. Stored as ABSENT rather than as a row of
 *  identical numbers, so "nobody has arranged this tab" has one representation
 *  (see TabGroup.sizes) — which is also what lets every helper below hand back
 *  `undefined` and mean it. */
function isEven(sizes: number[]): boolean {
    const even = 100 / sizes.length;
    return sizes.every(s => Math.abs(s - even) < 1e-4);
}

/**
 * THE ONE GATE every width row passes: `count` finite positive percentages
 * summing to 100, none under MIN_PANE_PCT — or `undefined`, meaning equal.
 *
 * The gesture's commit, the redistributions below and a restored session all
 * come through here because all three can be wrong in the same ways:
 * localStorage is user-editable, every earlier build wrote no widths at all,
 * and a commit can land against a group whose pane count moved underneath it.
 * Each of them degrades to equal columns — the state the feature starts in —
 * rather than to a sliver nobody can grab or a NaN reaching a CSS variable.
 *
 * Malformed input is discarded WHOLE rather than partly repaired: guessing at a
 * broken row produces a layout nobody chose, and equal is both the honest
 * answer and what the reader had a moment ago. What survives is read as the
 * RATIOS it expresses, so a row written in any unit still means something.
 */
export function normalizeSizes(value: unknown, count: number): number[] | undefined {
    // The upper bound on `count` is what makes the sub-floor lift below sound:
    // its proof needs `MIN_PANE_PCT * count <= 100`, and restoreLayout passes
    // the length of a group straight out of localStorage — unbounded, and past
    // 50 the lift drives every above-floor pane NEGATIVE. Well clear of
    // MAX_SPLIT_PANES, and of any session an older cap could have written.
    if (count < 2 || count > 100 / MIN_PANE_PCT) return undefined;
    if (!Array.isArray(value) || value.length !== count) return undefined;
    let sum = 0;
    for (const v of value) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
        sum += v;
    }
    // Finite as well as positive: every entry can be finite while the total
    // overflows, and `v * 100 / Infinity` is NaN — which no test below catches
    // (NaN fails every comparison, including isEven's), so a row of them would
    // reach a CSS variable and collapse the columns.
    if (!Number.isFinite(sum) || sum <= 0) return undefined;

    let sizes = (value as number[]).map(v => (v * 100) / sum);
    // Lift anything under the floor, and take what that costs out of the panes
    // above it in proportion to how far above they are — so a hand-written
    // [98, 1, 1] opens as three panes rather than one pane and two slivers.
    // `spare - short` is `100 - MIN_PANE_PCT * count`, which is non-negative by
    // the constant's own rule, so there is always enough to take.
    const short = sizes.reduce((d, s) => d + Math.max(0, MIN_PANE_PCT - s), 0);
    if (short > 0) {
        const spare = sizes.reduce((t, s) => t + Math.max(0, s - MIN_PANE_PCT), 0);
        sizes = spare > 0
            ? sizes.map(s => (s <= MIN_PANE_PCT
                ? MIN_PANE_PCT
                : s - (s - MIN_PANE_PCT) * (short / spare)))
            : equalSizes(count);
    }
    // The residue lands on the last pane: the dividers are drawn at cumulative
    // sums of this row, and the rightmost one has to reach the container's edge.
    const out = sizes.map(s => Math.round(s * 1e4) / 1e4);
    let acc = 0;
    for (let i = 0; i < count - 1; i++) acc += out[i];
    out[count - 1] = Math.round((100 - acc) * 1e4) / 1e4;
    return isEven(out) ? undefined : out;
}

/**
 * The widths a group is DRAWN at, whatever it stores.
 *
 * Total by construction, and the only reader there is — so an absent row, a row
 * that has fallen out of step with `paths`, and a hand-edited session all come
 * out as the equal columns they were before any of this existed.
 */
export function paneSizes(group: TabGroup): number[] {
    const n = group.paths.length;
    const s = group.sizes;
    return (s && s.length === n ? s : undefined) ?? equalSizes(n);
}

/** Two arrangements that draw the same, so a transition that changed nothing
 *  can return the SAME layout object — its identity is the persist effect's
 *  only dependency, and a click that merely landed on a divider must not
 *  rewrite the stored session. */
function sameSizes(a: number[] | undefined, b: number[] | undefined): boolean {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    return a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
}

/**
 * Keep the shares of the panes at `keep` (indices into the group's OLD paths)
 * and re-share what the departing panes held among them IN PROPORTION to what
 * they already had.
 *
 * Proportional because it is the only redistribution that preserves everything
 * still known — the survivors' sizes relative to one another — and the only one
 * that doesn't depend on which neighbour happened to sit beside the pane that
 * left. Handing the freed width to one side makes closing a middle pane
 * lopsided in a way nobody asked for, and evening everything up throws an
 * arrangement away over an edit that was not about it.
 */
function keepSizes(sizes: number[] | undefined, keep: number[]): number[] | undefined {
    if (!sizes) return undefined;
    return normalizeSizes(keep.map(i => sizes[i]), keep.length);
}

/**
 * The widths of a merged tab: each group keeps its own internal proportions,
 * and the width is split between them by PANE COUNT — the n panes already there
 * keep n/(n+k) of it, the k arriving take k/(n+k).
 *
 * So an arriving pane gets exactly the share a new pane is drawn at, which is
 * what makes equal-into-equal come out equal — and therefore absent, so the
 * ordinary merge of two tabs nobody has resized still stores no widths at all.
 * Deliberately not "half of the pane it was dropped beside": the drop position
 * says WHERE the panes go, and reading it as a width too would make the same
 * insertion index mean different sizes depending on which neighbour the pointer
 * happened to be nearest.
 */
function mergeSizes(target: TabGroup, source: TabGroup, at: number): number[] | undefined {
    if (!target.sizes && !source.sizes) return undefined;
    const n = target.paths.length;
    const k = source.paths.length;
    const kept = paneSizes(target).map(s => (s * n) / (n + k));
    const added = paneSizes(source).map(s => (s * k) / (n + k));
    return normalizeSizes([...kept.slice(0, at), ...added, ...kept.slice(at)], n + k);
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
    // Walked by INDEX rather than filtered, because the widths are positional:
    // the surviving panes' shares have to be picked out by the very indices
    // their paths were, or the two come apart. It still drops every occurrence,
    // which is what the test below is about.
    const keep: number[] = [];
    group.paths.forEach((p, i) => { if (p !== path) keep.push(i); });
    const paths = keep.map(i => group.paths[i]);
    // Emptied — normally because that was the tab's only pane. The test is on
    // what is LEFT rather than on the count going in, because the walk drops
    // every occurrence: a group that had somehow been given the same path twice
    // would otherwise survive as a tab with no panes and no name, drawing the
    // "No file open" overlay with no pane left to close.
    if (paths.length === 0) return closeGroup(layout, group.id);

    const activePath = group.activePath === path
        ? paths[Math.min(index, paths.length - 1)]
        : group.activePath;
    const sizes = keepSizes(group.sizes, keep);
    return {
        ...layout,
        groups: layout.groups.map(g => (g.id === group.id ? { ...g, paths, activePath, sizes } : g)),
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
    const sizes = mergeSizes(target, source, at);
    return {
        activeId: target.id,
        groups: layout.groups
            .filter(g => g.id !== source.id)
            .map(g => (g.id === target.id ? { ...g, paths, activePath: source.activePath, sizes } : g)),
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
    const keep: number[] = [];                     // by index — see closePath
    group.paths.forEach((p, i) => { if (p !== path) keep.push(i); });
    const paths = keep.map(i => group.paths[i]);
    const trimmed: TabGroup = {
        ...group,
        paths,
        activePath: group.activePath === path ? paths[Math.min(index, paths.length - 1)] : group.activePath,
        // The survivors share out what the departing pane held, exactly as
        // closing it would have. It takes no width claim with it: a tab of its
        // own is one pane wide.
        sizes: keepSizes(group.sizes, keep),
    };
    const popped: TabGroup = { id: newGroupId(), paths: [path], activePath: path };

    const at = layout.groups.indexOf(group);
    return {
        activeId: popped.id,
        groups: [...layout.groups.slice(0, at), trimmed, popped, ...layout.groups.slice(at + 1)],
    };
}

/**
 * Record a tab's pane widths — what the pointer coming up off a divider means.
 * `null` puts them back to equal columns (a double-click on one).
 *
 * Validated against the group's CURRENT pane count rather than the one the
 * gesture began with: a pane closed mid-drag would otherwise commit widths for
 * an arrangement that no longer exists, and quietly re-sharing them is worse
 * than declining. Returning the same layout when nothing moved is what keeps a
 * click that merely landed on a divider — every double-click starts with one —
 * from rewriting the stored session.
 *
 * Pure, and mints nothing, so StrictMode's double-invoked updater is a no-op
 * the second time round.
 */
export function setGroupSizes(layout: TabLayout, id: string, sizes: number[] | null): TabLayout {
    const group = groupById(layout, id);
    if (!group) return layout;
    if (sizes && sizes.length !== group.paths.length) return layout;
    const next = sizes ? normalizeSizes(sizes, group.paths.length) : undefined;
    if (sameSizes(group.sizes, next)) return layout;
    return {
        ...layout,
        groups: layout.groups.map(g => (g.id === id ? { ...g, sizes: next } : g)),
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
        // group that held only the overwritten file disappears. By index, for
        // the widths' sake: this is the one transition that can take a pane out
        // of a tab without anything closing, and it is the easiest to miss.
        const keep: number[] = [];
        const paths: string[] = [];
        g.paths.forEach((p, i) => {
            if (p === to) return;
            keep.push(i);
            paths.push(p === from ? to : p);
        });
        if (paths.length === 0) continue;
        // The focused pane follows the rename; if it was the pane the rename
        // just overwrote, focus falls to the leftmost survivor.
        const moved = g.activePath === from ? to : g.activePath;
        groups.push({
            ...g,
            paths,
            activePath: paths.includes(moved) ? moved : paths[0],
            // Unchanged in the ordinary case (the walk keeps every index, so
            // the row passes straight through) — a rename must not move a
            // divider. Only the overwrite branch above re-shares anything.
            sizes: keepSizes(g.sizes, keep),
        });
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
 *
 * `storedSizes` holds each stored group's pane widths the same way, and is
 * validated against the pane count the session was WRITTEN at before being
 * narrowed to the panes that actually came back — so a note deleted on disk
 * since takes its share with it and the rest divide it up, exactly as closing
 * that pane would have. A row that doesn't line up, or a session written before
 * dividers could be dragged, restores as equal columns.
 */
export function restoreLayout(
    restored: string[],
    stored: unknown,
    storedFocus: unknown,
    storedSizes: unknown,
    wantActive: string | null,
): TabLayout {
    const available = new Set(restored);
    const placed = new Set<string>();
    const groups: TabGroup[] = [];
    const focus = isStringList(storedFocus) ? storedFocus : [];
    const widths = Array.isArray(storedSizes) ? storedSizes : [];

    if (isPathMatrix(stored)) {
        for (const [entryIndex, entry] of stored.entries()) {
            // `placed` is consulted AND added to as the entry is walked, so a
            // path repeated inside one stored group is dropped just as one
            // repeated across two groups is — a group holding the same path
            // twice would draw one pane while the tab bar counted two.
            const paths: string[] = [];
            const keep: number[] = [];              // where each kept path sat in the STORED entry
            entry.forEach((p, i) => {
                if (!available.has(p) || placed.has(p) || paths.includes(p)) return;
                paths.push(p);
                keep.push(i);
            });
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
                // Validated at the width the session was written at, then
                // narrowed by the same positions the paths were — the cap
                // slices both, so a trimmed group's widths are trimmed with it.
                sizes: keepSizes(
                    normalizeSizes(widths[entryIndex], entry.length),
                    keep.slice(0, MAX_SPLIT_PANES),
                ),
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
