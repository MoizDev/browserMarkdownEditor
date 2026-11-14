import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import DrawingBoardHost, { type DrawingBoardHostProps } from './DrawingBoardHost';
import type { BoardSessionPort } from './boardSessionAdapter';
import type { AttachBoardView, BoardViewLease, BoardViewParameters } from './boardHostRuntime';

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
    const current = useRef<BoardViewParameters>({ mode: props.mode, visible: props.isVisible, focused: props.isFocused,
        theme: props.theme, inverted: props.inverted });
    const error = useRef(props.onAttachError);
    useEffect(() => {
        current.current = { mode: props.mode, visible: props.isVisible, focused: props.isFocused, theme: props.theme, inverted: props.inverted };
        error.current = props.onAttachError;
    });
    const [entry, setEntry] = useState<{ adapter: typeof props.adapter; attach: typeof props.attachView; mode: typeof props.mode; lease: BoardViewLease<T> } | null>(null);
    useEffect(() => {
        let lease: BoardViewLease<T>;
        try { lease = props.attachView(props.adapter.board, current.current); }
        catch (cause) { error.current(cause); return; }
        setEntry({ adapter: props.adapter, attach: props.attachView, mode: props.mode, lease });
        return () => lease.dispose();
    }, [props.adapter, props.attachView, props.mode]);
    if (!entry || entry.adapter !== props.adapter || entry.attach !== props.attachView || entry.mode !== props.mode) return props.loading;
    return <Attached lease={entry.lease} host={props} />;
}
