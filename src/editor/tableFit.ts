import type { EditorView } from '@codemirror/view';

/* ─────────────────────────────────────────────────────────────────────────
 * FITTING A RENDERED TABLE TO THE NOTE'S TEXT WIDTH
 *
 * A markdown table has no width of its own — it is as wide as its columns need
 * to be — while the text width is whatever the reader configured (Settings →
 * "Text width", plus the window and sidebar). When the two disagree the
 * browser's only answer is to squeeze columns until their contents wrap, and
 * it will happily squeeze a column narrower than its longest WORD: CodeMirror's
 * line wrapping puts `overflow-wrap: anywhere` on .cm-content, cells inherit
 * it, and `anywhere` (unlike `break-word`) also collapses the table's intrinsic
 * MINIMUM width — so "Location" came out as "Locat / ion".
 *
 * index.css now gives cells ordinary HTML text behaviour again, which makes a
 * column's min-content width mean something. This module answers the width
 * question outright:
 *
 *   1. measure, for every column, the width it needs to never wrap (max) and
 *      the width below which a word would break (min);
 *   2. hand the available width out MAX-MIN FAIRLY — every column gets what it
 *      asks for while there is room, and the columns that want more than their
 *      share split the remainder evenly. The browser's own auto layout instead
 *      shares out space in proportion to how much each column wants, so one
 *      column holding a paragraph starves every short column beside it — which
 *      is exactly how "Start Date" ends up on two lines with room to spare;
 *   3. if a fair hand-out still cannot give the short columns their content,
 *      shrink the whole table's TYPE until it can. Scaling is what buys real
 *      room: a table laid out at 1/s the width and rendered at s fits 1/s as
 *      many characters per line as one laid out at the width directly.
 *
 * Wrapping isn't the enemy — a column holding a sentence is expected to wrap.
 * Only wrapping a reader would take for damage is: a broken word, or a short
 * label folded in half. COMFORT_EM is where that line is drawn. A column asks
 * for its whole content up to that width and for no more than that width
 * beyond it, so a paragraph column asks for a comfortable measure rather than
 * for the paragraph, and a label column is satisfied outright. Note what that
 * does and does not mean: a long column can still push the table into
 * shrinking — it is asking for a comfortable width, not for nothing — but it
 * can never dictate the size on its own, and what it is given back is
 * whatever is left after the short columns are satisfied.
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * The most a single column may DEMAND, in em — i.e. how long a cell can be and
 * still be considered "short enough that wrapping it would look broken".
 * Roughly 24 characters: every one-word cell, and phrases like "Start Date" or
 * "Katherine Johnson", clear it comfortably.
 *
 * It is the one knob that decides when a table shrinks. Larger, and long-ish
 * cells force a shrink too (everything gets smaller for one column's sake);
 * smaller, and short labels start folding in half before anything gives.
 */
const COMFORT_EM = 12;

/* Two floors on the type size, for two different questions.

   The COMFORT floor answers "how small may the table get to avoid WRAPPING?"
   — at it, the shrinking stops and whatever wrapping is left is accepted, on
   the grounds that past this size the cure is worse than the disease. The HARD
   floor answers "how small may it get to avoid BREAKING A WORD?", and sits
   lower because what it prevents is worse. Both are the stricter of an
   absolute size and a fraction of the note's, so a 12px note barely shrinks
   and a 28px one may shrink a long way — and neither can shrink past being
   readable. */
const MIN_TABLE_FONT_PX = 11;
const MIN_SCALE = 0.6;
const HARD_MIN_FONT_PX = 8;
const HARD_MIN_SCALE = 0.45;

/* Every measured width is asked for with a little slack, because a column
   handed EXACTLY its measured width wraps anyway: a measured cell box and a
   column width set from that measurement don't account for the collapsed
   borders identically. Measure "npm run typecheck" at 155px, give its column
   exactly that, and it folds after "run" by one pixel. A few pixels covers it,
   plus a fraction of a percent for wherever the scale search below stopped.
   Both are far below the threshold of noticing. */
const SLACK_PX = 3;
const SLACK_RATIO = 1.005;

/** Scale searches after the first measurement, and the margin at which the
 *  search calls it settled. The step is multiplicative, so each pass lands
 *  within the non-linearity it is correcting for — a couple of percent — and
 *  the one after that settles it. A table that already fits costs one pass. */
const MAX_FIT_PASSES = 3;
const FIT_EPSILON = 0.002;

