import { SWATCHES, type Swatch } from './styles';
import { DEFAULT_BOARD_PALETTES } from '../render/palette';

// Provenance: clipboard §4.6, CIE 1976 L*a*b* and CIEDE2000 colour-distance
// definitions; independently implemented, no upstream engine source.
type Lab = readonly [number, number, number];
function lab(rgb: readonly [number, number, number]): Lab {
    const linear = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    const [r, g, b] = rgb.map(linear);
    const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
    const f = (v: number) => v > 216 / 24389 ? Math.cbrt(v) : (24389 / 27 * v + 16) / 116;
    const fx = f(x), fy = f(y), fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function ciede2000(left: Lab, right: Lab): number {
    const [l1, a1, b1] = left, [l2, a2, b2] = right, rad = Math.PI / 180;
    const c1 = Math.hypot(a1, b1), c2 = Math.hypot(a2, b2), meanC = (c1 + c2) / 2;
    const meanC7 = meanC ** 7, g = (1 - Math.sqrt(meanC7 / (meanC7 + 25 ** 7))) / 2;
    const a1p = (1 + g) * a1, a2p = (1 + g) * a2, c1p = Math.hypot(a1p, b1), c2p = Math.hypot(a2p, b2);
    const hue = (a: number, b: number) => { if (!a && !b) return 0; const h = Math.atan2(b, a) / rad; return h < 0 ? h + 360 : h; };
    const h1 = hue(a1p, b1), h2 = hue(a2p, b2), dl = l2 - l1, dc = c2p - c1p;
    let dh = h2 - h1;
    if (!c1p || !c2p) dh = 0;
    else if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
    const dH = 2 * Math.sqrt(c1p * c2p) * Math.sin(dh * rad / 2), meanL = (l1 + l2) / 2, meanCp = (c1p + c2p) / 2;
    let meanH: number;
    if (!c1p || !c2p) meanH = h1 + h2;
    else if (Math.abs(h1 - h2) <= 180) meanH = (h1 + h2) / 2;
    else meanH = (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2;
    const t = 1 - 0.17 * Math.cos((meanH - 30) * rad) + 0.24 * Math.cos(2 * meanH * rad)
        + 0.32 * Math.cos((3 * meanH + 6) * rad) - 0.20 * Math.cos((4 * meanH - 63) * rad);
    const dl50 = meanL - 50, sl = 1 + 0.015 * dl50 ** 2 / Math.sqrt(20 + dl50 ** 2);
    const sc = 1 + 0.045 * meanCp, sh = 1 + 0.015 * meanCp * t;
    const c7 = meanCp ** 7, rc = 2 * Math.sqrt(c7 / (c7 + 25 ** 7));
    const rt = -Math.sin(60 * rad * Math.exp(-(((meanH - 275) / 25) ** 2))) * rc;
    const x = dl / sl, y = dc / sc, z = dH / sh;
    return Math.sqrt(Math.max(0, x * x + y * y + z * z + rt * y * z));
}
const PALETTE = SWATCHES.map(swatch => {
    const colour = DEFAULT_BOARD_PALETTES.light.stroke[swatch];
    return { swatch, value: lab([colour[0], colour[1], colour[2]]) };
});
/** Encoded sRGB channels in [0,1]. Black competes normally; exact ties go to lower L*. */
export function nearestLightSwatch(rgb: readonly [number, number, number]): Swatch {
    if (!rgb || rgb.length !== 3 || !rgb.every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new RangeError('Invalid encoded sRGB colour');
    const target = lab(rgb);
    let best = PALETTE[0], distance = ciede2000(target, best.value);
    for (let i = 1; i < PALETTE.length; i++) {
        const candidate = PALETTE[i], next = ciede2000(target, candidate.value);
        if (next < distance || next === distance && candidate.value[0] < best.value[0]) { best = candidate; distance = next; }
    }
    return best.swatch;
}
