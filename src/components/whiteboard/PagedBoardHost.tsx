import BoardHost, { type BoardHostProps } from './BoardHost';
import { NotebookControls, type NotebookControlsProps } from './NotebookControls';
import { PagedNavigation, type PagedNavigationProps } from './PagedNavigation';
import { SessionBoardChrome, type SessionBoardChromeProps } from './chrome/SessionBoardChrome';
import type { BoardSessionPort, HostedBoardAdapter } from './boardSessionAdapter';
import './notebookControls.css';

export type PagedBoardHostProps<T extends object, S extends BoardSessionPort> =
    Omit<BoardHostProps<T>, 'pageControls' | 'readOnly' | 'renderChrome'> & {
        readonly adapter: HostedBoardAdapter<S>;
        readonly emergencyReadOnly: boolean;
        readonly mode: 'view' | 'edit';
        readonly chrome?: Omit<SessionBoardChromeProps, 'kind' | 'openSheets' | 'readOnly' | 'isVisible'>;
    } & (
        | { readonly kind: 'notebook'; readonly controls: Omit<NotebookControlsProps, 'readOnly'> }
        | { readonly kind: 'pdf-ink'; readonly controls: PagedNavigationProps & { readonly dir: 'ltr' | 'rtl' } }
    );

/** The App owns the session and representation policy; this host attaches only its view. */
export default function PagedBoardHost<T extends object, S extends BoardSessionPort>(props: PagedBoardHostProps<T, S>) {
    const { adapter, emergencyReadOnly, chrome, mode } = props;
    if (emergencyReadOnly && !adapter.board.isReadOnly) throw new Error('Native read-only policy is not enforced by the board session');
    if (mode === 'edit' && !chrome) throw new Error('Editing board chrome is required');
    const readOnly = mode === 'view' || emergencyReadOnly || adapter.board.isReadOnly;
    const renderChrome = (openSheets: (anchor: HTMLButtonElement) => void) => chrome
        ? <SessionBoardChrome {...chrome} kind={props.kind} openSheets={openSheets} readOnly={readOnly} isVisible={props.isVisible} /> : null;
    if (props.kind === 'notebook') {
        const { kind: _kind, controls, adapter: _adapter, emergencyReadOnly: _policy, chrome: _chrome, mode: _mode, ...view } = props;
        return <BoardHost {...view} readOnly={readOnly} renderChrome={renderChrome}
            pageControls={<NotebookControls {...controls} readOnly={readOnly} />} />;
    }
    const { kind: _kind, controls, adapter: _adapter, emergencyReadOnly: _policy, chrome: _chrome, mode: _mode, ...view } = props;
    return <BoardHost {...view} readOnly={readOnly} renderChrome={renderChrome}
        pageControls={<div className="notebook-controls" role="toolbar" dir={controls.dir}
            aria-label={controls.t('paper.name')}><PagedNavigation {...controls} /></div>} />;
}
