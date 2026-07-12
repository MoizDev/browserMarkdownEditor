// A transient "you are here" highlight for search-result navigation. Unlike
// the selection, a decoration stays visible in read mode (where the view may
// refuse focus and the selection layer can be invisible), so jumping to a
// match always shows WHERE it landed. EditorPane dispatches the set effect on
// reveal and clears it shortly after (and on tab swaps).

import { StateField, StateEffect } from '@codemirror/state';
import { EditorView, Decoration } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';

/** Set (or, with null, clear) the highlighted range. */
export const setRevealHighlight = StateEffect.define<{ from: number; to: number } | null>({
    map: (value, mapping) => value && {
        from: mapping.mapPos(value.from),
        to: mapping.mapPos(value.to),
    },
});

const revealMark = Decoration.mark({ class: 'cm-reveal-highlight' });

export const revealHighlightField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(highlight, tr) {
        // Any user interaction (typing, clicking a new cursor spot) dismisses
        // the flash — which also covers mapping through doc changes; an
        // explicit set effect in the same transaction wins below.
        if (tr.docChanged || tr.selection) highlight = Decoration.none;
        for (const effect of tr.effects) {
            if (effect.is(setRevealHighlight)) {
                highlight = effect.value && effect.value.to > effect.value.from
                    ? Decoration.set([revealMark.range(effect.value.from, effect.value.to)])
                    : Decoration.none;
            }
        }
        return highlight;
    },
    provide: (field) => EditorView.decorations.from(field),
});
