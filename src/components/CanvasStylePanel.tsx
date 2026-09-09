import { useCallback, useSyncExternalStore } from 'react';
import { DefaultColorStyle, useEditor, useValue } from 'tldraw';
import type { Editor, TLDefaultColorStyle, TLShapePartial } from 'tldraw';
import {
    DEFAULT_PEN_SCALE, getPenScale, penScaleToSlider, setPenScale,
    sliderToPenScale, subscribePenScale,
} from '../utils/penStyle';

/**
 * The panel that replaces tldraw's own, in every canvas the app has.
 *
 * tldraw's offers four discrete widths, four dash styles and four fill styles.
 * On ruled paper the four widths are the whole problem: the thinnest, `s`, is
 * 3px of ink, which is a marker rather than a pen. This trades all twelve
 * buttons for one continuous width slider — which reaches far below `s` — and
 * keeps the colours, which were the only part of the original being used.
 *
 * Dash and fill are not dropped so much as fixed: `applyPenDefaults` pins them
 * to solid, which is what every one of those buttons was being set to anyway.
 * A shape that already carries another dash keeps it; this only decides what
 * the NEXT shape gets.
 */

/** tldraw's palette, in its own order, minus `white` — invisible on paper and
 *  on a PDF page, and this app's canvases are all white-paged. */
const COLORS: TLDefaultColorStyle[] = [
    'black', 'grey', 'light-violet', 'violet',
    'blue', 'light-blue', 'yellow', 'orange',
    'green', 'light-green', 'light-red', 'red',
];

/** Reads live so the swatch highlight follows a selection, not just a click. */
function useCurrentColor(editor: Editor): TLDefaultColorStyle {
    return useValue(
        'pen color',
        () => editor.getStyleForNextShape(DefaultColorStyle) ?? 'black',
        [editor],
    );
}

/**
 * The hex each colour NAME resolves to right now.
 *
 * Read from tldraw's live theme rather than written down here, so a swatch is
 * always the ink the pen will actually lay down: the notebook and PDF canvases
 * are pinned to the light theme (see their colorScheme notes) while a `.tldraw`
 * whiteboard follows the app's, and the same 'black' is #1d1d1d in one and
 * #f2f2f2 in the other. A hard-coded palette would be wrong in whichever of
 * those it was not written for.
 */
function useSwatchColors(editor: Editor): Record<string, string> {
    return useValue('swatch colors', () => {
        const palette = editor.getCurrentTheme().colors[editor.getColorMode()];
        return Object.fromEntries(COLORS.map(name => [name, palette[name].solid]));
    }, [editor]);
}

export default function CanvasStylePanel() {
    const editor = useEditor();
    const color = useCurrentColor(editor);
    const swatches = useSwatchColors(editor);
    // This canvas's own width, not the app's: two files can be on screen at
    // once in a split, each remembering its own pen.
    const readScale = useCallback(() => getPenScale(editor), [editor]);
    const scale = useSyncExternalStore(subscribePenScale, readScale, readScale);

    const pickColor = useCallback((next: TLDefaultColorStyle) => {
        editor.run(() => {
            editor.setStyleForNextShapes(DefaultColorStyle, next);
            // Recolours a selection too, which is what the panel it replaces did.
            editor.setStyleForSelectedShapes(DefaultColorStyle, next);
        });
    }, [editor]);

    const changeWidth = useCallback((position: number) => {
        const next = sliderToPenScale(position);
        setPenScale(editor, next);
        // Apply to anything selected, so the slider re-inks a stroke already
        // drawn rather than only the next one.
        const selected = editor.getSelectedShapes().filter(s => 'scale' in s.props);
        if (selected.length) {
            editor.run(() => {
                // Cast per shape: TLShapePartial is a discriminated union, and
                // mapping over a mixed selection widens `type` past the point
                // where it still narrows `props`. Every shape here was filtered
                // to one that HAS `scale`, so the write is sound.
                editor.updateShapes(selected.map(s => ({
                    id: s.id,
                    type: s.type,
                    props: { scale: next },
                } as TLShapePartial)));
            });
        }
    }, [editor]);

    return (
        <div className="canvas-style-panel" data-testid="canvas-style-panel">
            <div className="canvas-style-colors">
                {COLORS.map(name => (
                    <button
                        key={name}
                        type="button"
                        className={`canvas-style-swatch${color === name ? ' selected' : ''}`}
                        style={{ ['--swatch' as string]: swatches[name] }}
                        onClick={() => pickColor(name)}
                        aria-label={name.replace('-', ' ')}
                        aria-pressed={color === name}
                        title={name.replace('-', ' ')}
                    />
                ))}
            </div>

            <div className="canvas-style-width">
                {/* The preview is the honest way to label this: a number of
                    "scale units" means nothing, and the dot is exactly the ink
                    the pen will lay down, at the same 3 x scale px the canvas
                    uses at 100%. */}
                <span
                    className="canvas-style-width-preview"
                    aria-hidden="true"
                    style={{
                        ['--dot' as string]: `${Math.max(1, 3 * scale)}px`,
                        ['--swatch' as string]: swatches[color] ?? swatches.black,
                    }}
                />
                <input
                    className="canvas-style-slider"
                    type="range"
                    min={0}
                    max={1}
                    step={0.001}
                    value={penScaleToSlider(scale)}
                    onChange={e => changeWidth(Number(e.target.value))}
                    // Double-click the slider to get back to the default width,
                    // which is otherwise a specific point on a log scale that
                    // cannot be hit by hand.
                    onDoubleClick={() => changeWidth(penScaleToSlider(DEFAULT_PEN_SCALE))}
                    aria-label="Pen width"
                    title="Pen width — double-click to reset"
                />
            </div>
        </div>
    );
}
