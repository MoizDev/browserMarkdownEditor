import type { NodeId, ParentId } from './ids';
import type { ExtBag, RawJson } from './json';
import type { MediaId } from './media';
import type { OrderKey } from './orderKey';
import type { SampleRef } from './samples';
import type {
    Arrowhead, Dash, FigureShape, Fill, Font, HAlign, Size, Swatch, TextAlign, VAlign,
} from './styles';
import type { RichText } from '../text/richText';
import { COMMON_NODE_DEFAULTS, NODE_DEFAULTS } from './defaults';

// document-model.md §3, M-3/M-10: closed records, with one field layout per kind.
export interface NodeBase {
    readonly id: NodeId;
    readonly kind: NodeKind;
    readonly parent: ParentId;
    readonly order: OrderKey;
    readonly page: number; // Only sheet-root nodes on paged boards have page >= 0 (M-6).
    readonly x: number;
    readonly y: number;
    readonly rotation: number;
    readonly locked: boolean;
    readonly opacity: number;
    readonly ext: ExtBag | null;
}

// ink.md §4; R-W8: rMax is radius at pressure 1, not a ceiling for imported pressure.
export type WidthModel =
    | { readonly id: 'uniform' }
    | { readonly id: 'pressure-linear-v1'; readonly rMin: number; readonly rMax: number };

export interface StrokeNode extends NodeBase {
    readonly kind: 'stroke';
    readonly tool: 'pen' | 'highlighter';
    readonly samples: SampleRef;
    readonly pressure: 'real' | 'none';
    readonly widthModel: WidthModel;
    readonly geomVersion: number;
    readonly fairTol: number;
    readonly closed: boolean;
    readonly width: number;
    readonly sx: number;
    readonly sy: number;
    readonly color: Swatch;
    readonly fill: Fill;
    readonly dash: Dash;
    readonly complete: boolean;
}

export interface FigureNode extends NodeBase {
    readonly kind: 'figure';
    readonly shape: FigureShape;
    readonly w: number;
    readonly h: number;
    readonly growY: number;
    readonly color: Swatch;
    readonly labelColor: Swatch;
    readonly fill: Fill;
    readonly dash: Dash;
    readonly size: Size;
    readonly font: Font;
    readonly align: HAlign;
    readonly valign: VAlign;
    readonly label: RichText | null;
    readonly width: number;
    readonly labelScale: number;
    readonly flipX: boolean;
    readonly flipY: boolean;
    readonly url: string | null;
}

export interface TextNode extends NodeBase {
    readonly kind: 'text';
    readonly text: RichText;
    readonly color: Swatch;
    readonly size: Size;
    readonly font: Font;
    readonly align: TextAlign;
    readonly autoSize: boolean;
    readonly w: number;
    readonly scale: number;
}

export interface StickyNode extends NodeBase {
    readonly kind: 'sticky';
    readonly text: RichText;
    readonly color: Swatch;
    readonly labelColor: Swatch;
    readonly size: Size;
    readonly font: Font;
    readonly align: HAlign;
    readonly valign: VAlign;
    readonly growY: number;
    readonly fit: number | null;
    readonly scale: number;
    readonly url: string | null;
}

export interface Point { readonly x: number; readonly y: number }
export interface Attachment {
    readonly target: NodeId;
    readonly anchor: Point;
    readonly exact: boolean;
    readonly precise: boolean;
    readonly snap: 'none' | 'center' | 'edge-point' | 'edge';
}
export interface ConnectorEnd extends Point { readonly attach: Attachment | null }

export interface ConnectorNode extends NodeBase {
    readonly kind: 'connector';
    readonly route: 'arc' | 'elbow';
    readonly start: ConnectorEnd;
    readonly end: ConnectorEnd;
    readonly bend: number;
    readonly elbowMid: number;
    readonly headStart: Arrowhead;
    readonly headEnd: Arrowhead;
    readonly color: Swatch;
    readonly labelColor: Swatch;
    readonly fill: Fill;
    readonly dash: Dash;
    readonly size: Size;
    readonly font: Font;
    readonly label: RichText | null;
    readonly labelAt: number;
    readonly width: number;
    readonly labelScale: number;
}

export interface PolylineNode extends NodeBase {
    readonly kind: 'polyline';
    readonly points: readonly Point[];
    readonly spline: 'line' | 'cubic';
    readonly color: Swatch;
    readonly dash: Dash;
    readonly size: Size;
    readonly width: number;
}

