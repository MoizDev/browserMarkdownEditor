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
import { getPenScale, seedPenScale } from '../utils/penStyle';
import CanvasStylePanel from './CanvasStylePanel';
import { TightDrawShapeUtil } from './tightDrawShape';
import PenDevPanel from './PenDevPanel';

/**
 * What a canvas file remembers about how you were drawing in it.
 *
 * tldraw's own snapshots carry NONE of this: a document snapshot holds shapes
 * and a session snapshot holds the camera and selection (TLSessionStateSnapshot
 * is the whole list — no styles). So a file that did not save this block
 * reopened with the default colour and width however it was left, which is what
 * "each file remembers its own pen" is about.
 *
 * Written into every canvas file's `ui` key: `.tldraw`, `.notebook`, and the
 * snapshot embedded in an annotated PDF.
 */
export interface CanvasUiState {
    toolId?: string;
    /** tldraw's own style memory — colour, and anything else it tracks. */
    stylesForNextShape?: Record<string, unknown>;
    /** Pen width. Not a tldraw style (it is `props.scale`), so it is kept here
     *  rather than inside stylesForNextShape. See utils/penStyle.ts. */
    penScale?: number;
}

/** What to write into the file. */
export function readCanvasUi(editor: Editor): CanvasUiState {
    return {
        toolId: editor.getCurrentToolId(),
        stylesForNextShape: editor.getInstanceState().stylesForNextShape,
        penScale: getPenScale(editor),
    };
}

/**
 * Put a file's remembered pen back.
 *
 * MUST run before the save listeners attach: these writes are indistinguishable
 * from user edits, and restoring what a file already says must not mark it
 * dirty and rewrite it.
 */
export function applyCanvasUi(editor: Editor, ui: CanvasUiState | undefined): void {
    seedPenScale(editor, ui?.penScale);
    if (!ui) return;
    try {
        if (ui.stylesForNextShape) editor.updateInstanceState({ stylesForNextShape: ui.stylesForNextShape });
        if (ui.toolId) editor.setCurrentTool(ui.toolId);
    } catch (err) {
        // A tool or style saved by a newer build than this one — the defaults
        // are a fine fallback, and the drawing itself is untouched.
        console.warn('Could not restore this canvas\'s tools:', err);
    }
}

/**
 * What every canvas in the app passes to <Tldraw components={...}>.
 *
 * The pen tuning panel rides along in development only. `import.meta.env.DEV`
 * is a build-time literal, so in production the key is `undefined`, the import
 * is unreferenced, and the panel is dropped from the bundle rather than shipped
 * and hidden.
 */
export const CANVAS_COMPONENTS = {
    StylePanel: CanvasStylePanel,
    InFrontOfTheCanvas: import.meta.env.DEV ? PenDevPanel : undefined,
};

/** Ditto for <Tldraw shapeUtils={...}>. tldraw merges these over its own by
 *  `type`, and this one is still `type: 'draw'`, so it substitutes rather than
 *  adds — see tightDrawShape.tsx for what it changes and why. */
export const CANVAS_SHAPE_UTILS = [TightDrawShapeUtil];

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
    //
    // Dash stays 'solid': it is what keeps stroke width even, which is the whole
    // point of the width slider. tldraw only consults `isPen` when dash is
    // 'draw', so a stylus here never reaches realPressureSettings — but that
    // branch buys only 0.74px of the 7.79px the ink trails (MEASURED on the
    // smoothed centreline), and costs pressure-varying width. The trailing is
    // `streamline`, and utils/tightDrawShape.tsx is where that is fixed.
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
        return { ...shape, props: { ...shape.props, scale: getPenScale(editor) } } as TLShape;
    });
}
