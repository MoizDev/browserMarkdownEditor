import { TextBoundaries, type BoundaryDirection } from './boundaries';
import { projectionLength } from './projection';
import { normalizeTextSelection } from './rangeMap';
import { insertionFragment } from './richOperations';
import { spliceRichText, type RichText } from './richText';
import type { RichEdit, RichSelection } from './rich';
import type { PlainTextOptions } from './plainText';

export type LogicalMotion = 'grapheme' | 'word' | 'document';

/**
 * View-independent logical movement and deletion. Visual bidi movement still
 * belongs to the layout's caret index; this class never guesses screen direction.
 */
export class RichSelectionOperations {
    private readonly boundaries = new TextBoundaries();

    normalize(text: RichText, selection: RichSelection, direction: BoundaryDirection = 1): RichSelection {
        return normalizeTextSelection(text, selection, direction < 0 ? 'before' : 'after');
    }

    word(text: RichText, offset: number): RichSelection { return this.boundaries.selectWord(text, offset); }
    block(text: RichText, offset: number): RichSelection { return this.boundaries.selectBlock(text, offset); }
    all(text: RichText): RichSelection { return { anchor: 0, focus: projectionLength(text) }; }
    primeWords(text: RichText, options: PlainTextOptions): Promise<void> { return this.boundaries.primeWords(text, options); }

    move(text: RichText, selection: RichSelection, direction: BoundaryDirection, unit: LogicalMotion, extend = false): RichSelection {
        const current = this.normalize(text, selection, direction);
        if (!extend && current.anchor !== current.focus) {
            const edge = direction < 0 ? Math.min(current.anchor, current.focus) : Math.max(current.anchor, current.focus);
            return { anchor: edge, focus: edge };
        }
        let focus: number;
        if (unit === 'document') focus = direction < 0 ? 0 : projectionLength(text);
        else if (unit === 'word') focus = this.boundaries.word(text, current.focus, direction);
        else focus = this.boundaries.adjacent(text, current.focus, direction);
        return extend ? { anchor: current.anchor, focus } : { anchor: focus, focus };
    }

    /** Null means the requested deletion is already at the document boundary. */
    delete(text: RichText, selection: RichSelection, direction: BoundaryDirection,
        unit: 'grapheme' | 'word' = 'grapheme'): RichEdit | null {
        const current = this.normalize(text, selection, direction);
        let from = Math.min(current.anchor, current.focus), to = Math.max(current.anchor, current.focus);
        if (from === to) {
            const target = unit === 'word' ? this.boundaries.word(text, from, direction) : this.boundaries.adjacent(text, from, direction);
            from = Math.min(from, target); to = Math.max(to, target);
        }
        if (from === to) return null;
        const insert = insertionFragment(text, from, '', null);
        // Deleting between clusters can make their remaining code points join;
        // place the caret on a real stop in the resulting text, not inside it.
        const result = spliceRichText(text, from, to, insert);
        const caret = this.boundaries.snap(result.text, from, direction < 0 ? 1 : -1);
        return { from, to, insert, selection: { anchor: caret, focus: caret } };
    }

    clear(): void { this.boundaries.clear(); }
}