/** Sample text for the font sensor — mixed widths, so any metric change moves it. */
const FONT_PROBE_TEXT = 'MWmw0123456789iIlL';

/**
 * The last fit applied to a given table's source, so that a table which is
 * RE-created — the caret leaving it, ⌘E, a tab switch, scrolling back to it —
 * comes back already fitted instead of being laid out once at its natural size
 * and corrected a moment later.
 *
 * That correction is invisible in itself (resize observations are delivered
 * before paint) but it is not free, because CodeMirror measures the line in the
 * animation frame BEFORE it. So CM draws the caret against the unfitted, taller
 * table — and then has no way to learn better: it only re-reads line heights
 * when its own content box changes, which on a document shorter than the
 * viewport it never does. The symptom was a caret stranded a few hundred pixels
 * below the click that placed it, snapping back only on the next keystroke.
 * Rendering the table pre-fitted removes the height change, and with it the
 * problem — there is nothing to correct.
 *
 * Keyed by the table's source, which is exactly the widget's identity (see
 * TableWidget.eq), and carrying the two inputs it was computed from so a stale
 * entry is never trusted: a different width or font just re-fits. Bounded, like
 * the mermaid SVG cache, since the keys accumulate across a session.
 */
interface AppliedFit {
    avail: number;
    font: number;
    /** Column widths as percentage strings, and which columns may break. */
    widths: string[];
    breaks: boolean[];
    /** `font-size` for the table, '' at full size. */
    fontSize: string;
    /** The editor metrics this was computed against — see editorMetrics. */
    at: { avail: number; font: string };
}
const lastFit = new Map<string, AppliedFit>();
const FIT_CACHE_MAX = 32;

/**
 * The text width and font a widget is about to be built into, read from the
 * editor rather than remembered — a remembered value goes stale exactly when it
 * matters, because the editor can be resized while a table is showing its
 * source and so not being fitted by anything.
 *
 * The width is `.cm-content`'s content box, which is what a widget's probe
 * spans; the font is the computed shorthand, which moves whenever the metrics
 * the fit was computed against do.
 */
function editorMetrics(view: EditorView): { avail: number; font: string } {
    const dom = view.contentDOM;
    const cs = getComputedStyle(dom);
    return {
        avail: dom.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        font: `${cs.fontSize} ${cs.fontFamily} ${cs.fontWeight}`,
    };
}

/** One rendered table being kept fitted to its container. */
export interface TableFit {
    /** The table's markdown source — the widget's identity, and the fit cache's key. */
    key: string;
    /** The editor holding this table — see the end of a fit, which is where a
     *  height change has to be announced or the caret is left behind by it. */
    view: EditorView;
    /** `.cm-table-widget` — the widget's outer box. */
    container: HTMLElement;
    /** Zero-height block whose width IS the available text width. */
    widthProbe: HTMLElement;
    /** Hidden text whose width changes iff the note's font metrics change. */
    fontProbe: HTMLElement;
    table: HTMLTableElement;
    cols: HTMLTableColElement[];
    /** Inputs of the last fit, so a re-notification with nothing new is free. */
    lastAvail: number;
    lastFont: number;
    /** Which columns were last allowed to break, so the per-cell style only
     *  gets rewritten when that set actually changes. */
    lastBreaks: string;
    /** Whether this widget has been fitted since it was built. */
    fitted: boolean;
}

/* Keyed by all three elements: a notification arrives on one of the probes and
   has to find its table, and destroy() arrives with the container and has to
   release all of them. (The container itself is never observed — its entry
   exists only so release can start from it.) */
const tracked = new Map<Element, TableFit>();

/**
 * ONE observer for every table in the session.
 *
 * It watches the two PROBES rather than the container, because the probes are
 * the fit's inputs: nothing the fitter writes — the table's type size, the
 * column percentages, a cell's wrapping — can change either one. Watching the
 * container instead would notify on its own height change after every single
 * fit. (The invariant is about the widget, not the whole page: a fit changes
 * the table's height, and on a platform whose scrollbars take layout space
 * that can toggle the editor's own scrollbar, which moves .cm-content's
 * PERCENTAGE padding and so the probe. Chromium bounds that at one round per
 * frame; it has not been observed on the overlay-scrollbar platforms this app
 * targets, but it is why this claim stops at the widget's edge.)
 *
 * The disconnected sweep mirrors mermaidWidget's: `tracked` holds strong
 * references, so a widget whose destroy() was somehow missed would pin its DOM
 * and be re-measured forever. Dropping it here costs nothing and closes that.
 */
