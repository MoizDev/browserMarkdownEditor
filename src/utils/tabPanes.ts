// How the editor is arranged: a row of panes, each holding its own tabs.
//
// A PANE is a column of the editor (see types/index.ts). All of them are drawn
// at once, side by side, separated by dividers the reader can drag; each owns
// an ordered list of open documents — its tabs — and shows one of them. Most
// workspaces are one pane with a few tabs, which is the ordinary tab strip.
// The editor holds at most MAX_PANES columns.
//
// TWO STRUCTURES, ON PURPOSE. `App.tabs` stays a flat list of every open
// document — per-tab autosave, the asset diff, the vault-search overlay, rename
// and move all index it by path and none of them care how the documents are
// arranged — and this module owns the arrangement alone. Folding the two
// together would have put a pane walk in front of every one of those lookups
// for a feature none of them are about.
//
// THE INVARIANT the two share: every open path appears in exactly one pane,
// once, and every path in a pane is an open document. App keeps it by pairing
// each setTabs with the matching layout transition below; nothing here reads
// `tabs`, so a violation shows up as a pane with no document rather than as
// corruption. A great deal downstream rests on the "once" — the EditorState
// cache, the keyboard-target registry and the scroll/fold debounces are all
// keyed by path alone — so no transition here ever puts one path in two panes.
//
// Every operation is a (layout, …) => layout applied inside a setState updater:
// the pane list, the active id and the widths move together, so no intermediate
// state can name a pane that the same update removed. Returning the SAME object
// when nothing changed matters too — the layout's identity is the persist
// effect's dependency.
//
// WIDTHS RIDE WITH PANES. `layout.sizes` is indexed against `layout.panes`, so
// every transition that changes the pane list has to re-derive it in the SAME
// step — which is why nothing below rebuilds a layout by spreading
// `{ ...layout, panes }` and leaving the widths to follow. Two helpers do it:
// keepSizes() picks the survivors out by INDEX and re-shares what the departing
// panes held among them, and insertSize() makes room for an arriving one.
// Absent means equal, and absent is preserved wherever the answer would have
// been equal anyway — so a workspace nobody has resized acquires no widths by
// being split, closed out of, or restored.
//
// HISTORY RIDES WITH activePath. Each pane records where it has been, for the
// back and forward arrows in its header. `activePath` stays the single source
// of truth for what is drawn; showInPane() is the only way it changes, and it
// maintains `history[historyIndex] === activePath`. If the two ever come apart,
// canGoBack/canGoForward read false — two dead buttons, never a jump to a
// document the pane is not holding.
//
// All are pure but four: openTab, splitToPane, restoreLayout and mergeLayouts
// mint a pane id from the counter below, so StrictMode's double-invoked updater
// burns an id and discards a pane object. Harmless — ids only have to be unique
// among the panes that exist at one moment, and both invocations produce unique
// ones — but it is why those are not the drop-in pure functions the rest are.

import type { TabPane, TabLayout } from '../types';

/**
 * How many columns the editor may hold.
 *
 * Five is the point past which the panes stop being useful rather than an
 * implementation limit: at the width of a sidebar-flanked window a sixth column
 * is narrower than a line of prose — and it now has to hold a tab strip and a
 * header as well — and the fit logic in editor/tableFit.ts is already shrinking
 * tables to reach it.
 */
export const MAX_PANES = 5;

export const EMPTY_LAYOUT: TabLayout = { panes: [], activeId: null };

/** Session-unique pane ids. Never persisted — the stored session records each
 *  pane's PATHS, so ids are re-minted on restore and only have to be unique
 *  among the panes that exist at one moment. */
let idSeq = 0;
export function newPaneId(): string {
    return `tp${(++idSeq).toString(36)}`;
}

/**
 * How far back one pane remembers.
 *
 * A cap rather than the whole session because the history is walked on every
 * back/forward and relabelled on every rename, and nobody navigates thirty-two
 * steps back through two panes. Dropping from the FRONT keeps the recent end,
 * which is the end the arrows reach.
 */
const MAX_HISTORY = 32;

/**
 * The smallest share a STORED arrangement may leave a pane holding.
 *
 * Deliberately well below anything the drag can produce (EditorPane clamps in
 * pixels, against the editor's live width), so the two floors never argue: this
 * one exists only so a hand-edited or hand-written session can't open with a
 * pane too narrow to see, let alone to grab the divider beside. Two percent of
 * five panes is a tenth of the editor, so the floors are always satisfiable.
 */
