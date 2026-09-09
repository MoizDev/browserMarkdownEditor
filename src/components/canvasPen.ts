// The pen behaviour that goes with CanvasStylePanel, and the one `components`
// object all three canvases hand to <Tldraw>.
//
// SEPARATE FROM THE PANEL because the panel is a component and this is not:
// `react-refresh/only-export-components` is relaxed for `src/context/**` alone,
// so a file that exports both loses fast refresh and fails lint. Keeping the
// wiring here also means the three canvases share ONE config object rather than
// three copies that could drift.

import type { Editor, TLShape } from 'tldraw';
import { DefaultDashStyle, DefaultSizeStyle } from 'tldraw';
import { getPenScale } from '../utils/penStyle';
import CanvasStylePanel from './CanvasStylePanel';

/** What every canvas in the app passes to <Tldraw components={...}>. */
export const CANVAS_COMPONENTS = { StylePanel: CanvasStylePanel };

/**
 * Make the pen behave the way the panel promises.
 *
 * Two halves, and both are needed. The styles pin what the panel no longer
 * exposes. The create handler stamps the width, because thickness here is
 * `props.scale` and scale is an ordinary prop rather than a StyleProp — so
 * `stylesForNextShape`, which is the mechanism tldraw gives for "apply this to
 * the next shape", cannot carry it.
 *
 * Returns a disposer for the handler.
 */
export function applyPenDefaults(editor: Editor): () => void {
    // Only the width is ours to decide; a file that already stored a colour
    // keeps it, which is why this does not touch DefaultColorStyle.
    editor.run(() => {
        editor.setStyleForNextShapes(DefaultDashStyle, 'solid');
        editor.setStyleForNextShapes(DefaultSizeStyle, 's');
    }, { history: 'ignore' });

    return editor.sideEffects.registerBeforeCreateHandler('shape', shape => {
        // `scale` is on the drawing shapes and absent from notes, bookmarks and
        // embeds — write it only where it means stroke width. The cast is the
        // same TLShape-is-a-union story as in the panel below: spreading props
        // widens them past the discriminant, and the guard above is what makes
        // the write sound.
        if (!('scale' in shape.props)) return shape;
        return { ...shape, props: { ...shape.props, scale: getPenScale() } } as TLShape;
    });
}
