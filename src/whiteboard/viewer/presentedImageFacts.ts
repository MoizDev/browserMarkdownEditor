import type { EmbedLaterPaint } from '../../platform/render/embedPresentation.types';
import type { PathCommand, Affine } from '../../platform/types';
import { classifyImageFootprint, texturedQuad, type AlphaPlane, type DeviceRect } from '../render/imageSampling';
import type { PresentedImage } from '../render/paintPresentation';

/** `null` when the image puts nothing inside the region; 'unavailable' when its facts cannot be
 * proven, which callers answer with the true-order poster rather than a guessed translucence. */
export type LaterPaintFact = EmbedLaterPaint | null | 'unavailable';

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];
const MAX_RUNS = 16_384;

/** Later-paint facts of one drawn image over a live embed's device-pixel region. The image is
 * classified on its real GPU draw (the full backing texture on its gutter-grown quad) with each
 * pixel's positive-weight texel footprint. `paneTransform` maps world to pane CSS, `dpr` converts
 * to device pixels, and `alpha` is the exact readback of `image.source`. */
export function imageLaterPaint(image: PresentedImage, paneTransform: Affine | null, dpr: number,
    region: DeviceRect, alpha: AlphaPlane): LaterPaintFact {
    const { item } = image;
    if (!paneTransform || !(dpr > 0) || item.clips.length) return 'unavailable';
    if (!item.sourceRect || alpha.width !== image.source.width || alpha.height !== image.source.height) return 'unavailable';
    if (item.localToWorld.some((value, index) => value !== IDENTITY[index])) return 'unavailable';
    const [a, b, c, d, e, f] = paneTransform;
    if (b !== 0 || c !== 0 || !(a > 0) || !(d > 0)) return 'unavailable';
    const { rect } = item;
    const dest = { x: (a * rect.x + e) * dpr, y: (d * rect.y + f) * dpr, width: rect.width * a * dpr, height: rect.height * d * dpr };
    if (!(dest.width > 0) || !(dest.height > 0)) return null;
    const facts = classifyImageFootprint({
        plane: alpha, window: { x: 0, y: 0, width: alpha.width, height: alpha.height },
        quad: texturedQuad(dest, alpha.width, item.sourceRect), within: region, maxRuns: MAX_RUNS,
    });
    if (facts.status === 'unavailable') return 'unavailable';
    if (facts.status === 'translucent') return { opacity: 'translucent' };
    // Opacity below one or a non-normal blend turns every covered pixel into a translucent contribution.
    if (item.opacity !== 1 || item.blend !== 'normal') return facts.runs.length ? { opacity: 'translucent' } : null;
    if (!facts.runs.length) return null;
    const commands: PathCommand[] = [];
    for (let i = 0; i < facts.runs.length; i += 4) {
        const x = facts.runs[i], y = facts.runs[i + 1], w = facts.runs[i + 2];
        commands.push(['M', x, y], ['L', x + w, y], ['L', x + w, y + 1], ['L', x, y + 1], ['L', x, y]);
    }
    // Path coordinates are device pixels; the embed contract places them in pane CSS.
    return { opacity: 'opaque', coverage: { path: { d: commands, fillRule: 'nonzero', toPane: [1 / dpr, 0, 0, 1 / dpr, 0, 0] }, clips: [] } };
}
