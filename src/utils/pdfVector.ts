export interface VectorRgb {
    r: number;
    g: number;
    b: number;
}

export interface VectorOp {
    d: string;
    x: number;
    y: number;
    rotate: number;
    scale: number;
    fill?: VectorRgb;
    fillOpacity: number;
    stroke?: VectorRgb;
    strokeOpacity: number;
    strokeWidth: number;
    dash?: number[];
    lineCap: 0 | 1 | 2;
}

type Mat = readonly [number, number, number, number, number, number];

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

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
                if (args.length >= 3) {
                    const [, cx, cy] = args;
                    out = compose(out, compose([1, 0, 0, 1, cx, cy], compose(rot, [1, 0, 0, 1, -cx, -cy])));
                } else {
                    out = compose(out, rot);
                }
                break;
            }
            default:
                throw new Unsupported(`transform ${m[1]}() is not supported`);
        }
    }
    return out;
}

const NAMED: Record<string, VectorRgb> = {
    black: { r: 0, g: 0, b: 0 },
    white: { r: 1, g: 1, b: 1 },
};

function parseColor(raw: string): VectorRgb | null {
    const value = raw.trim().toLowerCase();
    if (!value || value === 'none' || value === 'transparent') return null;

    if (value.startsWith('#')) {
        const hex = value.slice(1);
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
    throw new Unsupported(`colour ${raw} is not supported`);
}

interface Paint {
    fill: VectorRgb | null;
    stroke: VectorRgb | null;
    fillOpacity: number;
    strokeOpacity: number;
    groupOpacity: number;
    strokeWidth: number;
    dash?: number[];
    lineCap: 0 | 1 | 2;
}

const ROOT_PAINT: Paint = {
    fill: { r: 0, g: 0, b: 0 },
    stroke: null,
    fillOpacity: 1,
    strokeOpacity: 1,
    groupOpacity: 1,
    strokeWidth: 1,
    lineCap: 0,
};

const LINE_CAPS: Record<string, 0 | 1 | 2> = { butt: 0, round: 1, square: 2 };

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

function round(n: number): number {
    return Math.round(n * 1000) / 1000;
}

const ARC_SEGMENT_MAX = Math.PI / 2;

type Control = readonly [number, number] | null;

function normalizePathData(d: string): string {
    let i = 0;
    const out: string[] = [];

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

    function emitQuad(qx: number, qy: number, x: number, y: number): void {
        emitCurve(
            cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy),
            x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y),
            x, y,
        );
    }

    function emitArc(rx: number, ry: number, rotation: number, largeArc: boolean, sweep: boolean, x: number, y: number): void {
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
            command = 'L';
        } else if (command === 'm') {
            command = 'l';
        }

        const relative = command >= 'a';
        const ox = relative ? cx : 0;
        const oy = relative ? cy : 0;
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
    }

    return out.join('');
}

function num(el: Element, name: string, fallback = 0): number {
    const raw = el.getAttribute(name);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

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

const IGNORED = new Set(['defs', 'style', 'title', 'desc', 'metadata', 'clippath', 'mask', 'pattern',
    'lineargradient', 'radialgradient', 'filter', 'symbol', 'marker']);

const RASTER_ONLY = new Set(['text', 'tspan', 'image', 'foreignobject', 'use', 'switch']);

function decompose(m: Mat): { x: number; y: number; rotate: number; scale: number } {
    const [a, b, c, d, e, f] = m;
    const scale = Math.hypot(a, b);
    if (!Number.isFinite(scale) || scale < 1e-9) throw new Unsupported('degenerate transform');
    const tolerance = scale * 1e-6;
    if (Math.abs(a - d) > tolerance || Math.abs(b + c) > tolerance) {
        throw new Unsupported('transform is not a rotation and uniform scale');
    }
    return { x: e, y: f, rotate: (-Math.atan2(b, a) * 180) / Math.PI, scale };
}

function walk(el: Element, matrix: Mat, paint: Paint, out: VectorOp[]): void {
    const tag = el.tagName.toLowerCase();
    if (IGNORED.has(tag)) return;
    if (RASTER_ONLY.has(tag)) throw new Unsupported(`<${tag}> cannot be drawn as a path`);

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

export function svgToVectorOps(svg: string): VectorOp[] | null {
    try {
        const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
        const root = doc.documentElement;
        if (!root || root.tagName.toLowerCase() !== 'svg') return null;

        const [minX = 0, minY = 0, boxW = 0, boxH = 0] = numbers(root.getAttribute('viewBox') ?? '');
        const width = Number(root.getAttribute('width'));
        const height = Number(root.getAttribute('height'));
        const sx = boxW > 0 && Number.isFinite(width) && width > 0 ? width / boxW : 1;
        const sy = boxH > 0 && Number.isFinite(height) && height > 0 ? height / boxH : 1;
        if (Math.abs(sx - sy) > 1e-6) throw new Unsupported('non-uniform viewBox scale');
        const origin: Mat = [sx, 0, 0, sx, -minX * sx, -minY * sx];

        const ops: VectorOp[] = [];
        walk(root, origin, ROOT_PAINT, ops);
        return ops;
    } catch (err) {
        if (err instanceof Unsupported) return null;
        console.warn('Could not vectorize annotations; falling back to a raster overlay:', err);
        return null;
    }
}
