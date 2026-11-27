import type { SourceOwner } from '../../utils/documentBuffers';
import { createBoardSessionAdapter, type BoardSessionPort, type HostedBoardAdapter } from './boardSessionAdapter';
import type { ViewerHostProps, ViewerViewHandle } from './ViewerHost';
import type { BoardPaintProgress, BoardReadiness } from './BoardPaintStatus';

export function paintKey(readiness: BoardReadiness | undefined, paint: BoardPaintProgress | undefined): string {
    return JSON.stringify([readiness ?? null, paint ?? null]);
}

export type BoardSessionFactory<S extends BoardSessionPort> = (owner: SourceOwner) => S;
export type BoardOwnerGuard = (owner: SourceOwner) => boolean;
export type HostedBoardFactory<S extends BoardSessionPort> = (owner: SourceOwner) => HostedBoardAdapter<S>;
export function createHostedBoardFactory<S extends BoardSessionPort>(
    create: BoardSessionFactory<S>, isLiveOwner: BoardOwnerGuard,
): HostedBoardFactory<S> {
    return owner => createBoardSessionAdapter(owner, create(owner), isLiveOwner);
}

export interface BoardViewParameters {
    readonly mode: 'view' | 'edit';
    readonly visible: boolean;
    readonly focused: boolean;
    readonly theme: 'light' | 'dark';
    readonly inverted: boolean;
}
export interface BoardViewSnapshot<T extends object> {
    readonly layers: ViewerHostProps<T>['layers'];
    readonly platform: ViewerHostProps<T>['platform'];
    readonly reason: string | null;
    readonly readiness?: BoardReadiness;
    readonly paint?: BoardPaintProgress;
}
export interface BoardViewLease<T extends object> {
    readonly view: ViewerViewHandle;
    getSnapshot(): BoardViewSnapshot<T>;
    subscribe(listener: () => void): () => void;
    dispose(): void;
}
export type AttachBoardView<S extends BoardSessionPort, T extends object> =
    (board: S, parameters: BoardViewParameters) => BoardViewLease<T>;
