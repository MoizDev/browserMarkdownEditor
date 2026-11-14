import { SWATCHES, type Swatch } from './styles';

// Resolver for a stored colour name this build does not know. Owner ruling: the stored name is always kept
// and written unchanged unless the user recolours (the raw value lives in ext.raw); only the DRAWN colour is
// resolved, here, in a deterministic pure function with no DOM and no theme lookup.
//
// Default resolver, no alias table in plan: a leading modifier is stripped once, the base is looked up as a
// known swatch, and any other name is matched against the static CSS keyword table below by perceptual
// distance to the light theme's resolved swatches. A name that resolves nowhere draws black.

/** Light-theme stroke colour per swatch: `render/palette.ts` `light[swatch][0]`. Both must change together. */
export const LIGHT_STROKE_HEX: Readonly<Record<Swatch, string>> = Object.freeze({
    black: '1d1d1d', grey: '9fa8b2', 'light-violet': 'e085f4', violet: 'ae3ec9', blue: '4465e9',
    'light-blue': '4ba1f1', yellow: 'f1ac4b', orange: 'e16919', green: '099268', 'light-green': '4cb05e',
    'light-red': 'f87777', red: 'e03131', white: 'ffffff',
});

/** CSS named colours (CSS Color 4 keyword set), hex without '#'. Static, so the result is deterministic. */
export const CSS_NAMED_COLOURS: Readonly<Record<string, string>> = Object.freeze({
    aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4', azure: 'f0ffff',
    beige: 'f5f5dc', bisque: 'ffe4c4', black: '000000', blanchedalmond: 'ffebcd', blue: '0000ff',
    blueviolet: '8a2be2', brown: 'a52a2a', burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00',
    chocolate: 'd2691e', coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c',
    cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b', darkgray: 'a9a9a9',
    darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b', darkmagenta: '8b008b', darkolivegreen: '556b2f',
    darkorange: 'ff8c00', darkorchid: '9932cc', darkred: '8b0000', darksalmon: 'e9967a', darkseagreen: '8fbc8f',
    darkslateblue: '483d8b', darkslategray: '2f4f4f', darkslategrey: '2f4f4f', darkturquoise: '00ced1',
    darkviolet: '9400d3', deeppink: 'ff1493', deepskyblue: '00bfff', dimgray: '696969', dimgrey: '696969',
    dodgerblue: '1e90ff', firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22', fuchsia: 'ff00ff',
    gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff', gold: 'ffd700', goldenrod: 'daa520', gray: '808080',
    green: '008000', greenyellow: 'adff2f', grey: '808080', honeydew: 'f0fff0', hotpink: 'ff69b4',
    indianred: 'cd5c5c', indigo: '4b0082', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa',
    lavenderblush: 'fff0f5', lawngreen: '7cfc00', lemonchiffon: 'fffacd', lightblue: 'add8e6', lightcoral: 'f08080',
    lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3', lightgreen: '90ee90',
    lightgrey: 'd3d3d3', lightpink: 'ffb6c1', lightsalmon: 'ffa07a', lightseagreen: '20b2aa',
    lightskyblue: '87cefa', lightslategray: '778899', lightslategrey: '778899', lightsteelblue: 'b0c4de',
    lightyellow: 'ffffe0', lime: '00ff00', limegreen: '32cd32', linen: 'faf0e6', magenta: 'ff00ff',
    maroon: '800000', mediumaquamarine: '66cdaa', mediumblue: '0000cd', mediumorchid: 'ba55d3',
    mediumpurple: '9370db', mediumseagreen: '3cb371', mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a',
    mediumturquoise: '48d1cc', mediumvioletred: 'c71585', midnightblue: '191970', mintcream: 'f5fffa',
    mistyrose: 'ffe4e1', moccasin: 'ffe4b5', navajowhite: 'ffdead', navy: '000080', oldlace: 'fdf5e6',
    olive: '808000', olivedrab: '6b8e23', orange: 'ffa500', orangered: 'ff4500', orchid: 'da70d6',
    palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee', palevioletred: 'db7093',
    papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f', pink: 'ffc0cb', plum: 'dda0dd',
    powderblue: 'b0e0e6', purple: '800080', rebeccapurple: '663399', red: 'ff0000', rosybrown: 'bc8f8f',
    royalblue: '4169e1', saddlebrown: '8b4513', salmon: 'fa8072', sandybrown: 'f4a460', seagreen: '2e8b57',
    seashell: 'fff5ee', sienna: 'a0522d', silver: 'c0c0c0', skyblue: '87ceeb', slateblue: '6a5acd',
    slategray: '708090', slategrey: '708090', snow: 'fffafa', springgreen: '00ff7f', steelblue: '4682b4',
    tan: 'd2b48c', teal: '008080', thistle: 'd8bfd8', tomato: 'ff6347', turquoise: '40e0d0', violet: 'ee82ee',
    wheat: 'f5deb3', white: 'ffffff', whitesmoke: 'f5f5f5', yellow: 'ffff00', yellowgreen: '9acd32',
});

const MODIFIERS = ['light', 'dark', 'pale', 'deep', 'bright', 'soft'] as const;
const MAX_NAME = 64;

function isSwatch(value: string): value is Swatch {
    return (SWATCHES as readonly string[]).includes(value);
}

function linear(channel: number): number {
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** CIE L*a*b* (D65) of a hex colour. Deterministic floating point; no colour profile, no DOM. */
function lab(hex: string): readonly [number, number, number] {
    const r = linear(parseInt(hex.slice(0, 2), 16) / 255), g = linear(parseInt(hex.slice(2, 4), 16) / 255),
        b = linear(parseInt(hex.slice(4, 6), 16) / 255);
    const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
    const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    const fx = f(x), fy = f(y), fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Nearest known swatch by CIE76 ΔE against the light theme's resolved strokes; ties go to SWATCHES order. */
function nearestLightSwatch(hex: string): Swatch {
    const [l, a, b] = lab(hex);
    let best: Swatch = 'black', bestDistance = Infinity;
    for (const swatch of SWATCHES) {
        const [l2, a2, b2] = lab(LIGHT_STROKE_HEX[swatch]);
        const distance = (l - l2) ** 2 + (a - a2) ** 2 + (b - b2) ** 2;
        if (distance < bestDistance) { bestDistance = distance; best = swatch; }
    }
    return best;
}

/**
 * The drawn swatch for a stored colour name. Order: (1) a known name is itself; (2) one leading modifier
 * is stripped, and a known base draws its family, using the light variant for light/pale/soft when it
 * exists; (3) the name, or its base, that is a CSS keyword maps to the nearest known swatch; (4) anything
 * else draws black.
 */
export function resolveDrawnSwatch(stored: string): Swatch {
    if (stored.length > MAX_NAME) return 'black';
    const name = stored.toLowerCase();
    if (isSwatch(name)) return name;
    const dash = name.indexOf('-');
    const lead = dash > 0 ? name.slice(0, dash) : '';
    const base = (MODIFIERS as readonly string[]).includes(lead) ? name.slice(dash + 1) : name;
    if (base !== name && isSwatch(base)) {
        if (lead === 'light' || lead === 'pale' || lead === 'soft') {
            const light = `light-${base}`;
            if (isSwatch(light)) return light;
        }
        return base;
    }
    const hex = Object.hasOwn(CSS_NAMED_COLOURS, name) ? CSS_NAMED_COLOURS[name]
        : Object.hasOwn(CSS_NAMED_COLOURS, base) ? CSS_NAMED_COLOURS[base] : undefined;
    return hex ? nearestLightSwatch(hex) : 'black';
}
