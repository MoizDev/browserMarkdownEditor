import BoardHost, { type BoardHostProps } from './BoardHost';
import { SessionBoardChrome, type SessionBoardChromeProps } from './chrome/SessionBoardChrome';
import type { BoardSessionPort, HostedBoardAdapter } from './boardSessionAdapter';

/** The App owns the adapter; this component attaches only the supplied view lease. */
export interface DrawingBoardHostProps<T extends object, S extends BoardSessionPort>
    extends Omit<BoardHostProps<T>, 'readOnly' | 'renderChrome'> {
    readonly adapter: HostedBoardAdapter<S>;
    /** The representation policy is frozen at acquisition, not a live preference. */
    readonly emergencyReadOnly: boolean;
    readonly mode: 'view' | 'edit';
    /** The read-only viewer can omit editing chrome while its session is loading. */
    readonly chrome?: Omit<SessionBoardChromeProps, 'kind' | 'openSheets' | 'readOnly' | 'isVisible'>;
}

export default function DrawingBoardHost<T extends object, S extends BoardSessionPort>({
    adapter, emergencyReadOnly, mode, chrome, ...view
}: DrawingBoardHostProps<T, S>) {
    if (emergencyReadOnly && !adapter.board.isReadOnly) throw new Error('Native read-only policy is not enforced by the board session');
    const readOnly = mode === 'view' || emergencyReadOnly || adapter.board.isReadOnly;
    if (mode === 'edit' && !chrome) throw new Error('Editing board chrome is required');
    return <BoardHost {...view} readOnly={readOnly} renderChrome={openSheets => chrome
        ? <SessionBoardChrome {...chrome} kind="whiteboard" openSheets={openSheets} readOnly={readOnly} isVisible={view.isVisible} /> : null} />;
}
