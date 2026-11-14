import BoardHost, { type BoardHostProps } from './BoardHost';
import { SessionBoardChrome, type SessionBoardChromeProps } from './chrome/SessionBoardChrome';
import type { BoardSessionPort, HostedBoardAdapter } from './boardSessionAdapter';

/** The App owns the adapter; this component attaches only the supplied view lease. */
export interface DrawingBoardHostProps<T extends object, S extends BoardSessionPort>
    extends Omit<BoardHostProps<T>, 'readOnly' | 'renderChrome'> {
    readonly adapter: HostedBoardAdapter<S>;
    /** The representation policy is frozen at acquisition, not a live preference. */
    readonly emergencyReadOnly: boolean;
    readonly chrome: Omit<SessionBoardChromeProps, 'kind' | 'openSheets' | 'readOnly' | 'isVisible'>;
}

export default function DrawingBoardHost<T extends object, S extends BoardSessionPort>({
    adapter, emergencyReadOnly, chrome, ...view
}: DrawingBoardHostProps<T, S>) {
    if (emergencyReadOnly && !adapter.board.isReadOnly) throw new Error('Native read-only policy is not enforced by the board session');
    const readOnly = emergencyReadOnly || adapter.board.isReadOnly;
    return <BoardHost {...view} readOnly={readOnly} renderChrome={openSheets =>
        <SessionBoardChrome {...chrome} kind="whiteboard" openSheets={openSheets} readOnly={readOnly} isVisible={view.isVisible} />} />;
}