const observer = new ResizeObserver(entries => {
    const pending = new Set<TableFit>();
    for (const entry of entries) {
        const fit = tracked.get(entry.target);
        if (!fit) continue;
        if (!fit.container.isConnected) { releaseTableFit(fit.container); continue; }
        pending.add(fit);
    }
    // One fit per table, however many of its probes reported.
    for (const fit of pending) applyFit(fit);
});

/** Write a remembered fit onto a table that has not been laid out yet, so its
 *  FIRST layout is its final one. See AppliedFit. */
function restoreFit(fit: TableFit): void {
    const done = lastFit.get(fit.key);
    if (!done || done.widths.length !== fit.cols.length) return;
    // Only if the editor is still the width and font it was fitted at.
    const now = editorMetrics(fit.view);
    if (Math.abs(done.at.avail - now.avail) > 0.5 || done.at.font !== now.font) return;
    fit.table.style.tableLayout = 'fixed';
    fit.table.style.fontSize = done.fontSize;
    for (let i = 0; i < fit.cols.length; i++) fit.cols[i].style.width = done.widths[i];
    for (const row of fit.table.rows) {
        for (let i = 0; i < fit.cols.length; i++) {
            if (row.cells[i]) row.cells[i].style.overflowWrap = done.breaks[i] ? 'break-word' : '';
        }
    }
    // Adopt the inputs too: if the table is still at that width and font, the
    // first notification then has nothing to do, and if it isn't, it re-fits.
    fit.lastAvail = done.avail;
    fit.lastFont = done.font;
    fit.lastBreaks = done.breaks.map((b, i) => (b ? `${i},` : '')).join('');
}

/** Start keeping `fit`'s table sized to its container. */
export function observeTableFit(fit: TableFit): void {
    restoreFit(fit);
    tracked.set(fit.container, fit);
    tracked.set(fit.widthProbe, fit);
    tracked.set(fit.fontProbe, fit);
    // The initial callback these schedule is what performs the first fit —
    // delivered after layout but before paint, so nothing unfitted is shown.
    observer.observe(fit.widthProbe);
    observer.observe(fit.fontProbe);
}

/**
 * Point a tracked table's memo key at its new source, and nothing else.
 *
 * A cell write-back changes the source on every keystroke, so the fit cache
 * would otherwise be looking up a key the table no longer has — and the entry
 * it wrote a moment ago would accumulate one per character. It must NOT re-fit:
 * the columns moving under the user's hands mid-word is exactly the thing the
 * fitter's own "a content change alone never re-fits" rule already promises.
 */
export function rekeyTableFit(container: Element, key: string): void {
    const fit = tracked.get(container);
    if (fit) fit.key = key;
}

/* Retunes waiting for the next animation frame, coalesced per table — the same
   "one fit per table however many notifications" shape the observer uses. */
const retunePending = new Set<TableFit>();
let retuneFrame = 0;

/**
 * A table's SHAPE changed — a row or a column was added or removed, or ⌘E
 * flipped the mode — so the remembered fit is re-applied at once and a real
 * re-measure is scheduled for the next frame.
 *
 * Two things about this are load-bearing.
 *
 * `fitted` is reset. `firstFitOfThisWidget` is what licenses the height-map
 * re-state at the end of applyFit, and a row or column change is precisely the
 * case that reliably changes the table's height — the one CodeMirror has
 * already measured. Leaving `fitted` true would skip the re-state and strand
 * the caret, which is the bug that whole block exists to prevent.
 *
 * And applyFit is DEFERRED rather than called here. Every caller of this
 * function runs inside a CodeMirror update — updateDOM is reached from
 * findWidget inside DocView.update — where EditorView.update throws
 * ("Calls to EditorView.update are not allowed while an update is in
 * progress", @codemirror/view:7810, measured). applyFit's tail dispatches
 * whenever the height changed and this is the widget's first fit, which the
 * reset above makes true again. So a synchronous re-fit would throw out of the
 * middle of CodeMirror's update on the first "add column". restoreFit is style
 * writes only and is safe to run here, which is what keeps the one-frame gap
 * from being visible on a table that has been fitted at this width before.
 */
