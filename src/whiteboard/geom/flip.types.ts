import type { Op } from '../change/ops';
import type { ClipNode, ConnectorNode, EmbedNode, FrameNode, GroupNode, LinkcardNode, Node, StickyNode, TextNode } from '../model/nodes';
import type { Vec2 } from './path';
import type { RotationTargetSnapshot } from './rotationPlan.types';

export interface FlipServices {
    isCurrent(): boolean;
    capture(node: Readonly<Node>): RotationTargetSnapshot;
    /** Place projected kind geometry at its reflected centre and orientation, including page ownership. */
    place(snapshot: RotationTargetSnapshot, centre: Vec2, rotation: number, kindOps: readonly Op[]): readonly Op[];
    reflectConnector(node: Readonly<ConnectorNode>, axis: 'x' | 'y'): readonly Op[];
    reflectContainer(node: Readonly<FrameNode | GroupNode>, axis: 'x' | 'y'): readonly Op[];
    reflectReadable(node: Readonly<TextNode | StickyNode>, axis: 'x' | 'y'): readonly Op[];
    reflectMedia(node: Readonly<ClipNode | LinkcardNode | EmbedNode>, axis: 'x' | 'y'): readonly Op[];
}