export interface FrameNode extends NodeBase {
    readonly kind: 'frame';
    readonly w: number;
    readonly h: number;
    readonly name: string;
    readonly color: Swatch | null;
}
export interface GroupNode extends NodeBase { readonly kind: 'group' }

export interface Crop {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
    readonly circle: boolean;
}
export interface PictureNode extends NodeBase {
    readonly kind: 'picture';
    readonly w: number;
    readonly h: number;
    readonly media: MediaId | null;
    readonly crop: Crop | null;
    readonly flipX: boolean;
    readonly flipY: boolean;
    readonly alt: string;
    readonly inverted: boolean;
    readonly playing: boolean;
    readonly url: string | null;
}

export interface ClipNode extends NodeBase {
    readonly kind: 'clip';
    readonly w: number;
    readonly h: number;
    readonly media: MediaId | null;
    readonly time: number;
    readonly playing: boolean;
    readonly autoplay: boolean;
    readonly alt: string;
}
export interface LinkPreview {
    readonly title: string;
    readonly description: string;
    readonly image: MediaId | null;
    readonly favicon: MediaId | null;
}
export interface LinkcardNode extends NodeBase {
    readonly kind: 'linkcard';
    readonly w: number;
    readonly h: number;
    readonly url: string;
    readonly preview: LinkPreview | null;
}
export interface EmbedNode extends NodeBase {
    readonly kind: 'embed';
    readonly w: number;
    readonly h: number;
    readonly url: string;
}
export interface OpaqueNode extends NodeBase {
    readonly kind: 'opaque';
    readonly locked: true;
    readonly raw: RawJson;
}

export type Node = StrokeNode | FigureNode | TextNode | StickyNode | ConnectorNode | PolylineNode
    | FrameNode | GroupNode | PictureNode | ClipNode | LinkcardNode | EmbedNode | OpaqueNode;
export type NodeKind = Node['kind'];
export type NodeRecord = Node;
export type NodeTable = ReadonlyMap<NodeId, Readonly<Node>>;

type NodeOf<K extends NodeKind> = Extract<Node, { readonly kind: K }>;
type CommonDefaults<K extends NodeKind> = K extends 'opaque'
    ? Exclude<keyof typeof COMMON_NODE_DEFAULTS, 'locked'> : keyof typeof COMMON_NODE_DEFAULTS;
type DefaultKeys<K extends NodeKind> = Extract<CommonDefaults<K> | keyof typeof NODE_DEFAULTS[K], keyof NodeOf<K>>;
export type NodeInput<K extends NodeKind> = Omit<NodeOf<K>, 'kind' | DefaultKeys<K>>
    & Partial<Pick<NodeOf<K>, DefaultKeys<K>>>;

// M-10: explicit literals, never a caller-record spread, keep every kind's field
// order fixed. Samples, rich text and other immutable values are retained by reference.
export function createStroke(p: NodeInput<'stroke'>): StrokeNode {
    return {
        id: p.id, kind: 'stroke', parent: p.parent, order: p.order, page: p.page,
        x: p.x, y: p.y, rotation: p.rotation ?? COMMON_NODE_DEFAULTS.rotation,
        locked: p.locked ?? COMMON_NODE_DEFAULTS.locked,
        opacity: p.opacity ?? COMMON_NODE_DEFAULTS.opacity, ext: p.ext,
        tool: p.tool, samples: p.samples, pressure: p.pressure,
        widthModel: p.widthModel, geomVersion: p.geomVersion, fairTol: p.fairTol,
        closed: p.closed ?? NODE_DEFAULTS.stroke.closed, width: p.width,
        sx: p.sx ?? NODE_DEFAULTS.stroke.sx, sy: p.sy ?? NODE_DEFAULTS.stroke.sy,
        color: p.color ?? NODE_DEFAULTS.stroke.color,
        fill: p.fill ?? NODE_DEFAULTS.stroke.fill,
        dash: p.dash ?? NODE_DEFAULTS.stroke.dash,
        complete: p.complete ?? NODE_DEFAULTS.stroke.complete,
    };
}

