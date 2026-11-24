import type { Affine, LineCap, LineJoin, PathCommand, Rect } from '../types';
import type { EmbedContainment } from '../embedContainment.types';
import type { PlatformLayerDefinition, PlatformPresentation } from './attachPlatformPane.types';
import type { FrameToken } from './types';

/** Filled coverage from the actual paint, not a model/file bounding box. Stroke, glyph and
 * image-alpha coverage must already be resolved by their canonical producer. */
export interface EmbedCoveragePath {
    readonly d: readonly Readonly<PathCommand>[];
    readonly fillRule: 'nonzero' | 'evenodd';
    readonly toPane: Affine;
}
export interface EmbedClippedCoverage {
    readonly path: EmbedCoveragePath;
    /** Omitted means filled; false permits stroke-only native coverage. */
    readonly fill?: boolean;
    readonly stroke?: Readonly<{ width: number; cap: LineCap; join: LineJoin; miterLimit: number;
        dash?: readonly number[]; dashPhase?: number }>;
    /** Intersections, in paint order, including the covering item's own ancestor clips. */
    readonly clips: readonly EmbedCoveragePath[];
}
export type EmbedLaterPaint =
    | Readonly<{ opacity: 'opaque'; coverage: EmbedClippedCoverage }>
    /** Only include an item whose actual clipped coverage intersects the live surface. */
    | Readonly<{ opacity: 'translucent' }>
    /** The facts for this later paint cannot be proven. The embed keeps its true-order poster: no live
     * surface, no outside interaction, and no claim that anything above it is opaque or translucent. */
    | Readonly<{ opacity: 'unknown' }>;

export interface EmbedPresentedNode {
    readonly nodeId: string;
    /** Original semantic source string: a change revokes the lease, even for equivalent URLs. */
    readonly source: string;
    /** Actual canonical paint position, including other live embeds. */
    readonly order: number;
    /** The presented quad is toPane(rect), never its axis-aligned enclosing box. */
    readonly rect: Readonly<Rect>;
    readonly toPane: Affine;
    readonly clips: readonly EmbedCoveragePath[];
    readonly opacity: number;
    /** Actual drawn manifest, not the desired omission state. */
    readonly poster: 'painted' | 'omitted';
    readonly laterPaint: readonly EmbedLaterPaint[];
}

/** One owned immutable packet from the actual accepted presentation. All coordinates are pane
 * CSS pixels and include the compositor's presentation snapping. The producer holds every
 * backing/source lease until release; the port takes ownership, including superseded packets. */
export interface EmbedPresentationFrame {
    readonly presentation: PlatformPresentation;
    readonly sceneRevision: number;
    readonly viewport: Readonly<{ width: number; height: number }>;
    /** The camera the board drew these nodes' placements at: a later view epoch at this camera and viewport places them the same. */
    readonly camera: Readonly<{ x: number; y: number; z: number }>;
    readonly nodes: readonly EmbedPresentedNode[];
    release(): void | Promise<void>;
}

export type EmbedHostingMode = 'pending' | 'inline' | 'interaction' | 'closed';
export interface EmbedHostingSnapshot {
    readonly mode: EmbedHostingMode;
    /** False until containment, matching paint/omission and complete mask/placement are ready. */
    readonly visible: boolean;
    readonly node: EmbedPresentedNode | null;
    readonly presentation: PlatformPresentation | null;
}
export interface EmbedHostingLease {
    readonly nodeId: string;
    /** Pass this exact connected container to createEmbedContainment. Never reparent its frame. */
    readonly container: HTMLElement;
    /** Core mounts interaction-surface chrome here; hidden for normal inline placement. */
    readonly chrome: HTMLElement;
    /** Entire hosting lifetime: hide/close/source change/view replacement abort it. */
    readonly signal: AbortSignal;
    bind(containment: EmbedContainment): void;
    getSnapshot(): EmbedHostingSnapshot;
    subscribe(listener: () => void): () => void;
    /** Pane-CSS body rectangle for the explicit app-owned OUTSIDE-BOARD interaction surface.
     * Only used for translucent-above mode; changing placement never reloads the provider. */
    setInteractionRect(rect: Readonly<Rect> | null): void;
    dispose(): Promise<void>;
}

/** Same-compositor draw witness, not a claim that an unaccepted frame was presented. */
export interface EmbedDrawnPaint {
    readonly token: FrameToken;
    readonly frameId: number;
    readonly cameraEpoch: number;
    readonly sceneRevision: number;
    readonly omittedNodeIds: ReadonlySet<string> | null;
}

export interface EmbedPresentationPort {
    /** Append once to the pane's existing shared-compositor layers; no new context or scheduler. */
    readonly layer: PlatformLayerDefinition;
    /** Adopts an owned actual-presentation packet; never accepts speculative model geometry. */
    present(frame: EmbedPresentationFrame): void;
    /** Renderer-only, at the actual band draw. Blocks stale geometry/poster state before commit. */
    drawn(paint: EmbedDrawnPaint): void;
    /** Call only for the semantic per-node Load action. Resolves after actual facts/admission. */
    acquire(nodeId: string, signal?: AbortSignal): Promise<EmbedHostingLease>;
    /** Embeds the user has asked for (acquire waiters and acquired slots), whether or not their facts are ready. The
     * board draws each as a real live barrier at its paint position, so it is never absorbed into a tile and never
     * omitted before its facts are proven. This is precision only: it claims no omission. */
    requestedNodeIds(): ReadonlySet<string>;
    /** Desired card omissions for this view ONLY. Captures/exports keep the static poster. */
    inlineNodeIds(sceneRevision?: number): ReadonlySet<string>;
    setVisible(visible: boolean): void;
    dispose(): Promise<void>;
}

export interface EmbedPresentationOptions {
    /** Stable pane overlay below app chrome. This must share the board's real input ancestor. */
    readonly overlay: HTMLElement;
    readonly onError?: (error: unknown) => void;
    /** Called when the set of requested embeds changes, so the board repaints with them as live barriers. */
    readonly invalidate?: () => void;
}
