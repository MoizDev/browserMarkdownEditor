import { JsonReadError, parseJsonIncremental } from '../format/jsonRead';
import { prepareFigureGeometry, prepareFrameGeometry, prepareMediaBoxGeometry, preparePolylineGeometry,
    prepareStickyGeometry, prepareTextGeometry } from '../geom/providers';
import type { ContainerGeometry, FigureGeometry, PolylineGeometry, PositionedFigureText, TextGeometry } from '../geom/providers';
import type { FigureNode, Node, OpaqueNode } from '../model/nodes';
import type { BoardTextGeometry } from './textGeometry';
import { yieldToHost } from '../../platform/yieldToHost';

// Provenance: geometry providers, shared text request and opaque-record contracts;
// independent composition, no third-party source.
export type BoardVectorGeometry = FigureGeometry | TextGeometry | ContainerGeometry | PolylineGeometry;
// Bounded v1 kernel policy: 0.01 world-unit curve/length error, 0.01 CSS-pixel
// picking error, four CSS pixels of hit margin, and at most 8192 path pieces.
const BUDGET = { kernelVersion: 1, pathError: 0.01, lengthError: 0.01,
    maxPieces: 8192, hitMarginCss: 4, hitErrorCss: 0.01 } as const;
function check(signal: AbortSignal): void { signal.throwIfAborted(); }
function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error('Text geometry epoch does not match prepared paint');
    return value;
}

type VectorNode = Exclude<Node, { kind: 'group' | 'stroke' | 'connector' | 'opaque' }>;
interface VectorOptions { readonly text: BoardTextGeometry; readonly revision: string; readonly zoom: number }
function requireVector(node: Readonly<Node>, zoom: number): asserts node is Readonly<VectorNode> {
    if (!Number.isFinite(zoom) || zoom <= 0) throw new RangeError('Invalid geometry zoom');
    if (node.kind === 'group' || node.kind === 'stroke' || node.kind === 'connector' || node.kind === 'opaque') {
        throw new TypeError(`Vector geometry does not own ${node.kind}`);
    }
}
function needsText(node: Readonly<VectorNode>): boolean {
    return node.kind === 'text' || node.kind === 'sticky' || node.kind === 'frame' || node.kind === 'embed'
        || node.kind === 'linkcard' || (node.kind === 'figure' && !!node.label);
}
function positioned(prepared: ReturnType<BoardTextGeometry['prepareNow']>): PositionedFigureText {
    if (!prepared) throw new Error('Text-bearing node has no prepared text');
    return { paint: prepared.paint, x: prepared.placement.x, y: prepared.placement.y, scale: prepared.placement.scale };
}
function vectorGeometry(node: Readonly<VectorNode>, options: VectorOptions, label: PositionedFigureText | null): BoardVectorGeometry {
    const fontEpoch = label?.paint.fontEpoch ?? 0;
    const key = JSON.stringify([node.id, options.revision, options.zoom, fontEpoch]);
    const common = { key, fontEpoch, pathError: BUDGET.pathError, maxPieces: BUDGET.maxPieces,
        hitMarginCss: BUDGET.hitMarginCss, hitErrorCss: BUDGET.hitErrorCss, text: label };
    switch (node.kind) {
        case 'figure': return required(prepareFigureGeometry(node, { ...BUDGET, key, fontEpoch, label }));
        case 'text': return required(prepareTextGeometry(node, label!.paint,
            { key, fontEpoch, hitErrorCss: BUDGET.hitErrorCss, maxSegments: BUDGET.maxPieces }));
        case 'sticky': return required(prepareStickyGeometry(node, common));
        case 'frame': return required(prepareFrameGeometry(node, common));
        case 'picture': case 'clip': case 'linkcard': case 'embed': return required(prepareMediaBoxGeometry(node, common));
        case 'polyline': return preparePolylineGeometry(node, { ...BUDGET, key });
    }
}

/** Current actual faces, including browser fallback; this does not start font loading. */
export function prepareBoardVectorGeometryNow(node: Readonly<Node>, options: VectorOptions): BoardVectorGeometry {
    requireVector(node, options.zoom);
    const label = needsText(node) ? positioned(options.text.prepareNow(node, { revision: options.revision, zoom: options.zoom })) : null;
    return vectorGeometry(node, options, label);
}

export async function prepareBoardVectorGeometry(node: Readonly<Node>, options: VectorOptions & {
    signal: AbortSignal; cooperate?: () => Promise<void>;
}): Promise<BoardVectorGeometry> {
    const { signal } = options;
    check(signal); requireVector(node, options.zoom);
    let label: PositionedFigureText | null = null;
    if (needsText(node)) {
        label = positioned(await options.text.prepare(node, { revision: options.revision, zoom: options.zoom }, signal));
        check(signal);
    }
    await (options.cooperate?.() ?? yieldToHost());
    check(signal);
    return vectorGeometry(node, options, label);
}

/** The preserved source stays inert; unreadable dimensions use the opaque placeholder default. */
export async function prepareOpaqueGeometry(node: Readonly<OpaqueNode>, signal: AbortSignal,
    cooperate?: () => Promise<void>): Promise<FigureGeometry> {
    const tick = async () => {
        check(signal); await (cooperate?.() ?? yieldToHost()); check(signal);
    };
    await tick();
    let w = 100, h = 100;
    try {
        const raw = await parseJsonIncremental(node.raw, tick);
        if (raw.kind === 'object') {
            for await (const [key, value] of raw.fieldsIncremental(tick)) {
                check(signal);
                if ((key === 'w' || key === 'h') && value.kind === 'number') {
                    const n = value.number();
                    if (Number.isFinite(n) && n > 0 && n <= 1_000_000) { if (key === 'w') w = n; else h = n; }
                }
            }
        }
    } catch (error) {
        check(signal);
        if (!(error instanceof JsonReadError)) throw error;
    }
    check(signal);
    const placeholder: FigureNode = { ...node, kind: 'figure', shape: 'rectangle', w, h, growY: 0,
        color: 'grey', labelColor: 'grey', fill: 'none', dash: 'dashed', size: 's', font: 'sans',
        align: 'middle', valign: 'middle', label: null, width: 1, labelScale: 1, flipX: false, flipY: false, url: null };
    const geometry = required(prepareFigureGeometry(placeholder, { ...BUDGET, key: `opaque:${node.id}`, fontEpoch: 0, label: null }));
    return { ...geometry, attachments: null };
}