const MIN_PANE_PCT = 2;

/** Equal columns — what an absent `sizes` means. */
function equalSizes(count: number): number[] {
    return new Array<number>(count).fill(100 / count);
}

/** Equal to within float noise. Stored as ABSENT rather than as a row of
 *  identical numbers, so "nobody has arranged this" has one representation
 *  (see TabLayout.sizes) — which is also what lets every helper below hand back
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
 * and a commit can land against a layout whose pane count moved underneath it.
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
    // the length of a session's stored pane list straight out of localStorage —
    // unbounded, and past 50 the lift drives every above-floor pane NEGATIVE.
    // Well clear of MAX_PANES, and of any session an older cap could have
    // written.
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
 * The widths the columns are DRAWN at, whatever the layout stores.
 *
 * Total by construction, and the only reader there is — so an absent row, a row
 * that has fallen out of step with `panes`, and a hand-edited session all come
 * out as the equal columns they were before any of this existed.
 */
export function paneSizes(layout: TabLayout): number[] {
    const n = layout.panes.length;
    const s = layout.sizes;
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
 * Keep the shares of the panes at `keep` (indices into the OLD pane list) and
 * re-share what the departing panes held among them IN PROPORTION to what they
 * already had.
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
 * The widths after a new column is inserted at `at`: the n panes already there
 * keep n/(n+1) of the width and each keeps its own share of that, and the
 * arriving one takes 1/(n+1).
 *
 * So an arriving pane gets exactly the share a new pane is drawn at, which is
 * what makes a split of equal columns come out equal — and therefore absent, so
 * splitting a workspace nobody has resized still stores no widths at all.
 * Deliberately not "half of the pane it was dropped beside": the drop position
 * says WHERE the column goes, and reading it as a width too would make the same
 * insertion index mean different sizes depending on which neighbour the pointer
 * happened to be nearest.
 */
function insertSize(layout: TabLayout, at: number): number[] | undefined {
    if (!layout.sizes) return undefined;
    const n = layout.panes.length;
    const kept = paneSizes(layout).map(s => (s * n) / (n + 1));
    return normalizeSizes([...kept.slice(0, at), 100 / (n + 1), ...kept.slice(at)], n + 1);
}

export function paneOf(layout: TabLayout, path: string): TabPane | null {
    return layout.panes.find(p => p.paths.includes(path)) ?? null;
}

export function paneById(layout: TabLayout, id: string | null): TabPane | null {
    return id === null ? null : layout.panes.find(p => p.id === id) ?? null;
}

/** The column with focus. */
export function focusedPane(layout: TabLayout): TabPane | null {
    return paneById(layout, layout.activeId);
}

/** The document ⌘E, ⌘S, the URL hash and the file tree's highlight all mean —
 *  the tab showing in the focused column. */
export function focusedPath(layout: TabLayout): string | null {
    return focusedPane(layout)?.activePath ?? null;
}

/** Every path currently drawn: one per column, since a pane shows one tab.
 *  App's autosave gate reads it to tell a document on screen from one that is
 *  merely open behind another tab. */
export function visiblePaths(layout: TabLayout): string[] {
    return layout.panes.map(p => p.activePath);
}

/* ── Per-pane history ────────────────────────────────────────────────────── */

/**
 * Point a pane at one of its tabs, recording the move.
 *
 * The only writer of `activePath`, so the invariant `history[historyIndex] ===
 * activePath` has one place to hold. A forward branch is discarded on a new
 * move, exactly as a browser's is: the reader went back and then somewhere
 * else, and what they skipped past is no longer ahead of them.
 *
 * Returns the SAME pane when it is already showing `path` AND the history says
 * so — which is what lets focusTab/selectTab hand back the same layout for a
 * click on the tab that is already fronted.
 *
 * When the history ALREADY points at `path` but `activePath` does not, the move
 * has been made for us and only the label is behind: that is what
 * `forgetInHistory` leaves when the showing tab is the one closing, and pushing
 * there duplicated the survivor (`[A] → [A, A]`). `back` then found an entry it
 * could legally step to, so ← read as available and did nothing when pressed.
 */
function showInPane(pane: TabPane, path: string): TabPane {
    if (pane.history[pane.historyIndex] === path) {
        return pane.activePath === path ? pane : { ...pane, activePath: path };
    }
    const history = pane.history.slice(0, pane.historyIndex + 1);
    history.push(path);
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    return { ...pane, activePath: path, history, historyIndex: history.length - 1 };
}

/**
 * Drop every trace of a path from a pane's history — what closing a tab, or
 * dragging it into another pane, leaves behind.
 *
 * Dropped rather than left to be skipped, because the history is also what the
 * rename walks: a path nothing holds any more would sit there being relabelled
 * forever, and `back` would have to decide every time whether it names a
 * document or a ghost. The index follows the entry that was showing; if that
 * was the entry going, it falls to the nearest survivor BEFORE it, so a later
 * `back` steps further into the past rather than landing where it already is.
 */
function forgetInHistory(pane: TabPane, path: string): TabPane {
    if (!pane.history.includes(path)) return pane;
    const history: string[] = [];
    let index = -1;
    pane.history.forEach((p, i) => {
        if (p === path) {
            if (i === pane.historyIndex) index = history.length - 1;
            return;
        }
        history.push(p);
        if (i <= pane.historyIndex) index = history.length - 1;
    });
    return { ...pane, history, historyIndex: Math.max(0, Math.min(index, history.length - 1)) };
}

/**
 * Where a step lands, or null when there is nowhere to go.
 *
 * Entries naming a document this pane no longer holds are SKIPPED rather than
 * landed on — belt to forgetInHistory's braces, which is the part that actually
 * removes them. And the invariant is checked first: a pane whose history has
 * come apart from its `activePath` has no honest answer, so both arrows go
 * dead instead of guessing at one.
 */
function stepTarget(pane: TabPane, dir: -1 | 1): number | null {
    if (pane.history[pane.historyIndex] !== pane.activePath) return null;
    const open = new Set(pane.paths);
    let i = pane.historyIndex + dir;
    while (i >= 0 && i < pane.history.length && !open.has(pane.history[i])) i += dir;
    return i >= 0 && i < pane.history.length ? i : null;
}

export function canGoBack(pane: TabPane): boolean {
    return stepTarget(pane, -1) !== null;
}

export function canGoForward(pane: TabPane): boolean {
    return stepTarget(pane, 1) !== null;
}

/** Walk one pane's history WITHOUT recording the walk — the forward branch has
 *  to survive a `back`, or `forward` would have nothing to return to. */
function step(layout: TabLayout, paneId: string, dir: -1 | 1): TabLayout {
    const pane = paneById(layout, paneId);
    if (!pane) return layout;
    const at = stepTarget(pane, dir);
    if (at === null) return layout;
    const next: TabPane = { ...pane, historyIndex: at, activePath: pane.history[at] };
    return {
        ...layout,
        activeId: paneId,
        panes: layout.panes.map(p => (p.id === paneId ? next : p)),
    };
}

export function goBack(layout: TabLayout, paneId: string): TabLayout {
    return step(layout, paneId, -1);
}

export function goForward(layout: TabLayout, paneId: string): TabLayout {
    return step(layout, paneId, 1);
}

/* ── Transitions ─────────────────────────────────────────────────────────── */

/** Put the focus on an already-open document: its pane takes focus and fronts
 *  that tab. A path this layout doesn't know is ignored rather than guessed at
 *  (see openTab for the opening case). */
export function focusTab(layout: TabLayout, path: string): TabLayout {
    const pane = paneOf(layout, path);
    if (!pane) return layout;
    const next = showInPane(pane, path);
    if (next === pane && layout.activeId === pane.id) return layout;
    return {
        ...layout,
        activeId: pane.id,
        panes: next === pane ? layout.panes : layout.panes.map(p => (p.id === pane.id ? next : p)),
    };
}

/** Open a document as a tab of the FOCUSED pane, at the end of its strip.
 *  Already open — in any pane — means focus it instead, which is what makes
 *  this safe to call from the two paths that race each other on a double
 *  click. */
export function openTab(layout: TabLayout, path: string): TabLayout {
    if (paneOf(layout, path)) return focusTab(layout, path);
    const target = focusedPane(layout) ?? layout.panes[0] ?? null;
    if (!target) {
        const id = newPaneId();
        return { panes: [{ id, paths: [path], activePath: path, history: [path], historyIndex: 0 }], activeId: id };
    }
    const next = showInPane({ ...target, paths: [...target.paths, path] }, path);
    return {
        ...layout,
        activeId: target.id,
        panes: layout.panes.map(p => (p.id === target.id ? next : p)),
    };
}

/** A click on a tab: that pane takes focus and fronts that tab. */
export function selectTab(layout: TabLayout, paneId: string, path: string): TabLayout {
    const pane = paneById(layout, paneId);
    if (!pane || !pane.paths.includes(path)) return layout;
    const next = showInPane(pane, path);
    if (next === pane && layout.activeId === paneId) return layout;
    return {
        ...layout,
        activeId: paneId,
        panes: next === pane ? layout.panes : layout.panes.map(p => (p.id === paneId ? next : p)),
    };
}

/** Where focus lands once the pane at `index` is gone: the column that slid
 *  into its place, else the one before it, else nothing. Mirrors what closing
 *  the last tab of a pane has always done. */
function neighbourId(panes: TabPane[], index: number): string | null {
    return panes[index]?.id ?? panes[index - 1]?.id ?? null;
}

/** Close a whole column — every tab in it. */
export function closePane(layout: TabLayout, paneId: string): TabLayout {
    const index = layout.panes.findIndex(p => p.id === paneId);
    if (index === -1) return layout;
    const keep: number[] = [];                     // by index — the widths are positional
    layout.panes.forEach((p, i) => { if (p.id !== paneId) keep.push(i); });
    const panes = keep.map(i => layout.panes[i]);
    return {
        panes,
        activeId: layout.activeId === paneId ? neighbourId(panes, index) : layout.activeId,
        sizes: keepSizes(layout.sizes, keep),
    };
}

/** Close ONE document. The last tab of a pane takes the column with it —
 *  its width re-shared among the survivors; otherwise the column stays and, if
 *  this was the tab it was showing, it falls to whatever slid into the slot. */
export function closePath(layout: TabLayout, path: string): TabLayout {
    const pane = paneOf(layout, path);
    if (!pane) return layout;

    const index = pane.paths.indexOf(path);
    // Every occurrence goes: a pane that had somehow been given the same path
    // twice would otherwise survive with a tab whose document has closed.
    const paths = pane.paths.filter(p => p !== path);
    if (paths.length === 0) return closePane(layout, pane.id);

    let next = forgetInHistory({ ...pane, paths }, path);
    if (pane.activePath === path) next = showInPane(next, paths[Math.min(index, paths.length - 1)]);
    return { ...layout, panes: layout.panes.map(p => (p.id === pane.id ? next : p)) };
}

/**
 * Move a tab: within its own strip (a reorder) or into another pane's.
 *
 * `toIndex` indexes the destination's PRE-removal `paths` — it is where the
 * drop indicator sat, which is between two tabs that were both still there.
 * Focus goes to the destination and the tab is fronted there: the drag is a
 * statement about which document the reader wants to be looking at.
 *
 * A source pane emptied by the move goes with its last tab, exactly as closing
 * it would, widths and all.
 */
export function moveTabToPane(layout: TabLayout, path: string, toPaneId: string, toIndex: number): TabLayout {
    const from = paneOf(layout, path);
    const to = paneById(layout, toPaneId);
    if (!from || !to) return layout;

    if (from.id === to.id) {
        const at = from.paths.indexOf(path);
        const insertAt = Math.max(0, Math.min(toIndex > at ? toIndex - 1 : toIndex, from.paths.length - 1));
        if (insertAt === at) return layout;
        const paths = from.paths.slice();
        paths.splice(at, 1);
        paths.splice(insertAt, 0, path);
        return {
            ...layout,
            activeId: from.id,
            panes: layout.panes.map(p => (p.id === from.id ? { ...p, paths } : p)),
        };
    }

    const at = Math.max(0, Math.min(toIndex, to.paths.length));
    const dst = showInPane({ ...to, paths: [...to.paths.slice(0, at), path, ...to.paths.slice(at)] }, path);
    const srcPaths = from.paths.filter(p => p !== path);

    if (srcPaths.length === 0) {
        const keep: number[] = [];                 // by index — see closePane
        layout.panes.forEach((p, i) => { if (p.id !== from.id) keep.push(i); });
        return {
            panes: keep.map(i => (layout.panes[i].id === to.id ? dst : layout.panes[i])),
            activeId: to.id,
            sizes: keepSizes(layout.sizes, keep),
        };
    }

    const index = from.paths.indexOf(path);
    let src = forgetInHistory({ ...from, paths: srcPaths }, path);
    if (from.activePath === path) src = showInPane(src, srcPaths[Math.min(index, srcPaths.length - 1)]);
    return {
        ...layout,
        activeId: to.id,
        panes: layout.panes.map(p => (p.id === from.id ? src : p.id === to.id ? dst : p)),
    };
}

/** True when dropping `path` onto the editor body would open a new column for
 *  it: it has to be open, and five columns is the ceiling. The drop zone asks
 *  this before it offers an insertion point. */
export function canSplitToPane(layout: TabLayout, path: string | null): boolean {
    return !!path && !!paneOf(layout, path) && layout.panes.length < MAX_PANES;
}

/**
 * Take a tab out of its pane and give it a column of its own at `at`
 * (0 = left of every existing column, panes.length = right of all of them) —
 * what dropping a tab onto the editor body means. It takes the focus with it.
 *
 * Dragging a pane's ONLY tab back onto its own column is refused rather than
 * rebuilt: the arrangement it asks for is the one already on screen, and going
 * through with it would mint a pane id, drop the pane's history and re-share
 * widths for nothing.
 */
export function splitToPane(layout: TabLayout, path: string, at: number): TabLayout {
    if (!canSplitToPane(layout, path)) return layout;
    const from = paneOf(layout, path)!;
    const fromIndex = layout.panes.indexOf(from);
    const solo = from.paths.length === 1;
    if (solo && (at === fromIndex || at === fromIndex + 1)) return layout;

    // Through closePath, so the source's history, its focus fallback and — when
    // this was its last tab — its column and its width are all settled by the
    // one function that already knows how.
    const base = closePath(layout, path);
    // A source column removed from an EARLIER index shifts every later
    // insertion point down by one; `at` indexed the pane list as it was drawn.
    const insertAt = Math.max(0, Math.min(solo && at > fromIndex ? at - 1 : at, base.panes.length));
    const pane: TabPane = { id: newPaneId(), paths: [path], activePath: path, history: [path], historyIndex: 0 };
    return {
        panes: [...base.panes.slice(0, insertAt), pane, ...base.panes.slice(insertAt)],
        activeId: pane.id,
        sizes: insertSize(base, insertAt),
    };
}

/**
 * Record the columns' widths — what the pointer coming up off a divider means.
 * `null` puts them back to equal columns (a double-click on one).
 *
 * Validated against the CURRENT pane count rather than the one the gesture
 * began with: a column closed mid-drag would otherwise commit widths for an
 * arrangement that no longer exists, and quietly re-sharing them is worse than
 * declining. Returning the same layout when nothing moved is what keeps a click
 * that merely landed on a divider — every double-click starts with one — from
 * rewriting the stored session.
 *
 * Pure, and mints nothing, so StrictMode's double-invoked updater is a no-op
 * the second time round.
 */
export function setPaneSizes(layout: TabLayout, sizes: number[] | null): TabLayout {
    if (sizes && sizes.length !== layout.panes.length) return layout;
    const next = sizes ? normalizeSizes(sizes, layout.panes.length) : undefined;
    if (sameSizes(layout.sizes, next)) return layout;
    return { ...layout, sizes: next };
}

/**
 * Follow a document that was renamed or moved. The layout indexes documents by
 * path, so missing this leaves a tab pointing at a file that no longer answers
 * to that name.
 *
 * `to` MAY already be open: renameFile/moveFile deliberately overwrite an
 * existing name (an explicit move onto a name is the user saying so), and the
 * file that was sitting there is now gone. Renaming `from` in place would then
 * put one path in two tabs — React draws one of them, the strip counts both,
 * and closing it takes every copy at once. So the old occupant is REMOVED here
 * rather than left to collide, and a pane emptied by that goes with it. App
 * closes the shadowed tab alongside; this keeps the transition alone from being
 * able to produce the broken shape.
 */
export function renamePath(layout: TabLayout, from: string, to: string): TabLayout {
    if (!paneOf(layout, from) || from === to) return layout;

    const keep: number[] = [];                     // by index — see closePane
    const panes: TabPane[] = [];
    layout.panes.forEach((pane, i) => {
        if (!pane.paths.includes(from) && !pane.paths.includes(to)) {
            keep.push(i);
            panes.push(pane);
            return;
        }
        // Drop any pre-existing `to` everywhere, then let `from` become it — so
        // whichever pane held `from` ends up with exactly one `to`, and a pane
        // that held only the overwritten file disappears. This is the one
        // transition that can take a column out without anything closing, and
        // it is the easiest to miss.
        const paths = pane.paths.filter(p => p !== to).map(p => (p === from ? to : p));
        if (paths.length === 0) return;
        // The showing tab follows the rename; if it was the tab the rename just
        // overwrote, it falls to the leftmost survivor.
        const wanted = pane.activePath === from ? to : pane.activePath;
        const activePath = paths.includes(wanted) ? wanted : paths[0];
        const forgotten = forgetInHistory(pane, to);
        keep.push(i);
        panes.push(showInPane({
            ...forgotten,
            paths,
            activePath,
            history: forgotten.history.map(p => (p === from ? to : p)),
        }, activePath));
    });
    return {
        panes,
        activeId: panes.some(p => p.id === layout.activeId) ? layout.activeId : panes[0]?.id ?? null,
        // Unchanged in the ordinary case (every pane survives, so the row passes
        // straight through) — a rename must not move a divider.
        sizes: keepSizes(layout.sizes, keep),
    };
}

/**
 * Rename several documents AT ONCE — each path `to` names becomes what it maps
 * to, in one step. What the restore pass needs when notes it was still loading
 * were renamed or moved meanwhile (issue #9): it rebuilds the layout from the
 * session's stored paths, and then relabels that into where they are now.
 *
 * Not renamePath in a loop. That one's overwrite branch removes a tab already
 * holding the destination, which for a chain is exactly wrong: the reader
 * renamed `b→c` and then `a→b`, and the stored tabs are `a` and `b`. Applied
 * `a→b` first, the overwrite deletes tab `b` — a live document's — and `b→c`
 * then carries `a`'s tab off to `c`. Getting the order right means a
 * topological sort (and a cycle has none); a simultaneous relabel has no order
 * to get wrong. `to` must be INJECTIVE over the layout's paths — the restore's
 * registry guarantees it by dropping whatever a move overwrote.
 *
 * Positions never move, so `sizes` (indexed against `panes`) stays aligned and
 * passes through untouched. Returns the SAME layout when nothing changed.
 */
export function relabelPaths(layout: TabLayout, to: ReadonlyMap<string, string>): TabLayout {
    if (to.size === 0) return layout;
    let changed = false;
    const panes = layout.panes.map(pane => {
        if (!pane.paths.some(p => to.has(p)) && !pane.history.some(p => to.has(p))) return pane;
        changed = true;
        return {
            ...pane,
            paths: pane.paths.map(p => to.get(p) ?? p),
            activePath: to.get(pane.activePath) ?? pane.activePath,
            history: pane.history.map(p => to.get(p) ?? p),
        };
    });
    return changed ? { ...layout, panes } : layout;
}

/** localStorage holds whatever an older build (or a hand edit) wrote. */
function isPathMatrix(value: unknown): value is string[][] {
    return Array.isArray(value)
        && value.every(pane => Array.isArray(pane) && pane.every(p => typeof p === 'string'));
}

/** The per-pane showing tab, stored alongside the grouping rather than inside
 *  it so a session's `groups` keeps the plain string[][] shape it has always
 *  had (see StoredSession in utils/tabSessions.ts). */
function isStringList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(p => typeof p === 'string');
}