export function retuneTableFit(
    container: Element,
    key: string,
    next?: { table: HTMLTableElement; cols: HTMLTableColElement[] },
): void {
    const fit = tracked.get(container);
    if (!fit) return;
    fit.key = key;
    if (next) {
        fit.table = next.table;
        fit.cols = next.cols;
    }
    fit.lastAvail = -1;
    fit.lastFont = -1;
    fit.lastBreaks = '';
    fit.fitted = false;
    restoreFit(fit);

    retunePending.add(fit);
    if (retuneFrame) return;
    retuneFrame = requestAnimationFrame(() => {
        retuneFrame = 0;
        const due = [...retunePending];
        retunePending.clear();
        for (const pending of due) {
            // The widget may have been destroyed, or its element handed to
            // another table, in the frame we waited.
            if (!pending.container.isConnected) continue;
            if (tracked.get(pending.container) !== pending) continue;
            applyFit(pending);
        }
    });
}

/** Stop tracking a table (called from the widget's destroy). */
export function releaseTableFit(container: Element): void {
    const fit = tracked.get(container);
    if (!fit) return;
    observer.unobserve(fit.widthProbe);
    observer.unobserve(fit.fontProbe);
    tracked.delete(fit.container);
    tracked.delete(fit.widthProbe);
    tracked.delete(fit.fontProbe);
}

/**
 * Each column's width, as the browser currently lays the table out.
 *
 * Every cell in a column has the column's width, so one row answers for all of
 * them. Collapsed borders are shared between neighbours and so aren't fully
 * accounted for in the individual cell boxes — normalising against the table's
 * own width folds that back in and keeps the parts summing to the whole.
 */
function columnWidths(table: HTMLTableElement, row: HTMLTableRowElement, count: number): number[] {
    const widths: number[] = [];
    let sum = 0;
    for (let i = 0; i < count; i++) {
        const w = row.cells[i].getBoundingClientRect().width;
        widths.push(w);
        sum += w;
    }
    const total = table.getBoundingClientRect().width;
    if (sum > 0 && total > 0) {
        const k = total / sum;
        for (let i = 0; i < count; i++) widths[i] *= k;
    }
    // Asked for with slack, so a column handed this width actually holds what
    // was measured in it — see SLACK_PX.
    for (let i = 0; i < count; i++) widths[i] = widths[i] * SLACK_RATIO + SLACK_PX;
    return widths;
}

/**
 * Share `total` out max-min fairly: raise one common level until the widths
 * add up, where a column takes the level but never less than its floor
 * (min-content — below it a word would break) nor more than its cap (the width
 * at which it stops wrapping). So columns that want little get all of it, and
 * the greedy ones split what's left evenly.
 *
 * Returns null when even the floors don't fit — the caller's signal to ask for
 * less.
 */
function shareOut(total: number, floors: number[], caps: number[]): number[] | null {
    const n = floors.length;
    let floorSum = 0, capSum = 0;
    for (let i = 0; i < n; i++) { floorSum += floors[i]; capSum += caps[i]; }
    if (floorSum > total) return null;
    // Everyone can have everything: spread the leftover in proportion to what
    // each column holds, so the table still spans the full text width.
    if (capSum <= total) return capSum > 0 ? caps.map(c => c * (total / capSum)) : caps.slice();

    // floorSum <= total < capSum, and the sum is continuous and increasing in
    // the level, so bisection converges on the exact one.
    let lo = 0, hi = 0;
    for (const c of caps) if (c > hi) hi = c;
    for (let i = 0; i < 50; i++) {
        const mid = (lo + hi) / 2;
        let sum = 0;
        for (let j = 0; j < n; j++) sum += Math.min(Math.max(mid, floors[j]), caps[j]);
        if (sum < total) lo = mid; else hi = mid;
    }
    const level = (lo + hi) / 2;
    return floors.map((f, j) => Math.min(Math.max(level, f), caps[j]));
}

/** A floor array asking nothing of any column. */
const NO_FLOORS = (count: number): number[] => new Array(count).fill(0);

/** The smallest type scale a floor permits: the stricter of an absolute size
 *  and a fraction of the note's own, and never an enlargement. */
function floorFor(fontPx: number, minPx: number, minRatio: number): number {
    return Math.min(1, Math.max(minRatio, minPx / fontPx));
}

