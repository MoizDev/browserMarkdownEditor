import BoardHost, { type BoardHostProps } from './BoardHost';
import { NotebookControls, type NotebookControlsProps } from './NotebookControls';
import { PagedNavigation, type PagedNavigationProps } from './PagedNavigation';
import './notebookControls.css';

export type PagedBoardHostProps<T extends object> = Omit<BoardHostProps<T>, 'pageControls'> & (
    | { readonly kind: 'notebook'; readonly controls: Omit<NotebookControlsProps, 'readOnly'> }
    | { readonly kind: 'pdf-ink'; readonly controls: PagedNavigationProps & { readonly dir: 'ltr' | 'rtl' } }
);

/** The session supplies authority, layers and input; this shell owns only view controls. */
export default function PagedBoardHost<T extends object>(props: PagedBoardHostProps<T>) {
    if (props.kind === 'notebook') {
        const { kind: _kind, controls, ...host } = props;
        return <BoardHost {...host} pageControls={<NotebookControls {...controls} readOnly={host.readOnly} />} />;
    }
    const { kind: _kind, controls, ...host } = props;
    return <BoardHost {...host} pageControls={<div className="notebook-controls" role="toolbar" dir={controls.dir}
        aria-label={controls.t('paper.name')}><PagedNavigation {...controls} /></div>} />;
}