/**
 * Rebuild the editor's arrangement from a restored session.
 *
 * `restored` is the paths whose files were actually re-read, in stored order;
 * `stored` is the recorded arrangement — one row per COLUMN, holding that
 * column's tabs — which may be missing, stale (a note deleted on disk since) or
 * invalid. Anything a stored row can't account for still opens, as a tab of the
 * last column.
 *
 * `storedFocus` names each column's showing tab, positionally. It is read
 * before any filtering, so it stays aligned with `stored` however much of the
 * session has gone stale, and a session written without it (or naming a tab
 * since deleted) simply falls back to that column's leftmost.
 *
 * `storedSizes` is ONE row for the whole editor, validated against the column
 * count the session was WRITTEN at before being narrowed to the columns that
 * actually came back — so a column whose every note was deleted on disk takes
 * its share with it and the rest divide it up, exactly as closing it would
 * have. A row that doesn't line up, or a session written before dividers could
 * be dragged, restores as equal columns.
 *
 * NOTHING IS DROPPED. Rows past MAX_PANES, and paths no row accounts for,
 * become TABS of the last column rather than being closed: the layout is
 * rebuilt from what came back and the persist effect files that as the whole
 * session, so a path dropped here is a document gone from the vault's tabs for
 * good (issue #8).
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
    const panes: TabPane[] = [];
    const keep: number[] = [];                     // which stored rows became columns
    const focus = isStringList(storedFocus) ? storedFocus : [];
    const rows = isPathMatrix(stored) ? stored : [];

    for (const [rowIndex, row] of rows.entries()) {
        // `placed` is consulted AND added to as the row is walked, so a path
        // repeated inside one row is dropped just as one repeated across two
        // is — a pane holding the same path twice would draw one document while
        // the strip counted two.
        const paths = row.filter(p => {
            if (!available.has(p) || placed.has(p)) return false;
            placed.add(p);
            return true;
        });
        if (!paths.length) continue;
        const last = panes[panes.length - 1];
        // A session recording more columns than the cap allows (a lowered
        // limit, a hand edit) keeps its first columns and lets the rest become
        // tabs of the last one.
        if (last && panes.length >= MAX_PANES) {
            last.paths.push(...paths);
            continue;
        }
        const wanted = focus[rowIndex];
        const activePath = wanted && paths.includes(wanted) ? wanted : paths[0];
        panes.push({ id: newPaneId(), paths, activePath, history: [activePath], historyIndex: 0 });
        keep.push(rowIndex);
    }

    const leftover = restored.filter(p => !placed.has(p));
    if (leftover.length) {
        const last = panes[panes.length - 1];
        if (last) last.paths.push(...leftover);
        else panes.push({
            id: newPaneId(),
            paths: leftover,
            activePath: leftover[0],
            history: [leftover[0]],
            historyIndex: 0,
        });
    }

    const layout: TabLayout = {
        panes,
        activeId: panes[0]?.id ?? null,
        // Validated at the width the session was written at, then narrowed by
        // the rows that actually became columns.
        sizes: keepSizes(normalizeSizes(storedSizes, rows.length), keep),
    };
    return wantActive && available.has(wantActive) ? focusTab(layout, wantActive) : layout;
}

/**
 * A restored session with whatever was opened while it loaded laid over it.
 *
 * `base` keeps its columns, their order and their widths; anything `opened`
 * holds that `base` does not is appended as a TAB of `base`'s focused column,
 * in `opened`'s order. Tabs rather than columns because these are the one or
 * two notes a reader clicked while the session was still reading files — not an
 * arrangement they asked for — and because appending columns could breach
 * MAX_PANES. Focus goes to what `opened` had focused (the reader's last
 * gesture), else stays where `base` put it.
 *
 * Merging rather than letting one side win is the point: the restore pass used
 * to defer to anything opened during its reads, and by then it had already
 * un-gated persistence — so deferring wrote that one tab over the whole stored
 * session (see App's restore pass).
 */
export function mergeLayouts(base: TabLayout, opened: TabLayout): TabLayout {
    if (opened.panes.length === 0) return base;
    const wantFocus = focusedPath(opened);
    const held = new Set(base.panes.flatMap(p => p.paths));
    const extra = opened.panes.flatMap(p => p.paths).filter(p => !held.has(p));

    let merged = base;
    if (extra.length) {
        const target = focusedPane(base) ?? base.panes[0] ?? null;
        if (!target) {
            const id = newPaneId();
            merged = {
                panes: [{ id, paths: extra, activePath: extra[0], history: [extra[0]], historyIndex: 0 }],
                activeId: id,
            };
        } else {
            merged = {
                ...base,
                panes: base.panes.map(p => (p.id === target.id ? { ...p, paths: [...p.paths, ...extra] } : p)),
            };
        }
    }
    return wantFocus ? focusTab(merged, wantFocus) : merged;
}
