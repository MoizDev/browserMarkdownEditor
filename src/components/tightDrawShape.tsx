// Ink that keeps up with the nib.
//
// WHY THIS EXISTS AT ALL. tldraw chooses its freehand settings inside
// `getFreehandOptions`, a module-private function in lib/shapes/draw/getPath.js
// that DrawShapeUtil calls from its own methods. It is not a method, not
// exported, and takes nothing from the editor — so there is no hook, and
// re-rendering the shape ourselves is the only way to change the one number
// that decides how far ink trails the pen.
//
// WHAT IT CHANGES: `streamline`, and nothing else. perfect-freehand places each
// incoming point a fraction (1 - streamline) of the way toward where the pen
// actually is, so it alone sets the lag. MEASURED on the smoothed CENTRELINE
// (tldraw's own `getStrokePoints`, 12px between input points), with stroke
// width proved irrelevant — identical lag at 3, 4.6, 6 and 10px:
//
//     0.64  tldraw's, for dash 'solid'          7.79px behind the pen
//     0.62  tldraw's, for a stylus on 'draw'    7.05px
//     0.40                                      2.10px
//     0.01  ours                                0.00px
//
// SETTLED BY DRAWING, NOT BY ARGUING. The prediction from the arithmetic was
// that somewhere near 0.35-0.45 would be the floor, because streamline is also
// what hides a tablet's jitter and its polling grid. On an actual graphics
// tablet that turned out to be wrong: the device reports finely enough that
// there is no jitter left to hide, and effectively switching smoothing off
// reads as the pen simply working. components/PenDevPanel.tsx is the panel
// that made the comparison possible, and is the thing to reach for before
// changing this number — it cannot be judged from a diff.
//
// A device that reports more coarsely (a trackpad, a touchscreen, a cheap
// stylus) would want this back up. It is one constant, not a redesign.
//
// HOW LITTLE IT OWNS. Every method here delegates to tldraw unless the shape is
// the one this app actually produces — `dash: 'solid'`, which canvasPen pins.
// Dashed, dotted and 'draw' strokes keep tldraw's exact behaviour, so what we
// maintain across upgrades is one branch, not a renderer.

import {
    Circle2d, DrawShapeUtil, Polygon2d, Polyline2d, SVGContainer, getDisplayValues,
    getPointsFromDrawSegments, getStrokePoints, getSvgPathFromStrokePoints,
    type StrokeOptions, type TLDrawShape,
} from 'tldraw';
import { getPenStreamline } from '../utils/penDev';

/** tldraw's own value, kept so only the trailing changes and not the shape of
 *  the curve between points. */
const SMOOTHING = 0.62;

function inkOptions(strokeWidth: number, complete: boolean): StrokeOptions {
    return {
        size: strokeWidth,
        // Even width, whatever the pressure — this is what the width slider
        // promises, and it is why dash stays 'solid' in canvasPen.ts.
        thinning: 0,
        streamline: getPenStreamline(),
        smoothing: SMOOTHING,
        simulatePressure: false,
        easing: (t: number) => t,
        last: complete,
    };
}

/** `dash: 'solid'` is the only shape this app draws, and the only one we take
 *  over; anything else is tldraw's to render. */
const isOurs = (shape: TLDrawShape) => shape.props.dash === 'solid';

/** Stroke width in the same terms DrawShapeUtil uses. */
function widthOf(util: TightDrawShapeUtil, shape: TLDrawShape): number {
    return (getDisplayValues(util, shape).strokeWidth + 1) * shape.props.scale;
}

/** A stroke is "complete" once it ends — freehand tapers the final cap then. */
const isComplete = (shape: TLDrawShape) =>
    shape.props.isComplete || shape.props.segments.at(-1)?.type === 'straight';

/** tldraw's dot path, for a stroke too short to have a direction. */
const dotPath = (p: { x: number; y: number }, sw: number) => {
    const r = (sw + 1) * 0.5;
    return `M ${p.x} ${p.y} m -${r}, 0 a ${r},${r} 0 1,0 ${r * 2},0 a ${r},${r} 0 1,0 -${r * 2},0`;
};

function pathFor(util: TightDrawShapeUtil, shape: TLDrawShape): { d: string; isDot: boolean } {
    const points = getPointsFromDrawSegments(shape.props.segments, shape.props.scaleX, shape.props.scaleY);
    const sw = widthOf(util, shape);
    const strokePoints = getStrokePoints(points, inkOptions(sw, isComplete(shape)));
    if (strokePoints.length < 2) return { d: dotPath(points[0], 0), isDot: true };
    // A closed stroke is only filled as a region when it asks to be; an open
    // one is a centreline that the <path> below strokes.
    return { d: getSvgPathFromStrokePoints(strokePoints, shape.props.isClosed && shape.props.fill !== 'none'), isDot: false };
}

export class TightDrawShapeUtil extends DrawShapeUtil {
    override component(shape: TLDrawShape) {
        if (!isOurs(shape)) return super.component(shape);
        const dv = getDisplayValues(this, shape);
        const { d, isDot } = pathFor(this, shape);
        // Solid ink is a stroked CENTRELINE, not an outline — the same thing
        // tldraw renders for this dash, which is why this stays short.
        return (
            <SVGContainer>
                <path
                    d={d}
                    strokeLinecap="round"
                    fill={isDot ? dv.strokeColor : 'none'}
                    stroke={dv.strokeColor}
                    strokeWidth={widthOf(this, shape)}
                />
            </SVGContainer>
        );
    }

    /** Bounds and hit-testing follow the ink. Left to tldraw this would still
     *  be built at streamline 0.62/0.64, so a stroke's clickable path would sit
     *  ~5px from the stroke you can see. */
    override getGeometry(shape: TLDrawShape) {
        if (!isOurs(shape)) return super.getGeometry(shape);
        const points = getPointsFromDrawSegments(shape.props.segments, shape.props.scaleX, shape.props.scaleY);
        const sw = widthOf(this, shape);
        const strokePoints = getStrokePoints(points, inkOptions(sw, shape.props.isPen)).map(p => p.point);
        if (strokePoints.length === 1) return new Circle2d({ x: -sw, y: -sw, radius: sw, isFilled: true });
        if (shape.props.isClosed && strokePoints.length > 2) {
            return new Polygon2d({ points: strokePoints, isFilled: shape.props.fill !== 'none' });
        }
        return new Polyline2d({ points: strokePoints });
    }

    /** The selection outline, which must trace the ink rather than hover beside it. */
    override getIndicatorPath(shape: TLDrawShape) {
        if (!isOurs(shape)) return super.getIndicatorPath(shape);
        return new Path2D(pathFor(this, shape).d);
    }

    /** Export — the notebook's PDF and every SVG export come through here, and
     *  a stroke that exported at tldraw's smoothing would not match the one on
     *  screen. Filled/closed strokes are rare and stay tldraw's. */
    override toSvg(shape: TLDrawShape, ctx: Parameters<DrawShapeUtil['toSvg']>[1]) {
        if (!isOurs(shape) || (shape.props.isClosed && shape.props.fill !== 'none')) {
            return super.toSvg(shape, ctx);
        }
        const dv = getDisplayValues(this, shape, ctx.colorMode);
        const { d, isDot } = pathFor(this, shape);
        return (
            <g transform={`scale(${1 / shape.props.scale})`}>
                <path
                    d={d}
                    strokeLinecap="round"
                    fill={isDot ? dv.strokeColor : 'none'}
                    stroke={dv.strokeColor}
                    strokeWidth={widthOf(this, shape)}
                />
            </g>
        );
    }
}
