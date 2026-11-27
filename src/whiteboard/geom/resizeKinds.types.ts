import type { Op } from '../change/ops';
import type { ClipNode, ConnectorNode, EmbedNode, FigureNode, FrameNode, GroupNode, LinkcardNode, Node } from '../model/nodes';

export interface KindResizeFactors {
    readonly x: number;
    readonly y: number;
    readonly zeroSignX: -1 | 1;
    readonly zeroSignY: -1 | 1;
    readonly handle: 'side' | 'corner';
    readonly handleX?: -1 | 0 | 1;
    readonly handleY?: -1 | 0 | 1;
    readonly scope: 'single' | 'multi';
}
export interface KindResizeContext {
    layoutFigure(node: Readonly<FigureNode>, width: number, height: number): Readonly<{ h: number; growY: number }>;
    resizeConnector(node: Readonly<ConnectorNode>, factors: KindResizeFactors): readonly Op[];
    resizeGroup(node: Readonly<GroupNode>, factors: KindResizeFactors): readonly Op[];
    resizeFrame(node: Readonly<FrameNode>, width: number, height: number, factors: KindResizeFactors): readonly Op[];
    resizeMedia(node: Readonly<ClipNode | LinkcardNode | EmbedNode>, factors: KindResizeFactors): readonly Op[];
}
export type KindResizePlanner = (node: Readonly<Node>, factors: KindResizeFactors, context: KindResizeContext) => readonly Op[];
