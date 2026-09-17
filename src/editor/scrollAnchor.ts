import { EditorView, ViewPlugin } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import { EditorState, StateEffect } from '@codemirror/state';
import type { ChangeDesc, Extension, SelectionRange } from '@codemirror/state';
import { forceParsing } from '@codemirror/language';

/* ── Where a note was being read, as a place in the TEXT ──────────────────
   A note's place used to be its raw `scrollTop`, and that number changes
   meaning between leaving and coming back. A view only MEASURES the lines it
   has drawn; every other line is an estimate (default line height × the rows
   its length would wrap to), blind to the tables, `$$` maths, images and code
   panels the live preview draws. Reading down a note measures everything above
   the reader, while every return builds a fresh view that has measured nothing:
   the text above line 4,606 of a 9,170-line note measured 154,032px after
   scrolling through it and 116,331px in a fresh view, so the saved offset
   reopened ~1,450 lines further down — at 95% it was past the estimated end and
   clamped to the last line. Stored as the line block at the top edge and how
   far into it, the place means the same thing in any layout.

   Restoring it once is not enough either. The Markdown parse runs in the
   background, so tables, maths, images and collapsed sections around a deep
   place are drawn AFTER the first frame and move it again; so a returning view
   HOLDS the anchor — re-pinning it whenever heights, geometry or the viewport
   change — until the reader takes over. CodeMirror's own restore can do
   neither: `scrollSnapshot()` is exact, but its ScrollTarget cannot be built
   from stored data through the public API, and a plain
   `scrollIntoView(pos, { y: 'start' })` aligns the glyph rather than the block,
   also scrolls ancestors, and both are one-shot. */

export interface ScrollAnchor {
    /** `from` of the line block at the scroller's top edge. */
    pos: number;
    /** px from that block's top down to the top edge. Negative only on the
     *  first line, whose top padding sits above it: a note left at its very top
     *  must come back at scrollTop 0, not with its padding scrolled away. */
    offset: number;
}

/** Shape guard for a stored anchor — localStorage is user-editable. */
export function isScrollAnchor(value: unknown): value is ScrollAnchor {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const { pos, offset } = value as Record<string, unknown>;
    return Number.isSafeInteger(pos) && (pos as number) >= 0 && Number.isFinite(offset);
}

/**
 * The document height at the scroller's top edge. Not `scrollTop`: the content
 * carries 24px of top padding (cmTheme.ts), so a scrollTop and a block's `top`
 * are on offset scales. Capture and restore both convert through here, which
 * is what makes the round trip exact.
 */
function topEdgeHeight(view: EditorView): number {
    return view.scrollDOM.getBoundingClientRect().top - view.documentTop;
}

/**
 * The document height the top edge belongs at. A `pos` past the end (the note
 * shrank on disk) clamps to it. When `pos` no longer starts its block, the
 * remembered line now sits INSIDE a bigger one — a section collapsed since, or
 * a table or `$$` block Reading mode draws where Edit mode had lines — and the
 * block's own top is the place: its heading lands at the top edge, and nothing
 * is expanded to reach the line.
 */
function anchorHeight(view: EditorView, anchor: ScrollAnchor): number {
    const pos = Math.min(anchor.pos, view.state.doc.length);
    const block = view.lineBlockAt(pos);
    if (block.from !== pos) return block.top;
    const floor = block.from === 0 ? -view.documentPadding.top : 0;
    // A block drawn shorter than it was keeps the place inside itself.
    return block.top + Math.max(floor, Math.min(anchor.offset, Math.max(0, block.height - 1)));
}

/** Move by `delta`, ignoring sub-pixel noise. Also what ends every re-pin: a
 *  write that changes nothing (a place past the bottom, clamped) raises no
 *  scroll event and no update, so nothing asks again. */
function nudge(view: EditorView, delta: number): void {
    if (Math.abs(delta) > 1) view.scrollDOM.scrollTop += delta;
}

/** @codemirror/view's `MeasureRequest<T>`, which it declares but does not export. */
interface MeasureRequest<T> {
    key: unknown;
    read(view: EditorView): T;
    write(value: T, view: EditorView): void;
}

/**
 * Capture the place at the top edge of `view` inside CodeMirror's next
 * measure, and hand it to `save` — for the scroll handler, never per
 * keystroke. Not read synchronously: a layout query from the handler runs any
 * pending measure first, and CodeMirror measures again right after its scroll
 * handlers anyway (`onScrollChanged`), so a synchronous capture cost a second
 * measure per scroll event (1,510 measure passes against 930 over the same
 * wheel scroll through a 9,069-line note). As a measure request it rides the
 * pass that runs anyway, reading heights that pass has just measured.
 * Requests sharing `key` replace one another, so a burst captures once.
 */