/** Re-measure one table and lay it out to fit the width it has been given. */
function applyFit(fit: TableFit): void {
    const { table, cols, container } = fit;
    const count = cols.length;
    const row = table.rows[0];
    if (!count || !row || row.cells.length < count) return;

    // Read the inputs BEFORE touching the table, so that what is measured
    // against is the table's resting state rather than one of the measuring
    // widths below.
    const avail = fit.widthProbe.getBoundingClientRect().width;
    const fontWidth = fit.fontProbe.getBoundingClientRect().width;
    const heightBefore = container.getBoundingClientRect().height;
    // A pane with no layout yet — or one that has been hidden — measures zero.
    // Keep whatever fit the table already has and wait to be shown.
    // Deliberately BEFORE the inputs are recorded below, so a zero measurement
    // can never be mistaken for a fit.
    if (!(avail > 0) || !(fontWidth > 0)) return;
    if (avail === fit.lastAvail && fontWidth === fit.lastFont) return;

    const fontPx = parseFloat(getComputedStyle(container).fontSize) || 16;
    const comfort = COMFORT_EM * fontPx;
    const comfortFloor = floorFor(fontPx, MIN_TABLE_FONT_PX, MIN_SCALE);
    const hardFloor = floorFor(fontPx, HARD_MIN_FONT_PX, HARD_MIN_SCALE);

    /**
     * What each column wants and needs AS THE TABLE IS CURRENTLY SIZED, using
     * the browser's own layout and nothing this module has decided.
     *
     * Everything the fitter writes is undone first — except the per-cell
     * `overflow-wrap: break-word` from a previous fit, and that one is load
     * bearing: `break-word` (unlike `anywhere`) contributes no soft-wrap
     * opportunity to min-content, so it cannot alter what is measured here.
     * Verified in Blink for a table cell — a 20-character word measures the
     * same under `normal` and `break-word`, and collapses to one character
     * under `anywhere`. Swap the last resort to `anywhere` and this stops
     * being true: `tight` would collapse for an already-broken column, the
     * shrink logic would read garbage, and the fit would depend on which
     * widths it had been through before.
     */
    const measure = () => {
        table.style.tableLayout = 'auto';
        for (const col of cols) col.style.width = '';
        table.style.width = 'max-content';
        const wide = columnWidths(table, row, count);
        table.style.width = 'min-content';
        const tight = columnWidths(table, row, count);
        table.style.width = '';           // back to the stylesheet's 100%
        return { wide, tight };
    };

    // ── how much to shrink ──
    // Shrinking the type is what creates room: the same column then holds more
    // characters, so what wrapped stops wrapping.
    //
    // The size is arrived at by MEASURING at it rather than by scaling the
    // note-size measurements down, because text width is NOT proportional to
    // font size — glyph advances round, and the error runs to several percent,
    // which is easily enough to wrap the very cell the shrink was protecting.
    // Each pass measures, asks how far off that leaves it, and moves. A table
    // that already fits stops after the first.
    let scale = 1;
    let wide: number[] = [];
    let tight: number[] = [];
    for (let pass = 0; ; pass++) {
        table.style.fontSize = scale < 1 ? `${scale.toFixed(4)}em` : '';
        ({ wide, tight } = measure());
        if (pass === MAX_FIT_PASSES) break;

        // Two totals, both capped per column at a comfortable column's width:
        // what the table would need to WRAP NOTHING, and what it needs to keep
        // whole words. The cap is what stops one outsized cell dictating the
        // size of the whole table — a column holding a paragraph is expected
        // to wrap, and a column holding a 300-character digest is going to
        // have that digest broken whatever anyone does, so neither is allowed
        // to drag every other column down with it.
        let wrapsNothing = 0;
        let wordsWhole = 0;
        for (let i = 0; i < count; i++) {
            wrapsNothing += Math.min(wide[i], comfort * scale);
            wordsWhole += Math.min(tight[i], comfort * scale);
        }

        let target = scale;
        if (wrapsNothing > avail) target = Math.max(comfortFloor, scale * avail / wrapsNothing);
        // Comfort is one thing; keeping words whole is another, and worth
        // shrinking past the comfort floor for.
        if (wordsWhole > avail) target = Math.min(target, Math.max(hardFloor, scale * avail / wordsWhole));

        // Settled, or pinned against a floor.
        if (target >= scale - FIT_EPSILON) break;
        scale = target;
    }

    // ── hand out the room ──
    // In rendered pixels, and applied as PERCENTAGES so the proportions hold
    // through a sub-pixel container change without re-measuring. The floors are
    // capped for the same reason the totals above were: a column is owed the
    // room its words need, but not room for a run no column could ever hold.
    const floors = tight.map(t => Math.min(t, comfort * scale));
    // Not even the floors fit. Share THOSE out max-min fairly instead of
    // abandoning them: a column with a modest longest word still gets it
    // whole, and only the columns whose longest run is genuinely outsized come
    // up short — those, and only those, break below. Zero floors can always be
    // met (avail > 0 is guaranteed above), so this second call never declines.
    const widths = shareOut(avail, floors, wide)
        ?? shareOut(avail, NO_FLOORS(count), floors)!;

    let sum = 0;
    for (const w of widths) sum += w;
    const pcts = widths.map(w => `${(w / (sum || 1) * 100).toFixed(4)}%`);
    const fontSize = scale < 1 ? `${scale.toFixed(4)}em` : '';
    table.style.tableLayout = 'fixed';
    for (let i = 0; i < count; i++) cols[i].style.width = pcts[i];
    table.style.fontSize = fontSize;

    // ── the last resort, column by column ──
    // A column whose longest unbreakable run is wider than the room it ended up
    // with would otherwise spill its text across its neighbour, so that run
    // breaks. It is the least bad of the three ways out — the others being type
    // nobody can read, and a table whose right-hand columns sit past the edge
    // of the note (macOS draws no scrollbar until you are already scrolling, so
    // that just reads as data missing) — and the rule it bends is about WORDS:
    // what actually lands here is a digest or a URL. Only the offending columns
    // break; every other column on the row keeps its words whole. <col> can't
    // carry overflow-wrap, so it has to go on the cells.
    let key = '';
    const breaks = tight.map((t, i) => {
        const broken = t > widths[i] + 0.5;
        if (broken) key += `${i},`;
        return broken;
    });
    if (key !== fit.lastBreaks) {
        fit.lastBreaks = key;
        for (const r of table.rows) {
            for (let i = 0; i < count; i++) {
                if (r.cells[i]) r.cells[i].style.overflowWrap = breaks[i] ? 'break-word' : '';
            }
        }
    }

    // Recorded only once the fit has actually been applied. If anything above
    // throws, the record still reads as unfitted and the next notification
    // retries, rather than the guard above wedging this table forever.
    fit.lastAvail = avail;
    fit.lastFont = fontWidth;
    const firstFitOfThisWidget = !fit.fitted;
    fit.fitted = true;

    // Remember it, so the next time this table is built it arrives at this size
    // rather than being laid out large and corrected — see AppliedFit.
    if (lastFit.size >= FIT_CACHE_MAX) {
        const oldest = lastFit.keys().next().value;
        if (oldest !== undefined) lastFit.delete(oldest);
    }
    lastFit.delete(fit.key);          // re-insert, so this is the newest entry
    lastFit.set(fit.key, {
        avail, font: fontWidth, widths: pcts, breaks, fontSize, at: editorMetrics(fit.view),
    });

    /* ── Announce a height change, or the caret is left behind by it ──
       CodeMirror measured this line in the animation frame BEFORE this
       callback — resize observations are delivered after rAF — so a fit that
       changes the table's height leaves its height map, and the caret the
       selection layer has already drawn from it, describing the taller table
       on the way in. Nothing puts that right on its own: CM re-reads line
       heights only when its own content box changes, and on a document shorter
       than the viewport that never happens. The symptom was a caret stranded a
       few hundred pixels below the click that placed it, snapping back only
       once a keystroke moved it.

       restoreFit is what avoids this in the ordinary case, by making a
       re-created table's first layout its final one. This is for the case it
       can't cover — the first fit of a table at a width it has never been
       fitted at — where the height genuinely does change under CM. Re-stating
       the selection is the one public lever that reaches the selection layer
       (it re-measures on `selectionSet`); requestMeasure alone only refreshes
       the height map, and only when the content box moved.

       Deliberately restricted to a widget's FIRST fit. Later ones are resizes,
       where the editor's own geometry changed too, so CM re-measures anyway —
       and a transaction per frame of a resize drag is not worth paying. */
    if (Math.abs(container.getBoundingClientRect().height - heightBefore) > 0.5) {
        fit.view.requestMeasure();
        if (firstFitOfThisWidget) fit.view.dispatch({ selection: fit.view.state.selection });
    }
}

/** The hidden sensors a fitted table carries; see TableFit. */
export function createFitProbes(): { probe: HTMLElement; fontProbe: HTMLElement } {
    const probe = document.createElement('div');
    probe.className = 'cm-table-probe';
    probe.setAttribute('aria-hidden', 'true');

    const fontProbe = document.createElement('span');
    fontProbe.textContent = FONT_PROBE_TEXT;
    probe.appendChild(fontProbe);

    return { probe, fontProbe };
}
