// Annotations as VECTOR, not pixels: tldraw's SVG export reduced to a flat list
// of path-draw operations that pdf-lib can replay into a page's content stream.
//
// WHY THIS EXISTS. Overlays used to reach the saved PDF only as `toImage(...,
// {format:'png', scale:2})` bitmaps stamped onto the page. The pages themselves
// stayed vector — but the ink on them did not, so zooming past ~200% in any
// viewer showed soft, pixelated strokes, and a densely annotated page cost
// hundreds of KB of PNG. Replaying the same strokes as paths makes them sharp at
// any zoom and typically an order of magnitude smaller.
//
// DELIBERATELY IMPORTS NOTHING. It is read by the main thread (which parses the
// SVG) and, for its types, by the DOM-less build worker — so a single import of
// pdf.js or pdf-lib here would breach the split that keeps both out of the main
// bundle. DOMParser is a global; the worker only ever imports the types, which
// are erased.
//
// NOT EVERY SHAPE CAN BE A PATH. Text needs an embedded font, images need an
// embedded bitmap, tldraw's "pattern" fill is an SVG <pattern>, and a shape
// inside a frame carries a clip path. Rather than approximate any of those,
// `svgToVectorOps` returns null and the caller rasterizes that page exactly as
// before — so the worst case is today's behaviour, never a wrong drawing.

/** Colour channels in 0..1, the form pdf-lib's `rgb()` takes. */
export interface VectorRgb {
    r: number;
    g: number;
    b: number;
}

/**
 * One path, ready to draw.
 *
 * Positions are in PAGE-LOCAL SVG SPACE: origin at the page's top-left corner,
 * x right, y **down**, measured in PDF points. That is the space the strokes
 * were authored in (it is what pdf.js displayed), and it is one flip away from
 * PDF user space — which `drawSvgPath` performs anyway, so the builder converts
 * with a single `pageHeight - y`.
 */
export interface VectorOp {
    /**
     * Path data in this path's own local coordinates, normalized to absolute
     * `M`/`L`/`C`/`Z` and nothing else — see `normalizePathData` for why that
     * matters.
     */
    d: string;
    /** Where that local origin lands on the page. */
    x: number;
    y: number;
    /** Rotation in degrees, SVG sense (clockwise, because y points down). */
    rotate: number;
    /** Uniform scale. Stroke width and dashes ride the CTM, exactly as in SVG. */
    scale: number;
    /** Absent = not filled. */
    fill?: VectorRgb;
    fillOpacity: number;
    /** Absent = not stroked. */
    stroke?: VectorRgb;
    strokeOpacity: number;
    /** In the path's own units, before `scale`. */
    strokeWidth: number;
    dash?: number[];
    /** pdf-lib's LineCapStyle: 0 butt, 1 round, 2 projecting square. */
    lineCap: 0 | 1 | 2;
}

/* ── Affine matrices ──────────────────────────────────────────────────────
 * [a, b, c, d, e, f] is SVG's own ordering, i.e.
 *
 *     | a  c  e |
 *     | b  d  f |
 *     | 0  0  1 |
 *
 * so a point maps to (a·x + c·y + e, b·x + d·y + f).
 * ───────────────────────────────────────────────────────────────────────── */

type Mat = readonly [number, number, number, number, number, number];

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** `m` then `n` as SVG composes them: the parent's transform applied last. */
function compose(m: Mat, n: Mat): Mat {
    return [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ];
}

/** Thrown for anything this translator will not approximate. Caught in
 *  `svgToVectorOps`, which then reports "rasterize this page instead". */
class Unsupported extends Error {}

const TRANSFORM_FN = /([a-zA-Z]+)\s*\(([^)]*)\)/g;

function numbers(text: string): number[] {
    const found = text.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
    return found ? found.map(Number) : [];
}

