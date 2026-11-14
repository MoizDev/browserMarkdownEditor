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
    const current = useRef(options.parameters), error = useRef(options.onError);
    useEffect(() => { current.current = options.parameters; error.current = options.onError; });
    const [entry, setEntry] = useState<{ adapter: typeof options.adapter; attach: typeof options.attachView;
        mode: BoardViewParameters['mode']; lease: BoardViewLease<T> } | null>(null);
    useEffect(() => {
        let lease: BoardViewLease<T>;
        try { lease = options.attachView(options.adapter.board, current.current); }
        catch (cause) { error.current(cause); return; }
        setEntry({ adapter: options.adapter, attach: options.attachView, mode: options.parameters.mode, lease });
        return () => lease.dispose();
    }, [options.adapter, options.attachView, options.parameters.mode]);
    return entry && entry.adapter === options.adapter && entry.attach === options.attachView
        && entry.mode === options.parameters.mode ? entry.lease : null;
}