export function createFigure(p: NodeInput<'figure'>): FigureNode {
    return {
        id: p.id, kind: 'figure', parent: p.parent, order: p.order, page: p.page,
        x: p.x, y: p.y, rotation: p.rotation ?? COMMON_NODE_DEFAULTS.rotation,
        locked: p.locked ?? COMMON_NODE_DEFAULTS.locked,
        opacity: p.opacity ?? COMMON_NODE_DEFAULTS.opacity, ext: p.ext,
        shape: p.shape, w: p.w, h: p.h, growY: p.growY,
        color: p.color, labelColor: p.labelColor, fill: p.fill, dash: p.dash,
        size: p.size, font: p.font, align: p.align, valign: p.valign, label: p.label,
        width: p.width, labelScale: p.labelScale ?? NODE_DEFAULTS.figure.labelScale,
        flipX: p.flipX, flipY: p.flipY, url: p.url,
    };
}

export function createText(p: NodeInput<'text'>): TextNode {
    return {
        id: p.id, kind: 'text', parent: p.parent, order: p.order, page: p.page,
        x: p.x, y: p.y, rotation: p.rotation ?? COMMON_NODE_DEFAULTS.rotation,
        locked: p.locked ?? COMMON_NODE_DEFAULTS.locked,
        opacity: p.opacity ?? COMMON_NODE_DEFAULTS.opacity, ext: p.ext,
        text: p.text, color: p.color, size: p.size, font: p.font, align: p.align,
        autoSize: p.autoSize ?? NODE_DEFAULTS.text.autoSize, w: p.w, scale: p.scale,
    };
}

export function createSticky(p: NodeInput<'sticky'>): StickyNode {
    return {
        id: p.id, kind: 'sticky', parent: p.parent, order: p.order, page: p.page,
        x: p.x, y: p.y, rotation: p.rotation ?? COMMON_NODE_DEFAULTS.rotation,
        locked: p.locked ?? COMMON_NODE_DEFAULTS.locked,
        opacity: p.opacity ?? COMMON_NODE_DEFAULTS.opacity, ext: p.ext,
        text: p.text, color: p.color ?? NODE_DEFAULTS.sticky.color,
        labelColor: p.labelColor ?? NODE_DEFAULTS.sticky.labelColor,
        size: p.size, font: p.font, align: p.align, valign: p.valign,
        growY: p.growY, fit: p.fit, scale: p.scale, url: p.url,
    };
}

export function createConnector(p: NodeInput<'connector'>): ConnectorNode {
    return {
        id: p.id, kind: 'connector', parent: p.parent, order: p.order, page: p.page,
        x: p.x, y: p.y, rotation: p.rotation ?? COMMON_NODE_DEFAULTS.rotation,
        locked: p.locked ?? COMMON_NODE_DEFAULTS.locked,
        opacity: p.opacity ?? COMMON_NODE_DEFAULTS.opacity, ext: p.ext,
        route: p.route, start: p.start, end: p.end, bend: p.bend,
        elbowMid: p.elbowMid ?? NODE_DEFAULTS.connector.elbowMid,
        headStart: p.headStart ?? NODE_DEFAULTS.connector.headStart,
        headEnd: p.headEnd ?? NODE_DEFAULTS.connector.headEnd,
        color: p.color, labelColor: p.labelColor, fill: p.fill, dash: p.dash,
        size: p.size, font: p.font, label: p.label,
        labelAt: p.labelAt ?? NODE_DEFAULTS.connector.labelAt, width: p.width,
        labelScale: p.labelScale ?? NODE_DEFAULTS.connector.labelScale,
    };
}

export function createPolyline(p: NodeInput<'polyline'>): PolylineNode {
    return {
        id: p.id, kind: 'polyline', parent: p.parent, order: p.order, page: p.page,
        x: p.x, y: p.y, rotation: p.rotation ?? COMMON_NODE_DEFAULTS.rotation,
        locked: p.locked ?? COMMON_NODE_DEFAULTS.locked,
        opacity: p.opacity ?? COMMON_NODE_DEFAULTS.opacity, ext: p.ext,
        points: p.points, spline: p.spline, color: p.color, dash: p.dash,
        size: p.size, width: p.width,
    };
}