function parseTransform(text: string): Mat {
    let out = IDENTITY;
    TRANSFORM_FN.lastIndex = 0;
    for (let m = TRANSFORM_FN.exec(text); m; m = TRANSFORM_FN.exec(text)) {
        const args = numbers(m[2]);
        switch (m[1]) {
            case 'matrix':
                if (args.length !== 6) throw new Unsupported('matrix() needs 6 arguments');
                out = compose(out, args as unknown as Mat);
                break;
            case 'translate':
                out = compose(out, [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0]);
                break;
            case 'scale': {
                const sx = args[0] ?? 1;
                out = compose(out, [sx, 0, 0, args[1] ?? sx, 0, 0]);
                break;
            }
            case 'rotate': {
                const rad = ((args[0] ?? 0) * Math.PI) / 180;
                const cos = Math.cos(rad);
                const sin = Math.sin(rad);
                const rot: Mat = [cos, sin, -sin, cos, 0, 0];
                // rotate(a cx cy) is translate(cx cy) rotate(a) translate(-cx -cy).
                if (args.length >= 3) {
                    const [, cx, cy] = args;
                    out = compose(out, compose([1, 0, 0, 1, cx, cy], compose(rot, [1, 0, 0, 1, -cx, -cy])));
                } else {
                    out = compose(out, rot);
                }
                break;
            }
            // skewX/skewY produce a matrix drawSvgPath cannot express, and
            // nothing tldraw exports uses them. Rasterize rather than guess.
            default:
                throw new Unsupported(`transform ${m[1]}() is not supported`);
        }
    }
    return out;
}

/* ── Paint ──────────────────────────────────────────────────────────────── */

const NAMED: Record<string, VectorRgb> = {
    black: { r: 0, g: 0, b: 0 },
    white: { r: 1, g: 1, b: 1 },
};

/** null = "no paint" (`none`/`transparent`); throws for anything unrecognized,
 *  because silently defaulting a colour would draw the annotation wrong. */
function parseColor(raw: string): VectorRgb | null {
    const value = raw.trim().toLowerCase();
    if (!value || value === 'none' || value === 'transparent') return null;

    if (value.startsWith('#')) {
        const hex = value.slice(1);
        // #rgb and #rgba shorthand double each digit; the alpha digit is carried
        // by fill-opacity/stroke-opacity instead, so it is read and dropped here.
        if (hex.length === 3 || hex.length === 4) {
            const [r, g, b] = [0, 1, 2].map(i => parseInt(hex[i] + hex[i], 16) / 255);
            return { r, g, b };
        }
        if (hex.length === 6 || hex.length === 8) {
            const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
            return { r, g, b };
        }
        throw new Unsupported(`unreadable hex colour ${raw}`);
    }

    if (value.startsWith('rgb')) {
        const [r, g, b] = numbers(value);
        if (r === undefined || g === undefined || b === undefined) throw new Unsupported(`unreadable colour ${raw}`);
        return { r: r / 255, g: g / 255, b: b / 255 };
    }

    const named = NAMED[value];
    if (named) return named;
    // Includes url(#…): gradient and <pattern> fills (tldraw's "pattern" fill
    // style) have no drawSvgPath equivalent at all.
    throw new Unsupported(`colour ${raw} is not supported`);
}

/** Presentation attributes an element inherits from its ancestors. */
interface Paint {
    fill: VectorRgb | null;
    stroke: VectorRgb | null;
    fillOpacity: number;
    strokeOpacity: number;
    /** The `opacity` attribute, accumulated down the tree and folded into both. */
    groupOpacity: number;
    strokeWidth: number;
    dash?: number[];
    lineCap: 0 | 1 | 2;
}

const ROOT_PAINT: Paint = {
    // SVG's initial values: filled black, unstroked.
    fill: { r: 0, g: 0, b: 0 },
    stroke: null,
    fillOpacity: 1,
    strokeOpacity: 1,
    groupOpacity: 1,
    strokeWidth: 1,
    lineCap: 0,
};

const LINE_CAPS: Record<string, 0 | 1 | 2> = { butt: 0, round: 1, square: 2 };

/**
 * Read one presentation property, preferring an inline `style` declaration to
 * the matching attribute — the same order the browser resolves them in.
 */
function property(el: Element, name: string): string | null {
    const inline = (el as SVGElement).style?.getPropertyValue(name);
    if (inline) return inline;
    return el.getAttribute(name);
}

