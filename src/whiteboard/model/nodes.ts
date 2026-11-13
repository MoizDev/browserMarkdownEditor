import type { NodeId, ParentId } from './ids';
import type { ExtBag, JsonValue } from './json';
import type { MediaId } from './media';
import type { OrderKey } from './orderKey';
import type { SampleRef } from './samples';
import type {
    Arrowhead, Dash, FigureShape, Fill, Font, HAlign, Size, Swatch, TextAlign, VAlign,
} from './styles';
import type { RichText } from '../text/richText';

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
    readonly raw: JsonValue;
}

export type Node = StrokeNode | FigureNode | TextNode | StickyNode | ConnectorNode | PolylineNode
    | FrameNode | GroupNode | PictureNode | ClipNode | LinkcardNode | EmbedNode | OpaqueNode;
export type NodeKind = Node['kind'];
export type NodeRecord = Node;
export type NodeTable = ReadonlyMap<NodeId, Readonly<Node>>;
