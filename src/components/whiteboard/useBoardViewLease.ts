import { useEffect, useRef, useState } from 'react';
import type { BoardSessionPort, HostedBoardAdapter } from './boardSessionAdapter';
import type { AttachBoardView, BoardViewLease, BoardViewParameters } from './boardHostRuntime';

/** View attachment is pane-local; session ownership remains with App. Passive cleanup follows
 * the platform pane's layout cleanup, so registered layers are detached before engine disposal. */
export function useBoardViewLease<T extends object, S extends BoardSessionPort>(options: {
    readonly adapter: HostedBoardAdapter<S>;
    readonly attachView: AttachBoardView<S, T>;
    readonly parameters: BoardViewParameters;
    readonly onError: (error: unknown) => void;
}): BoardViewLease<T> | null {
    const { adapter, attachView, parameters, onError } = options;
    const mode = parameters.mode;
    const current = useRef(parameters), error = useRef(onError);
    useEffect(() => { current.current = parameters; error.current = onError; });
    const [entry, setEntry] = useState<{ adapter: typeof adapter; attach: typeof attachView;
        mode: BoardViewParameters['mode']; lease: BoardViewLease<T> } | null>(null);
    useEffect(() => {
        let lease: BoardViewLease<T>;
        try { lease = attachView(adapter.board, current.current); }
        catch (cause) { error.current(cause); return; }
        setEntry({ adapter, attach: attachView, mode, lease });
        return () => lease.dispose();
    }, [adapter, attachView, mode]);
    return entry && entry.adapter === adapter && entry.attach === attachView
        && entry.mode === mode ? entry.lease : null;
}