function inherit(el: Element, parent: Paint): Paint {
    const next: Paint = { ...parent };

    const fill = property(el, 'fill');
    if (fill !== null) next.fill = parseColor(fill);
    const stroke = property(el, 'stroke');
    if (stroke !== null) next.stroke = parseColor(stroke);

    const fillOpacity = property(el, 'fill-opacity');
    if (fillOpacity !== null) next.fillOpacity = Number(fillOpacity);
    const strokeOpacity = property(el, 'stroke-opacity');
    if (strokeOpacity !== null) next.strokeOpacity = Number(strokeOpacity);

    // `opacity` composites a whole subtree, so it multiplies rather than
    // replaces — a 0.5 group holding a 0.5 shape is 0.25.
    const opacity = property(el, 'opacity');
    if (opacity !== null) next.groupOpacity = parent.groupOpacity * Number(opacity);

    const strokeWidth = property(el, 'stroke-width');
    if (strokeWidth !== null) next.strokeWidth = Number(strokeWidth);

    const cap = property(el, 'stroke-linecap');
    if (cap !== null) next.lineCap = LINE_CAPS[cap.trim()] ?? 0;

    const dash = property(el, 'stroke-dasharray');
    if (dash !== null) {
        const trimmed = dash.trim();
        next.dash = trimmed === 'none' || trimmed === '' ? undefined : numbers(trimmed);
    }

    return next;
}

/* ── Path data normalization ──────────────────────────────────────────────
 *
 * WHY THIS EXISTS, and why it is not optional.
 *
 * pdf-lib's drawSvgPath parses the `d` string itself, and IT GETS QUADRATIC
 * CURVES WRONG. Its `appendQuadraticCurve(x1, y1, x2, y2)` emits the PDF `v`
 * operator, which is a CUBIC whose first control point is the current point —
 * not a quadratic at all. A quadratic through control C from P0 to P1 is the
 * cubic with controls P0 + ⅔(C−P0) and P1 + ⅔(C−P1); feeding it (P0, C) instead
 * throws the curve wide of where it belongs.
 *
 * That is not a corner case here. tldraw builds freehand ink almost entirely
 * out of `q` and `t` (see its freehand/fmt.ts, which emits relative t/q/a/l),
 * so EVERY stroke came out as a splayed, spiky blob — verified on screen before
 * this function existed.
 *
 * So convert first: quadratics and arcs become cubics, relative becomes
 * absolute, and pdf-lib is left with only M, L, C and Z — four runners whose
 * behaviour is a direct transcription of the matching PDF operator. As a bonus
 * it also stops us relying on that parser's arc solver and its handling of
 * unseparated flags.
 * ───────────────────────────────────────────────────────────────────────── */

/** Trim float noise without shifting anything visible: coordinates are PDF
 *  points, so a thousandth is a ten-thousandth of a millimetre. */
function round(n: number): number {
    return Math.round(n * 1000) / 1000;
}

const ARC_SEGMENT_MAX = Math.PI / 2;

/** A previous curve's trailing control point, which `S` and `T` reflect. */
type Control = readonly [number, number] | null;

