import type { ChangeGeometry } from '../change/coordinates';
import type { Node, Point } from '../model/nodes';
import type { LocalBox } from './placement';
import type { AgentGeometry } from './shapes';

export interface AgentWorldBox { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
/** View-independent semantic geometry; each call sees the staged doc, not doc.rev alone. */
export interface AgentProjectionSource {
    worldBox(node: Node): AgentWorldBox;
    localBox(node: Node): LocalBox;
    resolvedTip: ChangeGeometry['resolvedTip'];
}
export interface AgentProjection {
    readonly geometry: AgentGeometry;
    readonly changeGeometry: ChangeGeometry;
    localBox(node: Node): LocalBox;
    target(node: Node, destinationPage: number): Point;
}
