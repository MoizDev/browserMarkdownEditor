import { JsonReadError, parseJsonIncremental } from '../format/jsonRead';
import { prepareFigureGeometry, prepareFrameGeometry, prepareMediaBoxGeometry, preparePolylineGeometry,
    prepareStickyGeometry, prepareTextGeometry } from '../geom/providers';
import type { ContainerGeometry, FigureGeometry, PolylineGeometry, PositionedFigureText, TextGeometry } from '../geom/providers';
import type { FigureNode, Node, OpaqueNode } from '../model/nodes';
import type { BoardTextGeometry } from './textGeometry';

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

export async function prepareBoardVectorGeometry(node: Readonly<Node>, options: {
    text: BoardTextGeometry; revision: string; zoom: number; signal: AbortSignal; cooperate?: () => Promise<void>;
}): Promise<BoardVectorGeometry> {
    const { signal } = options;
    check(signal);
    if (!Number.isFinite(options.zoom) || options.zoom <= 0) throw new RangeError('Invalid geometry zoom');
    if (node.kind === 'group' || node.kind === 'stroke' || node.kind === 'connector' || node.kind === 'opaque') {
        throw new TypeError(`Vector geometry does not own ${node.kind}`);
    }
    let label: PositionedFigureText | null = null;
    if (node.kind === 'text' || node.kind === 'sticky' || node.kind === 'frame' || (node.kind === 'figure' && node.label)) {
        const prepared = await options.text.prepare(node, { revision: options.revision, zoom: options.zoom }, signal);
        check(signal);
        if (!prepared) throw new Error('Text-bearing node has no prepared text');
        label = { paint: prepared.paint, x: prepared.placement.x, y: prepared.placement.y, scale: prepared.placement.scale };
    }
    await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
    check(signal);
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

/** The preserved source stays inert; unreadable dimensions use the opaque placeholder default. */
export async function prepareOpaqueGeometry(node: Readonly<OpaqueNode>, signal: AbortSignal,
    cooperate?: () => Promise<void>): Promise<FigureGeometry> {
    const tick = async () => {
        check(signal); await (cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0))); check(signal);
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