export function captureScrollAnchor(view: EditorView, key: string, save: (anchor: ScrollAnchor) => void): void {
    const request: MeasureRequest<ScrollAnchor> = {
        key,
        read: (v) => {
            const edge = topEdgeHeight(v);
            const block = v.lineBlockAtHeight(edge);
            return { pos: block.from, offset: edge - block.top };
        },
        write: (anchor) => save(anchor),
    };
    view.requestMeasure(request);
}

/** Carry an anchor through an edit. Returns the SAME object when its position
 *  did not move, so a caller can skip a write per keystroke. `-1`: text
 *  inserted exactly at the anchored block's start lands below the anchor. */
export function mapScrollAnchor(anchor: ScrollAnchor, changes: ChangeDesc): ScrollAnchor {
    // A stored anchor may lie past a note shortened on disk; mapPos throws on it.
    const pos = changes.mapPos(Math.min(anchor.pos, changes.length), -1);
    return pos === anchor.pos ? anchor : { pos, offset: anchor.offset };
}

/**
 * Reader input: whatever it does next is the reader's, so the hold lets go. On
 * `view.dom`, not `contentDOM`: the ⌘F panel sits outside the scroller, a wheel
 * over the side margins misses the content, and a scrollbar drag lands on
 * `scrollDOM`. Capture phase, because tableEdit's cell keydown listener stops
 * what it handles. `dragover` because a drag held near the scroller's edge
 * autoscrolls it with no pointer event reaching the editor. Deliberately NOT
 * here: a window or divider resize, or ⌘E from outside the editor — the
 * re-pin keeps the top line (or the match) through those. A ⌘F Enter is a
 * keydown too: it releases the previous jump in the capture phase, before the
 * command dispatches the next one.
 */
const READER_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown', 'dragover', 'drop'] as const;

/* ── Holding a search match at the centre ────────────────────────────────
   A jump to a match (vault search, ⌘F) used to be one centring scroll, made
   with the heights CodeMirror knew at that moment. What is drawn after it
   moves the match, because CodeMirror's measure keeps the TOP line still, not
   the match: twelve mermaid diagrams above a match swapped their placeholders
   for SVGs ~230ms after the click and left it 733px below centre, pictures
   left ⌘F's match 1,445px below it, and a note opened by the jump (parsed
   only to ~3,000 characters) redrew its headings, code panels and collapsed
   sections under the match and settled 61px (collapsed: 256px) off. So a jump
   is the same hold as a restore, with a different target: the match's line
   kept at the middle of the scroller until the reader takes over. */

/** A restored place kept at the top edge, or a revealed match kept centred. */
type HoldTarget =
    | { kind: 'top'; anchor: ScrollAnchor }
    | {
        kind: 'centre';
        pos: number;
        /** px from the top of `pos`'s line block down to the height that belongs
         *  at the scroller's middle, as last measured; null until then. */
        inBlock: number | null;
    };

/**
 * Jump to a match and keep it centred. Dispatched with the selection; the
 * transaction extender below adds the scroll itself, so the vault-search
 * reveal and ⌘F (`search({ scrollToMatch: revealMatchEffect })`) take one path.
 */
export const revealMatch = StateEffect.define<{ from: number; to: number }>({
    map: (value, mapping) => ({ from: mapping.mapPos(value.from), to: mapping.mapPos(value.to) }),
});

const isReveal = (e: StateEffect<unknown>): e is StateEffect<{ from: number; to: number }> => e.is(revealMatch);

/** `@codemirror/search`'s `scrollToMatch`. Module-level: it is baked into every
 *  EditorState, which outlives the pane that built it (AGENTS.md). */
export const revealMatchEffect = (range: SelectionRange): StateEffect<unknown> =>
    revealMatch.of({ from: range.from, to: range.to });

const revealScroll = EditorState.transactionExtender.of((tr) => {
    const effects = tr.effects
        .filter(isReveal)
        .map((e) => EditorView.scrollIntoView(e.value.from, { y: 'center' }));
    return effects.length > 0 ? { effects } : null;
});

/**
 * The document height that belongs at the scroller's middle for a centre hold.
 * Only a MEASURING caller (a measure request's read) may ask the DOM where the
 * match's glyph is — `coordsAtPos` outside that phase forces a layout per
 * update; everyone else reuses the offset into its line block that the last
 * read found, which survives the block moving. A match drawn taller than the
 * scroller (inside a widget) puts its top at the top edge instead, as
 * CodeMirror's own centring does.
 */
