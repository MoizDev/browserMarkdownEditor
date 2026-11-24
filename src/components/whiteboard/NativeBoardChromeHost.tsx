import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { translateBoard } from '../../whiteboard/chrome/language';
import type { BoardQuestion } from './useNativeBoardDialogs';
import { NativeBoardChrome, type NativeBoardChromeProps } from './NativeBoardChrome';
import type { NativeViewLease } from './nativeViewLease';
import { boardPageStack } from '../../whiteboard/model/pages';
import { NotebookControls, PagedBar } from './NotebookControls';
import { PageNumberField, PageViewToggles } from './PagedNavigation';
import NativeNotebookThumbnails from './NativeNotebookThumbnails';
import { useNativeSheetControls } from './useNativeSheetControls';
import './boardHost.css';

export interface NativeBoardChromeHostProps extends Omit<NativeBoardChromeProps, 'sheetName' | 'openSheets' | 'pageControls'> {
    readonly lease: NativeViewLease;
    readonly confirm: (question: BoardQuestion) => Promise<boolean>;
    readonly canWrite: () => boolean;
    /** One page's preview from the document's all-sheet print source (the notebook thumbnails). */
    readonly capturePage: (index: number, maxSide: number, signal: AbortSignal) => Promise<Blob>;
    readonly notebook?: {
        readonly inverted: boolean;
        readonly setInverted: (value: boolean) => void;
        readonly thumbnailsOpen: boolean;
        readonly setThumbnailsOpen: (value: boolean) => void;
    };
}

/** Logical sheet operations share the same session and owner-scoped confirmation as the chrome. */
export function NativeBoardChromeHost({ lease, confirm, canWrite, capturePage, notebook, ...props }: NativeBoardChromeHostProps) {
    const lang = useSyncExternalStore(props.language.subscribe, props.language.getSnapshot, props.language.getSnapshot);
    const { currentOwner } = props;
    const styleOwner = useCallback(() => currentOwner() && canWrite(), [currentOwner, canWrite]);
    const sheets = useNativeSheetControls({ runtime: props.runtime, lease, current: currentOwner, canWrite,
        readOnly: props.readOnly, isVisible: props.isVisible, direction: lang.table.dir,
        translate: (key, values) => translateBoard(lang.table, key, values), confirm, onError: props.reportError });
    const navigation = useSyncExternalStore(lease.subscribe, lease.getNavigationSnapshot, lease.getNavigationSnapshot);
    const getRevision = useCallback(() => props.runtime.session.doc.rev, [props.runtime]);
    const jump = useCallback((page: number) => lease.jump(page), [lease]);
    const host = props.runtime.session.doc.host;
    const stack = useMemo(() => boardPageStack(host), [host]);
    if (host.kind !== 'whiteboard' && (!notebook || !stack)) throw new Error('Paged board controls need the actual page view');
    const t = (key: string, values?: Readonly<Record<string, string | number>>) => translateBoard(lang.table, key, values);
    // The paged bar belongs to the chrome column under the header, so it cannot cover the header's commands.
    // A notebook's bar also edits paper; an annotated PDF's only navigates, and its physical pages are fixed.
    const paper = host.kind !== 'whiteboard' && notebook && stack ? <div className="board-paper-slot"><div className="board-paper-bar">
        {host.kind === 'notebook' ? <NotebookControls paper={host.paper} page={navigation.page} readOnly={props.readOnly} inverted={notebook.inverted}
            thumbnailsOpen={notebook.thumbnailsOpen} dir={lang.table.dir} t={t} changePaper={sheets.controls.changePaper}
            addPage={sheets.controls.addPage} deleteLastPage={() => { void sheets.controls.deleteLastPage(); }} jump={jump}
            toggleInversion={() => notebook.setInverted(!notebook.inverted)}
            toggleThumbnails={() => notebook.setThumbnailsOpen(!notebook.thumbnailsOpen)} />
            : <PagedBar dir={lang.table.dir} t={t} settings={null}
                toggles={<PageViewToggles inverted={notebook.inverted} thumbnailsOpen={notebook.thumbnailsOpen} t={t}
                    toggleInversion={() => notebook.setInverted(!notebook.inverted)}
                    toggleThumbnails={() => notebook.setThumbnailsOpen(!notebook.thumbnailsOpen)} />}
                page={<PageNumberField page={navigation.page} count={stack.rects.length} t={t} jump={jump} />} />}
        <NativeNotebookThumbnails pages={stack.rects} revision={getRevision()} page={navigation.page} isVisible={props.isVisible}
            current={props.currentOwner} currentRevision={getRevision} capturePage={capturePage} jump={jump} onError={props.reportError}
            open={notebook.thumbnailsOpen} onOpenChange={notebook.setThumbnailsOpen}
            reorder={props.readOnly || host.kind !== 'notebook' ? undefined : (from, to) => {
                try { sheets.controls.reorderPage(from, to); } catch (error) { props.reportError(error); }
            }} />
    </div></div> : undefined;
    return <><NativeBoardChrome {...props} currentOwner={styleOwner} sheetName={sheets.sheetName} openSheets={sheets.openSheets}
        pageControls={paper} paletteSheets={sheets.controls} />{sheets.menu}</>;
}
