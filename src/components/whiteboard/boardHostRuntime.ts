import type { SourceOwner } from '../../utils/documentBuffers';
import type { BoardSessionPort, HostedBoardAdapter } from './boardSessionAdapter';
import type { ViewerHostProps, ViewerViewHandle } from './ViewerHost';

/** A factory is synchronous because C-19 assigns the owner before it installs the adapter.
 * Native acquisition and validation finish first; the factory must not reread live bytes. */
export type BoardSessionFactory<S extends BoardSessionPort> = (owner: SourceOwner) => S;
export type BoardOwnerGuard = (owner: SourceOwner) => boolean;
export type HostedBoardFactory<S extends BoardSessionPort> = (owner: SourceOwner) => HostedBoardAdapter<S>;

export interface BoardViewParameters {
    readonly visible: boolean;
    readonly focused: boolean;
    readonly theme: 'light' | 'dark';
    readonly inverted: boolean;
}
/** Each pane owns a separate lease. The document session and save adapter outlive all leases. */
export interface BoardViewLease<T extends object> {
    readonly view: ViewerViewHandle;
    readonly layers: ViewerHostProps<T>['layers'];
    readonly platform: ViewerHostProps<T>['platform'];
    dispose(): void;
}
export type AttachBoardView<S extends BoardSessionPort, T extends object> =
    (board: S, parameters: BoardViewParameters) => BoardViewLease<T>;
