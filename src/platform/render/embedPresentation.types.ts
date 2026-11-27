import type { Affine, LineCap, LineJoin, PathCommand, Rect } from '../types';
import type { EmbedContainment } from '../embedContainment.types';
import type { PlatformLayerDefinition, PlatformPresentation } from './attachPlatformPane.types';
import type { FrameToken } from './types';

export interface EmbedCoveragePath {
    readonly d: readonly Readonly<PathCommand>[];
    readonly fillRule: 'nonzero' | 'evenodd';
    readonly toPane: Affine;
}
export interface EmbedClippedCoverage {
    readonly path: EmbedCoveragePath;
    readonly fill?: boolean;
    readonly stroke?: Readonly<{ width: number; cap: LineCap; join: LineJoin; miterLimit: number;
        dash?: readonly number[]; dashPhase?: number }>;
    readonly clips: readonly EmbedCoveragePath[];
}
export type EmbedLaterPaint =
    | Readonly<{ opacity: 'opaque'; coverage: EmbedClippedCoverage }>
    | Readonly<{ opacity: 'translucent' }>
    | Readonly<{ opacity: 'unknown' }>;

export interface EmbedPresentedNode {
    readonly nodeId: string;
    readonly source: string;
    readonly order: number;
    readonly rect: Readonly<Rect>;
    readonly toPane: Affine;
    readonly clips: readonly EmbedCoveragePath[];
    readonly opacity: number;
    readonly poster: 'painted' | 'omitted';
    readonly laterPaint: readonly EmbedLaterPaint[];
}

export interface EmbedPresentationFrame {
    readonly presentation: PlatformPresentation;
    readonly sceneRevision: number;
    readonly viewport: Readonly<{ width: number; height: number }>;
    readonly camera: Readonly<{ x: number; y: number; z: number }>;
    readonly nodes: readonly EmbedPresentedNode[];
    release(): void | Promise<void>;
}

export type EmbedHostingMode = 'pending' | 'inline' | 'interaction' | 'closed';
export interface EmbedHostingSnapshot {
    readonly mode: EmbedHostingMode;
    readonly visible: boolean;
    readonly node: EmbedPresentedNode | null;
    readonly presentation: PlatformPresentation | null;
}
export interface EmbedHostingLease {
    readonly nodeId: string;
    /** Pass this exact connected container to createEmbedContainment. Never reparent its frame. */
    readonly container: HTMLElement;
    readonly chrome: HTMLElement;
    readonly signal: AbortSignal;
    bind(containment: EmbedContainment): void;
    getSnapshot(): EmbedHostingSnapshot;
    subscribe(listener: () => void): () => void;
    setInteractionRect(rect: Readonly<Rect> | null): void;
    dispose(): Promise<void>;
}

export interface EmbedDrawnPaint {
    readonly token: FrameToken;
    readonly frameId: number;
    readonly cameraEpoch: number;
    readonly sceneRevision: number;
    readonly omittedNodeIds: ReadonlySet<string> | null;
}

export interface EmbedPresentationPort {
    readonly layer: PlatformLayerDefinition;
    present(frame: EmbedPresentationFrame): void;
    drawn(paint: EmbedDrawnPaint): void;
    acquire(nodeId: string, signal?: AbortSignal): Promise<EmbedHostingLease>;
    requestedNodeIds(): ReadonlySet<string>;
    inlineNodeIds(sceneRevision?: number): ReadonlySet<string>;
    setVisible(visible: boolean): void;
    dispose(): Promise<void>;
}

export interface EmbedPresentationOptions {
    readonly overlay: HTMLElement;
    readonly onError?: (error: unknown) => void;
    readonly invalidate?: () => void;
}
