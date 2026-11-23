import type { ToolChoice } from './ToolStrip';

export type ToolLabel =
    | 'select' | 'hand' | 'draw' | 'eraser' | 'arrow' | 'text' | 'note' | 'media'
    | 'rectangle' | 'ellipse' | 'triangle' | 'diamond' | 'hexagon' | 'oval' | 'rhombus'
    | 'star' | 'cloud' | 'heart' | 'xBox' | 'checkBox' | 'arrowLeft' | 'arrowUp'
    | 'arrowDown' | 'arrowRight' | 'line' | 'highlight' | 'laser' | 'frame';

/** A label with its chord after an em dash ("Draw — D"); the chord is already platform-formatted. */
export function chordLabel(label: string, shortcut: string | undefined): string {
    return shortcut ? `${label} — ${shortcut}` : label;
}

/** Every figure, in the order the more-tools popover lists them. The bar's figure slot shows one of them. */
const figures: readonly [ToolLabel, string][] = [
    ['rectangle', 'rectangle'], ['ellipse', 'ellipse'], ['triangle', 'triangle'],
    ['diamond', 'diamond'], ['hexagon', 'hexagon'], ['oval', 'oval'], ['rhombus', 'rhombus'],
    ['star', 'star'], ['cloud', 'cloud'], ['heart', 'heart'], ['xBox', 'x-box'],
    ['checkBox', 'check-box'], ['arrowLeft', 'arrow-left'], ['arrowUp', 'arrow-up'],
    ['arrowDown', 'arrow-down'], ['arrowRight', 'arrow-right'],
];

export interface ToolChoices {
    /** The bar's nine tools, in order; the chevron that opens `more` follows them. */
    readonly primary: readonly ToolChoice[];
    /** Every tool not on the bar: each other figure, line, highlighter, laser and frame. */
    readonly more: readonly ToolChoice[];
}

/** Labels and chords come from the same locale and keymap as the rest of the board chrome. `lastFigure` is the figure
 *  the figure tool last drew (rectangle until one is chosen): the bar's figure slot shows it, and picking another
 *  figure from More tools moves that figure into the slot, so the slot always shows the figure in use. */
export function toolChoices(
    label: (key: ToolLabel) => string,
    shortcut: (id: string, figure?: string) => string | undefined,
    lastFigure?: string,
): ToolChoices {
    const choice = (key: ToolLabel, id: string, figure?: string): ToolChoice => ({
        id, figure, label: label(key), shortcut: shortcut(id, figure),
    });
    const figureChoices = figures.map(([key, figure]) => choice(key, 'figure', figure));
    const slotFigure = figures.some(([, figure]) => figure === lastFigure) ? lastFigure : 'rectangle';
    const slot = figureChoices.find(item => item.figure === slotFigure) ?? figureChoices[0];
    return {
        primary: [
            choice('select', 'select'), choice('hand', 'hand'), choice('draw', 'pen'),
            choice('eraser', 'eraser'), choice('arrow', 'connector'), choice('text', 'text'),
            choice('note', 'sticky'), choice('media', 'media'), slot,
        ],
        more: [
            ...figureChoices.filter(item => item !== slot), choice('line', 'polyline'), choice('highlight', 'highlighter'),
            choice('laser', 'laser'), choice('frame', 'frame'),
        ],
    };
}
