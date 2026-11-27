import type { Affine, PathCommand } from '../types';
import type { EmbedClippedCoverage, EmbedCoveragePath, EmbedPresentedNode } from './embedPresentation.types';

const SVG = 'http://www.w3.org/2000/svg';
export interface EmbedClipDom {
    readonly definitions: SVGSVGElement;
    readonly shield: SVGSVGElement;
    readonly clipUrl: string | null;
    readonly maskUrl: string;
    dispose(): void;
}
function svg<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
    return document.createElementNS(SVG, name);
}
function matrix(value: Affine): string {
    if (!value.every(Number.isFinite)) throw new RangeError('Invalid embed coverage transform');
    return `matrix(${value.join(' ')})`;
}
function* pathData(commands: readonly Readonly<PathCommand>[]): Generator<void, string> {
    const parts: string[] = [];
    let count = 0, started = performance.now();
    for (const command of commands) {
        const op = command[0];
        const expected = op === 'Z' ? 1 : op === 'C' ? 7 : op === 'M' || op === 'L' ? 3 : 0;
        if (!expected || command.length !== expected) throw new TypeError('Invalid embed coverage path');
        for (let i = 1; i < command.length; i++) if (!Number.isFinite(command[i])) throw new RangeError('Invalid embed coverage coordinate');
        parts.push(op === 'Z' ? op : `${op} ${command.slice(1).join(' ')}`);
        if (++count >= 64 || performance.now() - started >= 0.25) { yield; count = 0; started = performance.now(); }
    }
    yield;
    return parts.join(' ');
}