function centreHeight(view: EditorView, target: Extract<HoldTarget, { kind: 'centre' }>, measuring: boolean): number {
    const pos = Math.min(target.pos, view.state.doc.length);
    const block = view.lineBlockAt(pos);
    if (measuring) {
        const rect = view.coordsAtPos(pos, 1);
        if (rect) {
            const half = view.scrollDOM.clientHeight / 2;
            const top = rect.top - view.documentTop;
            const mid = rect.bottom - rect.top > half * 2 ? top + half : (top + rect.bottom - view.documentTop) / 2;
            target.inBlock = mid - block.top;
        }
    }
    return block.top + (target.inBlock ?? Math.min(block.height, view.defaultLineHeight) / 2);
}

/** How far the scroller must move to put the target where it belongs. Neither
 *  kind runs a pending measure unless `measuring` (see centreHeight), so this
 *  is legal from an update listener. */
function distanceToTarget(view: EditorView, target: HoldTarget, measuring: boolean): number {
    const edge = topEdgeHeight(view);
    if (target.kind === 'top') return anchorHeight(view, target.anchor) - edge;
    return centreHeight(view, target, measuring) - view.scrollDOM.clientHeight / 2 - edge;
}

class ScrollAnchorHold {
    private held: HoldTarget | null = null;
    private readonly view: EditorView;
    private readonly release = (): void => { this.target = null; };
    /**
     * CodeMirror hears a widget's growth only at its next measure, and its DOM
     * observer ignores mutations inside widgets; a widget that forgets to ask
     * (a font swap, a picture decoded late) would leave the hold deaf. The
     * content's own box changes on every such growth, so while anything is
     * held, that asks for the measure the pin rides.
     */
    private readonly resize = typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => this.view.requestMeasure());

    private readonly pin: MeasureRequest<number> = {
        key: this,
        read: (view) => (this.held ? distanceToTarget(view, this.held, true) : 0),
        write: (delta, view) => { if (this.held) nudge(view, delta); },
    };

    constructor(view: EditorView) {
        this.view = view;
        for (const type of READER_INPUT) {
            view.dom.addEventListener(type, this.release, { capture: true, passive: true });
        }
    }

    get target(): HoldTarget | null {
        return this.held;
    }

    set target(target: HoldTarget | null) {
        if ((this.held == null) !== (target == null)) {
            if (target) this.resize?.observe(this.view.contentDOM);
            else this.resize?.disconnect();
        }
        this.held = target;
    }

    /**
     * Put the view at `anchor` and keep it there. The first move is made
     * synchronously, so CodeMirror's first measure draws the lines around the
     * place rather than the note's top and no frame is painted at the top
     * first. It is made on the fresh view's UNMEASURED layout — default line
     * height, no padding yet — and that is enough: the first measure takes the
     * block at the new scrollTop as its own scroll anchor and keeps it at the
     * edge while it swaps those estimates for real ones (index.js :8016-8022,
     * :8081-8092), which carries the move onto measured heights; the pin and
     * `settle` correct what is left. Measuring first would lay out and draw the
     * note's top only to throw it away.
     */
    hold(anchor: ScrollAnchor): void {
        const target: HoldTarget = { kind: 'top', anchor };
        const delta = distanceToTarget(this.view, target, false);
        this.target = target;
        nudge(this.view, delta);
        this.view.requestMeasure(this.pin);
    }

    update(update: ViewUpdate): void {
        for (const tr of update.transactions) {
            if (this.held && tr.docChanged) {
                this.target = this.held.kind === 'top'
                    ? { kind: 'top', anchor: mapScrollAnchor(this.held.anchor, tr.changes) }
                    : { ...this.held, pos: tr.changes.mapPos(this.held.pos, 1) };
            }
            // A new jump replaces whatever was held — a restore still settling
            // included; its scroll is the extender's effect, not the flag below.
            const reveal = tr.effects.find(isReveal);
            if (reveal) {
                this.target = { kind: 'centre', pos: reveal.value.from, inBlock: null };
                this.view.requestMeasure(this.pin);
                continue;
            }
            // Paste, list and LaTeX commands scroll to the caret on purpose. Only
            // the `scrollIntoView: true` flag is visible here: a jump dispatched
            // as a bare `EditorView.scrollIntoView` EFFECT is not, and the re-pin
            // would drag it back unless reader input released the hold first (a
            // heading-fold click) — a jump from outside the editor must be a
            // revealMatch.
            if (tr.scrollIntoView) this.target = null;
        }
        if (!this.held) return;
        if (update.docChanged || update.heightChanged || update.geometryChanged || update.viewportChanged) {
            this.view.requestMeasure(this.pin);
        }
    }

    /**
     * The same correction once CodeMirror's measure loop has FINISHED — the pin
     * alone is not enough. That loop keeps its own scroll anchor (the block 8px
     * under the scrollTop it read when the loop began) and, when that block has
     * moved, rewrites scrollTop from that starting value (@codemirror/view
     * 6.39.15, index.js :8087-8092): whenever the top-edge block is not
     * CodeMirror's block and was itself just re-measured, that undoes the pin's
     * write in the same loop, and nothing asks again. Measure-driven updates
     * only (no transactions), because this reads layout — a dispatch re-pins
     * through `update` instead.
     *
     * Both halves are needed, measured on every frame of returns to 50% and 95%
     * of a 9,069-line note: the pin alone painted 13–43 of ~545 frames away from
     * the saved place (one showing line 8,234 for 8,619); correcting ONLY here,
     * after the loop, flipped the top line 4,532 ↔ 4,536 on consecutive frames
     * and once landed 125 lines off; pin + settle painted none off, bar the
     * blank frames CodeMirror paints when its loop gives up ("Measure loop
     * restarted more than 5 times"), which the unmodified app painted too.
     */
    settle(update: ViewUpdate): void {
        if (!this.held || update.transactions.length > 0) return;
        if (update.heightChanged || update.geometryChanged || update.viewportChanged) {
            nudge(this.view, distanceToTarget(this.view, this.held, false));
        }
    }

    destroy(): void {
        this.target = null;
        for (const type of READER_INPUT) {
            this.view.dom.removeEventListener(type, this.release, { capture: true });
        }
    }
}

