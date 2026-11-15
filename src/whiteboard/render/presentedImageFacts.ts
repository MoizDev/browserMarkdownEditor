import type { EmbedLaterPaint } from '../../platform/render/embedPresentation.types';
import type { PathCommand, Affine } from '../../platform/types';
import { classifyImageFootprint, isGutterQuadDraw, texturedQuad, TILE_CROP, TILE_SIZE, type AlphaPlane, type DeviceRect } from './imageSampling';
import type { PresentedImage } from './paintPresentation';

/** `null` when the image puts nothing inside the region; `unknown` when its facts cannot be proven,
 * which keeps the true-order poster rather than a guessed translucence. */
export type LaterPaintFact = EmbedLaterPaint | null;
const UNKNOWN: EmbedLaterPaint = Object.freeze({ opacity: 'unknown' });

const MAX_RUNS = 16_384;

/** Later-paint facts of one drawn image over a live embed's device-pixel region. Only the gutter quad the draw
 * takes (imageSampling.isGutterQuadDraw) is classified, on its real positive-weight footprint: `paneTransform`
 * maps world to pane CSS, `dpr` converts to device pixels, and `alpha` is the exact readback of `image.source`.
 * Anything else takes the crop path, so it is unknown and the true-order poster stays. */
export function imageLaterPaint(image: PresentedImage, paneTransform: Affine | null, dpr: number,
    region: DeviceRect, alpha: AlphaPlane): LaterPaintFact {
    const { item } = image;
    if (!isGutterQuadDraw(item, image.source) || !paneTransform || !(dpr > 0)) return UNKNOWN;
    if (alpha.width !== TILE_SIZE || alpha.height !== TILE_SIZE) return UNKNOWN;
    const [a, b, c, d, e, f] = paneTransform;
    if (b !== 0 || c !== 0 || !(a > 0) || !(d > 0)) return UNKNOWN;
    const { rect } = item;
    const dest = { x: (a * rect.x + e) * dpr, y: (d * rect.y + f) * dpr, width: rect.width * a * dpr, height: rect.height * d * dpr };
    if (!(dest.width > 0) || !(dest.height > 0)) return null;
    let quad;
    try { quad = texturedQuad(dest, TILE_SIZE, TILE_CROP); } catch { return UNKNOWN; }
    const facts = classifyImageFootprint({
        plane: alpha, window: { x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE }, quad, within: region, maxRuns: MAX_RUNS,
    });
    if (facts.status === 'unavailable') return UNKNOWN;
    if (facts.status === 'translucent') return { opacity: 'translucent' };
    if (!facts.runs.length) return null;
    const commands: PathCommand[] = [];
    for (let i = 0; i < facts.runs.length; i += 4) {
        const x = facts.runs[i], y = facts.runs[i + 1], w = facts.runs[i + 2];
        commands.push(['M', x, y], ['L', x + w, y], ['L', x + w, y + 1], ['L', x, y + 1], ['L', x, y]);
    }
    // Path coordinates are device pixels; the embed contract places them in pane CSS.
    return { opacity: 'opaque', coverage: { path: { d: commands, fillRule: 'nonzero', toPane: [1 / dpr, 0, 0, 1 / dpr, 0, 0] }, clips: [] } };
}