export function createFrame(p: NodeInput<'frame'>): FrameNode {
    return {
        id: p.id, kind: 'frame', parent: p.parent, order: p.order, page: p.page,
        x: p.x, y: p.y, rotation: p.rotation ?? COMMON_NODE_DEFAULTS.rotation,
        locked: p.locked ?? COMMON_NODE_DEFAULTS.locked,
        opacity: p.opacity ?? COMMON_NODE_DEFAULTS.opacity, ext: p.ext,
        w: p.w, h: p.h, name: p.name, color: p.color,
    };
}

export function createGroup(p: NodeInput<'group'>): GroupNode {
    return {
        id: p.id, kind: 'group', parent: p.parent, order: p.order, page: p.page,
        x: p.x, y: p.y, rotation: p.rotation ?? COMMON_NODE_DEFAULTS.rotation,
        locked: p.locked ?? COMMON_NODE_DEFAULTS.locked,
        opacity: p.opacity ?? COMMON_NODE_DEFAULTS.opacity, ext: p.ext,
    };
}

export function createPicture(p: NodeInput<'picture'>): PictureNode {
    return {
        id: p.id, kind: 'picture', parent: p.parent, order: p.order, page: p.page,
        x: p.x, y: p.y, rotation: p.rotation ?? COMMON_NODE_DEFAULTS.rotation,
        locked: p.locked ?? COMMON_NODE_DEFAULTS.locked,
        opacity: p.opacity ?? COMMON_NODE_DEFAULTS.opacity, ext: p.ext,
        w: p.w, h: p.h, media: p.media, crop: p.crop, flipX: p.flipX, flipY: p.flipY,
        alt: p.alt, inverted: p.inverted, playing: p.playing, url: p.url,
    };
}

export function createClip(p: NodeInput<'clip'>): ClipNode {
    return {
        id: p.id, kind: 'clip', parent: p.parent, order: p.order, page: p.page,
        x: p.x, y: p.y, rotation: p.rotation ?? COMMON_NODE_DEFAULTS.rotation,
        locked: p.locked ?? COMMON_NODE_DEFAULTS.locked,
        opacity: p.opacity ?? COMMON_NODE_DEFAULTS.opacity, ext: p.ext,
        w: p.w, h: p.h, media: p.media, time: p.time, playing: p.playing,
        autoplay: p.autoplay, alt: p.alt,
    };
}

export function createLinkcard(p: NodeInput<'linkcard'>): LinkcardNode {
    return {
        id: p.id, kind: 'linkcard', parent: p.parent, order: p.order, page: p.page,
        x: p.x, y: p.y, rotation: p.rotation ?? COMMON_NODE_DEFAULTS.rotation,
        locked: p.locked ?? COMMON_NODE_DEFAULTS.locked,
        opacity: p.opacity ?? COMMON_NODE_DEFAULTS.opacity, ext: p.ext,
        w: p.w, h: p.h, url: p.url, preview: p.preview,
    };
}

export function createEmbed(p: NodeInput<'embed'>): EmbedNode {
    return {
        id: p.id, kind: 'embed', parent: p.parent, order: p.order, page: p.page,
        x: p.x, y: p.y, rotation: p.rotation ?? COMMON_NODE_DEFAULTS.rotation,
        locked: p.locked ?? COMMON_NODE_DEFAULTS.locked,
        opacity: p.opacity ?? COMMON_NODE_DEFAULTS.opacity, ext: p.ext,
        w: p.w, h: p.h, url: p.url,
    };
}

export function createOpaque(p: NodeInput<'opaque'>): OpaqueNode {
    return {
        id: p.id, kind: 'opaque', parent: p.parent, order: p.order, page: p.page,
        x: p.x, y: p.y, rotation: p.rotation ?? COMMON_NODE_DEFAULTS.rotation,
        locked: p.locked, opacity: p.opacity ?? COMMON_NODE_DEFAULTS.opacity,
        ext: p.ext, raw: p.raw,
    };
}

export function createNode(record: NodeRecord): Node {
    switch (record.kind) {
        case 'stroke': return createStroke(record);
        case 'figure': return createFigure(record);
        case 'text': return createText(record);
        case 'sticky': return createSticky(record);
        case 'connector': return createConnector(record);
        case 'polyline': return createPolyline(record);
        case 'frame': return createFrame(record);
        case 'group': return createGroup(record);
        case 'picture': return createPicture(record);
        case 'clip': return createClip(record);
        case 'linkcard': return createLinkcard(record);
        case 'embed': return createEmbed(record);
        case 'opaque': return createOpaque(record);
    }
}