function normalizePathData(d: string): string {
    let i = 0;
    const out: string[] = [];

    // Current point, subpath start, and the previous control points that `S`
    // and `T` reflect (null when the last command was not of the matching kind).
    let cx = 0;
    let cy = 0;
    let startX = 0;
    let startY = 0;
    let lastCubic: Control = null;
    let lastQuad: Control = null;

    const isSpace = (c: string) => c === ' ' || c === ',' || c === '\t' || c === '\n' || c === '\r';

    function skip(): void {
        while (i < d.length && isSpace(d[i])) i++;
    }

    function readNumber(): number {
        skip();
        const start = i;
        if (d[i] === '+' || d[i] === '-') i++;
        while (i < d.length && d[i] >= '0' && d[i] <= '9') i++;
        if (d[i] === '.') {
            i++;
            while (i < d.length && d[i] >= '0' && d[i] <= '9') i++;
        }
        if (d[i] === 'e' || d[i] === 'E') {
            i++;
            if (d[i] === '+' || d[i] === '-') i++;
            while (i < d.length && d[i] >= '0' && d[i] <= '9') i++;
        }
        const value = start === i ? NaN : Number(d.slice(start, i));
        if (!Number.isFinite(value)) throw new Unsupported(`unreadable number at ${start} in path data`);
        return value;
    }

    /** Arc flags are ONE character and may carry no separator at all — "1150,50"
     *  is flag 1, flag 1, then 50,50 — so they cannot go through readNumber. */
    function readFlag(): boolean {
        skip();
        const c = d[i];
        if (c !== '0' && c !== '1') throw new Unsupported('an arc flag must be 0 or 1');
        i++;
        return c === '1';
    }

    function emitMove(x: number, y: number): void {
        out.push(`M${round(x)} ${round(y)}`);
        cx = startX = x;
        cy = startY = y;
    }

    function emitLine(x: number, y: number): void {
        out.push(`L${round(x)} ${round(y)}`);
        cx = x;
        cy = y;
    }

    function emitCurve(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
        out.push(`C${round(x1)} ${round(y1)} ${round(x2)} ${round(y2)} ${round(x)} ${round(y)}`);
        cx = x;
        cy = y;
    }

    /** The conversion pdf-lib is missing. */
    function emitQuad(qx: number, qy: number, x: number, y: number): void {
        emitCurve(
            cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy),
            x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y),
            x, y,
        );
    }

    /** Endpoint-parameterized arc → cubics, per SVG's implementation notes F.6. */
    function emitArc(rx: number, ry: number, rotation: number, largeArc: boolean, sweep: boolean, x: number, y: number): void {
        // F.6.2: a zero radius, or no movement at all, degenerates to a line.
        if (!rx || !ry) { emitLine(x, y); return; }
        if (cx === x && cy === y) return;

        rx = Math.abs(rx);
        ry = Math.abs(ry);
        const phi = ((rotation % 360) * Math.PI) / 180;
        const cosPhi = Math.cos(phi);
        const sinPhi = Math.sin(phi);

        const dx = (cx - x) / 2;
        const dy = (cy - y) / 2;
        const x1 = cosPhi * dx + sinPhi * dy;
        const y1 = -sinPhi * dx + cosPhi * dy;

        // F.6.6: scale radii up when they are too small to span the endpoints.
        const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
        if (lambda > 1) {
            const grow = Math.sqrt(lambda);
            rx *= grow;
            ry *= grow;
        }

        const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
        const numerator = rx * rx * ry * ry - denominator;
        const factor = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator));
        const centreX1 = (factor * rx * y1) / ry;
        const centreY1 = (-factor * ry * x1) / rx;
        const centreX = cosPhi * centreX1 - sinPhi * centreY1 + (cx + x) / 2;
        const centreY = sinPhi * centreX1 + cosPhi * centreY1 + (cy + y) / 2;

        const angleBetween = (ux: number, uy: number, vx: number, vy: number) => {
            const length = Math.hypot(ux, uy) * Math.hypot(vx, vy);
            const cosine = length === 0 ? 1 : (ux * vx + uy * vy) / length;
            const angle = Math.acos(Math.min(1, Math.max(-1, cosine)));
            return ux * vy - uy * vx < 0 ? -angle : angle;
        };

        const startUx = (x1 - centreX1) / rx;
        const startUy = (y1 - centreY1) / ry;
        const endUx = (-x1 - centreX1) / rx;
        const endUy = (-y1 - centreY1) / ry;
        const theta = angleBetween(1, 0, startUx, startUy);
        let sweepAngle = angleBetween(startUx, startUy, endUx, endUy);
        if (!sweep && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
        else if (sweep && sweepAngle < 0) sweepAngle += 2 * Math.PI;

        // A cubic tracks an elliptical arc closely only over a short sweep; a
        // quarter turn is the usual cutoff and is well under a thousandth of a
        // radius in error.
        const segments = Math.max(1, Math.ceil(Math.abs(sweepAngle) / ARC_SEGMENT_MAX));
        const step = sweepAngle / segments;
        const handle = (4 / 3) * Math.tan(step / 4);

        let angle = theta;
        for (let s = 0; s < segments; s++) {
            const next = angle + step;
            const cos1 = Math.cos(angle);
            const sin1 = Math.sin(angle);
            const cos2 = Math.cos(next);
            const sin2 = Math.sin(next);

            const fromX = centreX + cosPhi * rx * cos1 - sinPhi * ry * sin1;
            const fromY = centreY + sinPhi * rx * cos1 + cosPhi * ry * sin1;
            const toX = centreX + cosPhi * rx * cos2 - sinPhi * ry * sin2;
            const toY = centreY + sinPhi * rx * cos2 + cosPhi * ry * sin2;

            const fromDx = handle * (-cosPhi * rx * sin1 - sinPhi * ry * cos1);
            const fromDy = handle * (-sinPhi * rx * sin1 + cosPhi * ry * cos1);
            const toDx = handle * (-cosPhi * rx * sin2 - sinPhi * ry * cos2);
            const toDy = handle * (-sinPhi * rx * sin2 + cosPhi * ry * cos2);

            emitCurve(fromX + fromDx, fromY + fromDy, toX - toDx, toY - toDy, toX, toY);
            angle = next;
        }
        // Land on the requested endpoint exactly, not on the arc's rounding of it.
        cx = x;
        cy = y;
    }

    let command = '';
    while (true) {
        skip();
        if (i >= d.length) break;

        const c = d[i];
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) {
            command = c;
            i++;
        } else if (!command) {
            throw new Unsupported('path data does not start with a command');
        } else if (command === 'M') {
            // A repeated argument set after a moveto is a lineto, per the spec.
            command = 'L';
        } else if (command === 'm') {
            command = 'l';
        }

        const relative = command >= 'a';
        const ox = relative ? cx : 0;
        const oy = relative ? cy : 0;
        // Annotated, not inferred: control-flow narrowing would otherwise chase
        // these into the S/T branches that assign back to them, and report the
        // pair as circular.
        const quadBefore: Control = lastQuad;
        const cubicBefore: Control = lastCubic;
        lastQuad = null;
        lastCubic = null;

        switch (command.toUpperCase()) {
            case 'M':
                emitMove(readNumber() + ox, readNumber() + oy);
                break;
            case 'L':
                emitLine(readNumber() + ox, readNumber() + oy);
                break;
            case 'H':
                emitLine(readNumber() + ox, cy);
                break;
            case 'V':
                emitLine(cx, readNumber() + oy);
                break;
            case 'C': {
                const x1 = readNumber() + ox, y1 = readNumber() + oy;
                const x2 = readNumber() + ox, y2 = readNumber() + oy;
                lastCubic = [x2, y2];
                emitCurve(x1, y1, x2, y2, readNumber() + ox, readNumber() + oy);
                break;
            }
            case 'S': {
                // The first control point mirrors the previous curve's second,
                // or coincides with the current point when there wasn't one.
                const x1 = cubicBefore ? 2 * cx - cubicBefore[0] : cx;
                const y1 = cubicBefore ? 2 * cy - cubicBefore[1] : cy;
                const x2 = readNumber() + ox, y2 = readNumber() + oy;
                lastCubic = [x2, y2];
                emitCurve(x1, y1, x2, y2, readNumber() + ox, readNumber() + oy);
                break;
            }
            case 'Q': {
                const qx: number = readNumber() + ox, qy: number = readNumber() + oy;
                lastQuad = [qx, qy];
                emitQuad(qx, qy, readNumber() + ox, readNumber() + oy);
                break;
            }
            case 'T': {
                const qx: number = quadBefore ? 2 * cx - quadBefore[0] : cx;
                const qy: number = quadBefore ? 2 * cy - quadBefore[1] : cy;
                lastQuad = [qx, qy];
                emitQuad(qx, qy, readNumber() + ox, readNumber() + oy);
                break;
            }
            case 'A': {
                const rx = readNumber(), ry = readNumber(), rotation = readNumber();
                const largeArc = readFlag(), sweep = readFlag();
                emitArc(rx, ry, rotation, largeArc, sweep, readNumber() + ox, readNumber() + oy);
                break;
            }
            case 'Z':
                out.push('Z');
                cx = startX;
                cy = startY;
                break;
            default:
                throw new Unsupported(`path command ${command} is not supported`);
        }

        // Further argument sets for the same command need no handling here: the
        // loop's next pass sees a digit rather than a letter and re-enters with
        // `command` unchanged, which is also where M→L is applied.
    }

    return out.join('');
}

