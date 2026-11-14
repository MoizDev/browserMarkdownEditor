import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { translateBoard } from '../../whiteboard/chrome/language';
import type { BoardQuestion } from './useNativeBoardDialogs';
import { NativeBoardChrome, type NativeBoardChromeProps } from './NativeBoardChrome';
import type { NativeViewLease } from './nativeViewLease';
import { boardPageStack } from '../../whiteboard/model/pages';
import { NotebookControls } from './NotebookControls';
import NativeNotebookThumbnails from './NativeNotebookThumbnails';
import { useNativeSheetControls } from './useNativeSheetControls';

export interface NativeBoardChromeHostProps extends Omit<NativeBoardChromeProps, 'sheetName' | 'openSheets'> {
    readonly lease: NativeViewLease;
    readonly confirm: (question: BoardQuestion) => Promise<boolean>;
    readonly canWrite: () => boolean;
    readonly notebook?: {
        readonly inverted: boolean;
        readonly setInverted: (value: boolean) => void;
        readonly thumbnailsOpen: boolean;
        readonly setThumbnailsOpen: (value: boolean) => void;
    };
}

/** Logical sheet operations share the same session and owner-scoped confirmation as the chrome. */
export function NativeBoardChromeHost({ lease, confirm, canWrite, notebook, ...props }: NativeBoardChromeHostProps) {
    const lang = useSyncExternalStore(props.language.subscribe, props.language.getSnapshot, props.language.getSnapshot);
    const { currentOwner } = props;
    const styleOwner = useCallback(() => currentOwner() && canWrite(), [currentOwner, canWrite]);
    const sheets = useNativeSheetControls({ runtime: props.runtime, lease, current: currentOwner, canWrite,
        readOnly: props.readOnly, isVisible: props.isVisible, direction: lang.table.dir,
        translate: (key, values) => translateBoard(lang.table, key, values), confirm, onError: props.reportError });
    const navigation = useSyncExternalStore(lease.subscribe, lease.getNavigationSnapshot, lease.getNavigationSnapshot);
    const getRevision = useCallback(() => props.runtime.session.doc.rev, [props.runtime]);
    const capturePng = useCallback((rect: Parameters<NativeViewLease['captureBlob']>[0], side: number, signal: AbortSignal) =>
        lease.captureBlob(rect, side, signal), [lease]);
    const jump = useCallback((page: number) => lease.jump(page), [lease]);
    const host = props.runtime.session.doc.host;
    const stack = useMemo(() => boardPageStack(host), [host]);
    if (host.kind === 'notebook' && (!notebook || !stack)) throw new Error('Notebook controls need the actual page view');
    const t = (key: string, values?: Readonly<Record<string, string | number>>) => translateBoard(lang.table, key, values);
    return <><NativeBoardChrome {...props} currentOwner={styleOwner} sheetName={sheets.sheetName} openSheets={sheets.openSheets} />
        {host.kind === 'notebook' && notebook && stack && <div className="board-page-controls">
            <NotebookControls paper={host.paper} page={navigation.page} readOnly={props.readOnly} inverted={notebook.inverted}
                thumbnailsOpen={notebook.thumbnailsOpen} dir={lang.table.dir} t={t} changePaper={sheets.controls.changePaper}
                addPage={sheets.controls.addPage} deleteLastPage={() => { void sheets.controls.deleteLastPage(); }} jump={jump}
                toggleInversion={() => notebook.setInverted(!notebook.inverted)}
                toggleThumbnails={() => notebook.setThumbnailsOpen(!notebook.thumbnailsOpen)} />
            <NativeNotebookThumbnails pages={stack.rects} revision={getRevision()} page={navigation.page} isVisible={props.isVisible}
                current={props.currentOwner} currentRevision={getRevision} capturePng={capturePng} jump={jump} onError={props.reportError}
                open={notebook.thumbnailsOpen} onOpenChange={notebook.setThumbnailsOpen} />
        </div>}{sheets.menu}</>;
}
