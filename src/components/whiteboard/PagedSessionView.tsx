import { useSyncExternalStore, type ReactNode } from 'react';
import PagedBoardHost, { type PagedBoardHostProps } from './PagedBoardHost';
import type { BoardSessionPort } from './boardSessionAdapter';
import type { AttachBoardView, BoardViewLease } from './boardHostRuntime';
import { useBoardViewLease } from './useBoardViewLease';

type WithoutLease<T> = T extends unknown ? Omit<T, 'view' | 'layers' | 'platform' | 'reason'> : never;
export type PagedSessionViewProps<T extends object, S extends BoardSessionPort> = WithoutLease<PagedBoardHostProps<T, S>> & {
    readonly attachView: AttachBoardView<S, T>;
    readonly loading: ReactNode;
    readonly onAttachError: (error: unknown) => void;
};

function Attached<T extends object, S extends BoardSessionPort>({ lease, host }: {
    readonly lease: BoardViewLease<T>; readonly host: PagedSessionViewProps<T, S>;
}) {
    const snapshot = useSyncExternalStore(
        listener => lease.subscribe(listener), () => lease.getSnapshot(), () => lease.getSnapshot(),
    );
    if (host.kind === 'notebook') {
        const { attachView: _attachView, loading: _loading, onAttachError: _error, ...props } = host;
        return <PagedBoardHost {...props} view={lease.view} layers={snapshot.layers} platform={snapshot.platform} reason={snapshot.reason} />;
    }
    const { attachView: _attachView, loading: _loading, onAttachError: _error, ...props } = host;
    return <PagedBoardHost {...props} view={lease.view} layers={snapshot.layers} platform={snapshot.platform} reason={snapshot.reason} />;
}

/** Notebook and PDF ink share the same App-owned session and per-pane lease lifecycle. */
export default function PagedSessionView<T extends object, S extends BoardSessionPort>(props: PagedSessionViewProps<T, S>) {
    const lease = useBoardViewLease({ adapter: props.adapter, attachView: props.attachView, onError: props.onAttachError,
        parameters: { mode: props.mode, visible: props.isVisible, focused: props.isFocused, theme: props.theme, inverted: props.inverted } });
    if (!lease) return props.loading;
    return <Attached lease={lease} host={props} />;
}