/* ── Primitives → path data ─────────────────────────────────────────────── */

function num(el: Element, name: string, fallback = 0): number {
    const raw = el.getAttribute(name);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

/** An axis-aligned ellipse as two half-turn arcs — the standard SVG idiom. */
function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
    return `M${cx - rx},${cy}a${rx},${ry} 0 1,0 ${rx * 2},0a${rx},${ry} 0 1,0 ${-rx * 2},0Z`;
}

function pointsPath(el: Element, close: boolean): string {
    const pts = numbers(el.getAttribute('points') ?? '');
    if (pts.length < 4) throw new Unsupported('a polyline needs at least two points');
    let d = `M${pts[0]},${pts[1]}`;
    for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]},${pts[i + 1]}`;
    return close ? `${d}Z` : d;
}

function rectPath(el: Element): string {
    const x = num(el, 'x');
    const y = num(el, 'y');
    const w = num(el, 'width');
    const h = num(el, 'height');
    // SVG's rule: a missing radius mirrors the other one.
    let rx = el.hasAttribute('rx') ? num(el, 'rx') : num(el, 'ry');
    let ry = el.hasAttribute('ry') ? num(el, 'ry') : num(el, 'rx');
    rx = Math.min(rx, w / 2);
    ry = Math.min(ry, h / 2);
    if (!rx || !ry) return `M${x},${y}H${x + w}V${y + h}H${x}Z`;
    return `M${x + rx},${y}`
        + `H${x + w - rx}A${rx},${ry} 0 0,1 ${x + w},${y + ry}`
        + `V${y + h - ry}A${rx},${ry} 0 0,1 ${x + w - rx},${y + h}`
        + `H${x + rx}A${rx},${ry} 0 0,1 ${x},${y + h - ry}`
        + `V${y + ry}A${rx},${ry} 0 0,1 ${x + rx},${y}Z`;
}

/** The path data for a drawable element, or null if it draws nothing. */
function pathDataFor(el: Element): string | null {
    switch (el.tagName.toLowerCase()) {
        case 'path': {
            const d = el.getAttribute('d');
            return d && d.trim() ? d : null;
        }
        case 'rect':
            return rectPath(el);
        case 'circle': {
            const r = num(el, 'r');
            return r > 0 ? ellipsePath(num(el, 'cx'), num(el, 'cy'), r, r) : null;
        }
        case 'ellipse': {
            const rx = num(el, 'rx');
            const ry = num(el, 'ry');
            return rx > 0 && ry > 0 ? ellipsePath(num(el, 'cx'), num(el, 'cy'), rx, ry) : null;
        }
        case 'line':
            return `M${num(el, 'x1')},${num(el, 'y1')}L${num(el, 'x2')},${num(el, 'y2')}`;
        case 'polyline':
            return pointsPath(el, false);
        case 'polygon':
            return pointsPath(el, true);
        default:
            return null;
    }
}

/**
 * Elements that contribute nothing to the drawing and are safe to walk past.
 * `defs` and friends hold referenced content — anything that actually referenced
 * them has already thrown, in parseColor or on the clip-path check.
 */
const IGNORED = new Set(['defs', 'style', 'title', 'desc', 'metadata', 'clippath', 'mask', 'pattern',
    'lineargradient', 'radialgradient', 'filter', 'symbol', 'marker']);

/** Elements that draw something this translator cannot express. */
const RASTER_ONLY = new Set(['text', 'tspan', 'image', 'foreignobject', 'use', 'switch']);

/* ── Similarity decomposition ───────────────────────────────────────────── */

/**
 * pdf-lib's `drawSvgPath` accepts only translate + rotate + UNIFORM scale, so a
 * general affine matrix has to be rejected. That costs nothing in practice: a
 * tldraw shape's page transform is a translate and a rotation, and the one scale
 * it adds (`shape.props.scale`) is uniform — so every matrix seen here is a
 * similarity, and the check is a guard rather than a limitation.
 *
 * The sign flip is real, not a slip. `drawSvgPath` emits `scale(s, -s)` to get
 * SVG's y-down axis, and a rotation seen through that flip runs the other way,
 * so a clockwise SVG rotation is handed over as its negative.
 */
function decompose(m: Mat): { x: number; y: number; rotate: number; scale: number } {
    const [a, b, c, d, e, f] = m;
    const scale = Math.hypot(a, b);
    if (!Number.isFinite(scale) || scale < 1e-9) throw new Unsupported('degenerate transform');
    // Tolerance is relative: a stroke placed 800pt down the page carries matrix
    // entries whose float error dwarfs any fixed epsilon.
    const tolerance = scale * 1e-6;
    if (Math.abs(a - d) > tolerance || Math.abs(b + c) > tolerance) {
        throw new Unsupported('transform is not a rotation and uniform scale');
    }
    return { x: e, y: f, rotate: (-Math.atan2(b, a) * 180) / Math.PI, scale };
}

/* ── The walk ───────────────────────────────────────────────────────────── */

function walk(el: Element, matrix: Mat, paint: Paint, out: VectorOp[]): void {
    const tag = el.tagName.toLowerCase();
    if (IGNORED.has(tag)) return;
    if (RASTER_ONLY.has(tag)) throw new Unsupported(`<${tag}> cannot be drawn as a path`);

    // A shape inside a frame is exported with a clip path. Honouring that would
    // mean emitting a clipping content stream; dropping it would let strokes
    // escape their frame. Rasterize instead.
    if (el.getAttribute('clip-path') || el.getAttribute('mask')) {
        throw new Unsupported('clipped content cannot be drawn as a path');
    }

    const transform = el.getAttribute('transform');
    const here = transform ? compose(matrix, parseTransform(transform)) : matrix;
    const inherited = inherit(el, paint);

    const d = pathDataFor(el);
    if (d) {
        const fillOpacity = inherited.fillOpacity * inherited.groupOpacity;
        const strokeOpacity = inherited.strokeOpacity * inherited.groupOpacity;
        const fill = inherited.fill && fillOpacity > 0 ? inherited.fill : undefined;
        const stroke = inherited.stroke && strokeOpacity > 0 && inherited.strokeWidth > 0
            ? inherited.stroke
            : undefined;
        // A path that is neither filled nor stroked is invisible. Skipping it
        // matters: drawSvgPath with no colour at all falls through to a bare
        // closePath(), which leaves an unpainted path on the content stream.
        if (fill || stroke) {
            out.push({
                d: normalizePathData(d),
                ...decompose(here),
                fill,
                fillOpacity,
                stroke,
                strokeOpacity,
                strokeWidth: inherited.strokeWidth,
                dash: inherited.dash,
                lineCap: inherited.lineCap,
            });
        }
    }

    for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
        walk(child, here, inherited, out);
    }
}

/**
 * Translate one page's tldraw SVG export into draw operations positioned
 * relative to that page's top-left corner.
 *
 * @param svg   the string from `editor.getSvgString(shapes, { bounds: <the page
 *              box>, padding: 0, background: false, scale: 1 })`
 * @returns the operations, or **null** when the export contains something that
 *          cannot become a path — the caller must then rasterize the page.
 */
export function svgToVectorOps(svg: string): VectorOp[] | null {
    try {
        const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
        // A parse failure is reported as a document whose root is <parsererror>,
        // not by throwing.
        const root = doc.documentElement;
        if (!root || root.tagName.toLowerCase() !== 'svg') return null;

        // The export is positioned in tldraw PAGE space, and the viewBox says
        // which part of it this is — so subtracting the viewBox origin is what
        // puts a stroke at "37pt in from the left of page 4" rather than "1180pt
        // down the whole canvas". Read from the viewBox rather than from the
        // bounds we asked for, so a tldraw that ever trims or pads differently
        // stays correct.
        const [minX = 0, minY = 0, boxW = 0, boxH = 0] = numbers(root.getAttribute('viewBox') ?? '');
        // The viewBox is also a scale whenever width/height disagree with it.
        // Callers ask for scale 1, so this is normally exactly 1 — but reading it
        // means an export at another scale is positioned correctly rather than
        // silently shrunk into the page's top-left corner.
        const width = Number(root.getAttribute('width'));
        const height = Number(root.getAttribute('height'));
        const sx = boxW > 0 && Number.isFinite(width) && width > 0 ? width / boxW : 1;
        const sy = boxH > 0 && Number.isFinite(height) && height > 0 ? height / boxH : 1;
        if (Math.abs(sx - sy) > 1e-6) throw new Unsupported('non-uniform viewBox scale');
        const origin: Mat = [sx, 0, 0, sx, -minX * sx, -minY * sx];

        const ops: VectorOp[] = [];
        // From the root itself, not its children: <svg> carries the
        // stroke-linecap="round" every stroked path in the export inherits.
        walk(root, origin, ROOT_PAINT, ops);
        return ops;
    } catch (err) {
        if (err instanceof Unsupported) return null;
        console.warn('Could not vectorize annotations; falling back to a raster overlay:', err);
        return null;
    }
}
