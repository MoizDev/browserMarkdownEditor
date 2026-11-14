import type { Rgba } from '../../platform/types';
import type { Swatch } from '../model/styles';
import { rgba, type PaintPalette, type SwatchColours } from './colour';

// STYLE's recorded palette supplies role colours; unmeasured pattern geometry remains a separate concern.
type Row = readonly [stroke: string, highlight: string, semi: string, pattern: string, lined: string];
type Rows = Readonly<Record<Swatch, Row>>;
const light: Rows = {
    black: ['1d1d1d', 'fddd00', 'e8e8e8', '494949', '363636'],
    grey: ['9fa8b2', 'cbe7f1', 'eceef0', 'bcc3c9', 'bbc1c9'],
    'light-violet': ['e085f4', 'ff88ff', 'f5eafa', 'e9acf8', 'e9abf7'],
    violet: ['ae3ec9', 'c77cff', 'ecdcf2', 'bd63d3', 'be68d4'],
    blue: ['4465e9', '10acff', 'dce1f8', '6681ee', '6580ec'],
    'light-blue': ['4ba1f1', '00f4ff', 'ddedfa', '6fbbf8', '7abaf5'],
    yellow: ['f1ac4b', 'fddd00', 'f9f0e6', 'fecb92', 'f5c27a'],
    orange: ['e16919', 'ffa500', 'f8e2d4', 'f78438', 'ea8643'],
    green: ['099268', '00ffc8', 'd3e9e3', '39a785', '0bad7c'],
    'light-green': ['4cb05e', '65f641', 'dbf0e0', '65cb78', '7ec88c'],
    'light-red': ['f87777', 'ff7fa3', 'f4dadb', 'fe9e9e', 'f99a9a'],
    red: ['e03131', 'ff636e', 'f4dadb', 'e55959', 'e75f5f'],
    white: ['ffffff', 'ffffff', 'f5f5f5', 'f9f9f9', 'ffffff'],
};
const dark: Rows = {
    black: ['f2f2f2', 'd2b700', '2c3036', '989898', 'ffffff'],
    grey: ['9398b0', '9cb4cb', '33373c', '7c8187', '8388a5'],
    'light-violet': ['e599f7', 'c400c7', '383442', '9770a9', 'dc71f4'],
    violet: ['ae3ec9', '9e00ee', '342938', '763a8b', '8f2fa7'],
    blue: ['4f72fc', '0079d2', '262d40', '3a4b9e', '3c5cdd'],
    'light-blue': ['4dabf7', '00bdc8', '2a3642', '4d7aa9', '2793ec'],
    yellow: ['ffc034', 'd2b700', '3b352b', 'fecb92', 'ffae00'],
    orange: ['f76707', 'd07a00', '3b2e27', '9f552d', 'f54900'],
    green: ['099268', '009774', '253231', '366a53', '087856'],
    'light-green': ['40c057', '00a000', '2a3830', '4e874e', '37a44b'],
    'light-red': ['ff8787', 'db005b', '3c2b2b', 'a56767', 'ff6666'],
    red: ['e03131', 'de002c', '382726', '8f3734', 'c31d1d'],
    white: ['f3f3f3', 'ffffff', 'f5f5f5', 'f9f9f9', 'f3f3f3'],
};
function colour(hex: string): Rgba {
    return rgba(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255);
}
function palette(rows: Rows, background: string, solid: string, revision: number): PaintPalette {
    const stroke = {} as Record<Swatch, Rgba>, highlight = {} as Record<Swatch, Rgba>;
    const semi = {} as Record<Swatch, Rgba>, pattern = {} as Record<Swatch, Rgba>;
    const lined = {} as Record<Swatch, Rgba>, opaqueSolid = {} as Record<Swatch, Rgba>;
    const neutral = colour(solid);
    for (const key of Object.keys(rows) as Swatch[]) {
        const row = rows[key];
        stroke[key] = colour(row[0]); highlight[key] = colour(row[1]); semi[key] = colour(row[2]);
        pattern[key] = colour(row[3]); lined[key] = colour(row[4]); opaqueSolid[key] = neutral;
    }
    const frozenStroke: SwatchColours = Object.freeze(stroke);
    return Object.freeze({ revision, stroke: frozenStroke, highlight: Object.freeze(highlight),
        fills: Object.freeze({ semi: Object.freeze(semi), solid: Object.freeze(opaqueSolid), pattern: Object.freeze(pattern),
            fill: frozenStroke, 'lined-fill': Object.freeze(lined) }), background: colour(background) });
}

// INK-H1 records white light/paper and #1e1e1e dark-board backdrops. Paper always selects light.
export const DEFAULT_BOARD_PALETTES: Readonly<{ light: PaintPalette; dark: PaintPalette }> = Object.freeze({
    light: palette(light, 'ffffff', 'fcfffe', 1),
    dark: palette(dark, '1e1e1e', '010403', 2),
});
