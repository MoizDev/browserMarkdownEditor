import type { Op } from '../change/ops';
import type { ConnectorNode, FigureNode, GroupNode, Node } from '../model/nodes';

export interface KindResizeFactors {
    readonly x: number;
    readonly y: number;
    /** Crossing direction when an extent is exactly zero. */
    readonly zeroSignX: -1 | 1;
    readonly zeroSignY: -1 | 1;
    readonly handle: 'side' | 'corner';
}
export interface KindResizeContext {
    /** Text layout and growth are computed before the transaction is applied. */
    layoutFigure(node: Readonly<FigureNode>, width: number, height: number): Readonly<{ h: number; growY: number }>;
    /** Connectors retain binding semantics; their provider resolves both ends once. */
    resizeConnector(node: Readonly<ConnectorNode>, factors: KindResizeFactors): readonly Op[];
    /** Group content is planned recursively exactly once, never by persisting a group scale. */
    resizeGroup(node: Readonly<GroupNode>, factors: KindResizeFactors): readonly Op[];
}
export type KindResizePlanner = (node: Readonly<Node>, factors: KindResizeFactors, context: KindResizeContext) => readonly Op[];
