import { StateField, StateEffect } from '@codemirror/state';
import { EditorView, Decoration } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';

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
