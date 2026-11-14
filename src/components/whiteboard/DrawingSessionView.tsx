import { useSyncExternalStore, type ReactNode } from 'react';
import DrawingBoardHost, { type DrawingBoardHostProps } from './DrawingBoardHost';
import type { BoardSessionPort } from './boardSessionAdapter';
import type { AttachBoardView, BoardViewLease } from './boardHostRuntime';
import { useBoardViewLease } from './useBoardViewLease';

export interface DrawingSessionViewProps<T extends object, S extends BoardSessionPort>
    extends Omit<DrawingBoardHostProps<T, S>, 'view' | 'layers' | 'platform' | 'reason'> {
    readonly attachView: AttachBoardView<S, T>;
    readonly loading: ReactNode;
    readonly onAttachError: (error: unknown) => void;
}

function Attached<T extends object, S extends BoardSessionPort>({
    lease, host,
}: { readonly lease: BoardViewLease<T>; readonly host: DrawingSessionViewProps<T, S> }) {
    const snapshot = useSyncExternalStore(
        listener => lease.subscribe(listener), () => lease.getSnapshot(), () => lease.getSnapshot(),
    );
    const { attachView: _attachView, loading: _loading, onAttachError: _onAttachError, ...props } = host;
    return <DrawingBoardHost {...props} view={lease.view} layers={snapshot.layers} platform={snapshot.platform} reason={snapshot.reason} />;
}

/** A view lease belongs to a mounted pane, not the App-owned session. Passive cleanup runs
 * after ViewerHost's layout cleanup detaches the platform layers and input listeners. */
export default function DrawingSessionView<T extends object, S extends BoardSessionPort>(props: DrawingSessionViewProps<T, S>) {
    const lease = useBoardViewLease({ adapter: props.adapter, attachView: props.attachView, onError: props.onAttachError,
        parameters: { mode: props.mode, visible: props.isVisible, focused: props.isFocused, theme: props.theme, inverted: props.inverted } });
    if (!lease) return props.loading;
    return <Attached lease={lease} host={props} />;
}