export function* createEmbedClipJob(node: EmbedPresentedNode,
    viewport: Readonly<{ width: number; height: number }>): Generator<void, EmbedClipDom> {
    if (![viewport.width, viewport.height, node.rect.x, node.rect.y, node.rect.width, node.rect.height].every(Number.isFinite) ||
        viewport.width < 0 || viewport.height < 0 || node.rect.width < 0 || node.rect.height < 0) throw new RangeError('Invalid embed presentation bounds');
    const prefix = `embed-${crypto.randomUUID()}`;
    let serial = 0;
    const definitions = svg('svg');
    definitions.setAttribute('aria-hidden', 'true');
    definitions.setAttribute('width', '0'); definitions.setAttribute('height', '0');
    definitions.style.position = 'absolute'; definitions.style.pointerEvents = 'none'; definitions.style.overflow = 'hidden';
    const defs = svg('defs'); definitions.append(defs);
    const shield = svg('svg');
    shield.setAttribute('aria-hidden', 'true');
    shield.setAttribute('width', String(viewport.width)); shield.setAttribute('height', String(viewport.height));
    shield.setAttribute('viewBox', `0 0 ${viewport.width} ${viewport.height}`);
    shield.style.position = 'absolute'; shield.style.inset = '0'; shield.style.pointerEvents = 'none';
    const makePath = function* (path: EmbedCoveragePath): Generator<void, SVGPathElement> {
        if (path.fillRule !== 'nonzero' && path.fillRule !== 'evenodd') throw new TypeError('Invalid embed coverage fill rule');
        const d = yield* pathData(path.d);
        const element = svg('path'); element.setAttribute('d', d);
        element.setAttribute('transform', matrix(path.toPane)); element.setAttribute('fill-rule', path.fillRule);
        element.setAttribute('clip-rule', path.fillRule);
        return element;
    };
    const setCoverage = function* (shape: SVGPathElement, coverage: EmbedClippedCoverage): Generator<void, void> {
        if (coverage.fill !== undefined && typeof coverage.fill !== 'boolean') throw new TypeError('Invalid embed coverage fill');
        shape.setAttribute('fill', coverage.fill === false ? 'none' : 'black');
        const stroke = coverage.stroke;
        if (!stroke) { shape.setAttribute('stroke', 'none'); return; }
        if (!Number.isFinite(stroke.width) || stroke.width <= 0 || !Number.isFinite(stroke.miterLimit) || stroke.miterLimit <= 0 ||
            (stroke.dashPhase !== undefined && !Number.isFinite(stroke.dashPhase)) ||
            !['butt', 'round', 'square'].includes(stroke.cap) || !['miter', 'round', 'bevel'].includes(stroke.join)) {
            throw new RangeError('Invalid embed coverage stroke');
        }
        shape.setAttribute('stroke', 'black'); shape.setAttribute('stroke-width', String(stroke.width));
        shape.setAttribute('stroke-linecap', stroke.cap); shape.setAttribute('stroke-linejoin', stroke.join);
        shape.setAttribute('stroke-miterlimit', String(stroke.miterLimit));
        if (stroke.dash?.length) {
            const parts: string[] = []; let count = 0, started = performance.now();
            for (const value of stroke.dash) {
                if (!Number.isFinite(value) || value < 0) throw new RangeError('Invalid embed coverage dash');
                parts.push(String(value));
                if (++count >= 64 || performance.now() - started >= 0.25) { yield; count = 0; started = performance.now(); }
            }
            yield;
            shape.setAttribute('stroke-dasharray', parts.join(' '));
        }
        shape.setAttribute('stroke-dashoffset', String(stroke.dashPhase ?? 0));
    };
    const clip = function* (path: EmbedCoveragePath, previous: string | null): Generator<void, string> {
        const element = svg('clipPath'), id = `${prefix}-clip-${serial++}`;
        element.setAttribute('id', id); element.setAttribute('clipPathUnits', 'userSpaceOnUse');
        const shape = yield* makePath(path);
        if (previous) { const group = svg('g'); group.setAttribute('clip-path', previous); group.append(shape); element.append(group); }
        else element.append(shape);
        defs.append(element); return `url(#${id})`;
    };
    let clipUrl: string | null = null;
    for (const path of node.clips) clipUrl = yield* clip(path, clipUrl);
    const r = node.rect;
    const quad: EmbedCoveragePath = { d: [['M', r.x, r.y], ['L', r.x + r.width, r.y],
        ['L', r.x + r.width, r.y + r.height], ['L', r.x, r.y + r.height], ['Z']], fillRule: 'nonzero', toPane: node.toPane };
    const shieldClip = yield* clip(quad, clipUrl);
    const mask = svg('mask'), maskId = `${prefix}-mask`;
    mask.setAttribute('id', maskId); mask.setAttribute('maskUnits', 'userSpaceOnUse'); mask.setAttribute('maskContentUnits', 'userSpaceOnUse');
    mask.setAttribute('mask-type', 'luminance'); mask.setAttribute('x', '0'); mask.setAttribute('y', '0');
    mask.setAttribute('width', String(viewport.width)); mask.setAttribute('height', String(viewport.height));
    const white = svg('rect'); white.setAttribute('x', '0'); white.setAttribute('y', '0');
    white.setAttribute('width', String(viewport.width)); white.setAttribute('height', String(viewport.height)); white.setAttribute('fill', 'white');
    mask.append(white); defs.append(mask);
    for (const later of node.laterPaint) {
        if (later.opacity !== 'opaque') continue;
        let maskClip: string | null = null, pointerClip: string | null = shieldClip;
        for (const path of later.coverage.clips) {
            maskClip = yield* clip(path, maskClip);
            pointerClip = yield* clip(path, pointerClip);
        }
        const shape = yield* makePath(later.coverage.path);
        yield* setCoverage(shape, later.coverage);
        if (maskClip) shape.setAttribute('clip-path', maskClip);
        mask.append(shape);
        const pointer = shape.cloneNode(false) as SVGPathElement;
        if (later.coverage.fill !== false) pointer.setAttribute('fill', 'transparent');
        if (later.coverage.stroke) pointer.setAttribute('stroke', 'transparent');
        pointer.setAttribute('pointer-events', 'painted');
        pointer.setAttribute('clip-path', pointerClip!); shield.append(pointer);
        yield;
    }
    let disposed = false;
    return { definitions, shield, clipUrl, maskUrl: `url(#${maskId})`, dispose() {
        if (disposed) return; disposed = true; shield.remove(); definitions.remove();
    } };
}