const scrollAnchorPlugin = ViewPlugin.fromClass(ScrollAnchorHold, {
    provide: (plugin) => EditorView.updateListener.of((update) => update.view.plugin(plugin)?.settle(update)),
});

/**
 * Per-view hold of a restored scroll place or a revealed match, plus the
 * scroll a `revealMatch` asks for. A module singleton with no config, like
 * headingFoldField, and to be added OUTSIDE every compartment: a reconfigure
 * (⌘E, the theme) must not drop a hold in progress.
 */
export const scrollAnchorTracking: Extension = [scrollAnchorPlugin, revealScroll];

/** Restore `anchor` in `view` and hold it until the reader takes over. */
export function holdScrollAnchor(view: EditorView, anchor: ScrollAnchor): void {
    view.plugin(scrollAnchorPlugin)?.hold(anchor);
}

/** True while `view` is still holding a RESTORED place: the scroll events it
 *  raises are the restore's, not the reader's, and must not be remembered. Not
 *  a held match — that is where the reader now is, and pausing the save would
 *  lose the jump's landing place on the next tab switch. */
export function isHoldingScrollAnchor(view: EditorView): boolean {
    return view.plugin(scrollAnchorPlugin)?.target?.kind === 'top';
}

/** Characters past the match's line to parse before a reveal: live preview and
 *  collapsed sections draw from the tree, and a note the jump just opened is
 *  parsed only to its first ~3,000 characters — what sits just below the match
 *  shares the screen with it. */
const REVEAL_PARSE_MARGIN = 3000;
/** ms a reveal may block on that parse — lists.ts' PARSE_TIMEOUT. Whatever is
 *  left parses in the background and the centre hold absorbs it. */
const REVEAL_PARSE_BUDGET = 100;

/** Parse up to just past `to` before a reveal dispatches, so its first centring
 *  lands on real heights instead of raw markdown. Never from inside an update. */
export function parseForReveal(view: EditorView, to: number): void {
    const { doc } = view.state;
    forceParsing(view, Math.min(doc.length, doc.lineAt(Math.min(to, doc.length)).to + REVEAL_PARSE_MARGIN), REVEAL_PARSE_BUDGET);
}

// A hot swap would mint a second plugin while every cached EditorState still
// holds the first, so `view.plugin()` would silently return null and every
// return would stop restoring. Force a full reload in dev instead, as
// headingFold.ts does (`import.meta.hot` is undefined in production).
if (import.meta.hot) {
    // `decline()` is no longer in Vite's ViteHotContext type but is still a
    // runtime no-op method; the cast is type-only.
    (import.meta.hot as unknown as { decline(): void }).decline();
}
