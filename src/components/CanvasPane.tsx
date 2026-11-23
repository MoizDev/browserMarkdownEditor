// The float that holds a whiteboard or a notebook, one per open canvas tab.
//
// It exists for the reason PdfPane's float does (floatingSlot.ts says it in
// full): a canvas that lived inside its slot was destroyed and rebuilt on every
// tab switch — the file re-parsed, a fresh tldraw editor stood up, every
// picture on the board decoded again — and the camera, the selection and the
// undo history died with it. Here the pane outlives the switch and is merely
// hidden, so going back to a board is a `visibility` flip.
//
// It holds nothing of its own: DrawingPane and NotebookPane are unchanged and
// still own their documents. This is the box they sit in, the DiskBar above
// them, and the "not yet shown" gate that keeps a restored session from
// building five editors to show one.

import React, { Suspense, lazy, useEffect, useRef } from 'react';
import DiskBar from './DiskBar';
import { useActivated, useFloatingSlot } from './floatingSlot';
import { isNotebookFile } from '../utils/fileTypes';
import type { ActiveFile, ContentChangeOptions, DiskAction, Theme } from '../types';

// tldraw is a heavy dependency (canvas engine + its own UI); loading it lazily
// keeps it out of the initial bundle, so a markdown-only session never pays for
// it. Both panes pull the same chunk — see components/prefetchPanes.ts.
const DrawingPane = lazy(() => import('./DrawingPane'));
const NotebookPane = lazy(() => import('./NotebookPane'));

export interface CanvasPaneProps {
    file: ActiveFile;
    /** Is this document some column's showing tab right now? */
    isVisible: boolean;
    /** The column it stands over: the index addresses the editor's CSS
     *  variables, the pair of numbers is what a hidden pane freezes to. */
    slotIndex: number;
    slotLeft: number;
    slotWidth: number;
    onFocusPane: (path: string) => void;
    /** Hand the keyboard to this canvas when a tab-bar gesture settles on it
     *  (EditorPane). A canvas used to get focus for free — the pane remounted
     *  on every switch and tldraw focuses itself as it mounts — and now that it
     *  survives the switch, nothing else would: measured, a board returned to
     *  from a tab click took no shortcut, ⌘Z included, until it was clicked. */
    registerKeyboardTarget: (path: string, take: () => void) => () => void;
    content: string;
    onContentChange: (path: string, content: string, options?: ContentChangeOptions) => void;
    onConfirm: (question: { title: string; body: string; confirmLabel: string; danger?: boolean }) => Promise<boolean>;
    theme: Theme;
    /** The file parted ways with the tab on disk (OpenTab.disk). The bar is
     *  drawn HERE, not by DocumentPane: this pane floats over the slot and
     *  would paint over one placed there. */
    disk?: 'conflict' | 'deleted';
    onDiskAction: (path: string, action: DiskAction) => Promise<void>;
}

function CanvasPane({ file, isVisible, slotIndex, slotLeft, slotWidth, onFocusPane, registerKeyboardTarget, content, onContentChange, onConfirm, theme, disk, onDiskAction }: CanvasPaneProps) {
    const activated = useActivated(isVisible);
    const rootRef = useRef<HTMLDivElement>(null);

    // tldraw's own container is what its shortcuts listen on, and it carries a
    // tabindex of its own — so focusing it is all this has to do. Read when
    // called, not captured: the canvas below may still be loading when the
    // target is registered.
    useEffect(() => registerKeyboardTarget(file.path, () => {
        rootRef.current?.querySelector<HTMLElement>('.tl-container')?.focus();
    }), [file.path, registerKeyboardTarget]);
    const slotStyle = useFloatingSlot(isVisible, slotIndex, slotLeft, slotWidth);
    const isNotebook = isNotebookFile(file.name);
    const label = isNotebook ? 'Loading notebook…' : 'Loading whiteboard…';

    return (
        <div
            ref={rootRef}
            className={`canvas-pane${isVisible ? '' : ' canvas-pane-hidden'}`}
            style={slotStyle}
            // The pane floats over its slot, so this is the ONLY thing that can
            // report a click on a canvas as "focus this pane" — capture, so a
            // stroke, a pan and a click on tldraw's own UI all count.
            onPointerDownCapture={() => { if (isVisible) onFocusPane(file.path); }}
        >
            {disk && <DiskBar name={file.name} state={disk} path={file.path} onAction={onDiskAction} />}
            {/* Always wrapped, bar or no bar: toggling the wrapper would remount
                the canvas and undo everything this float is for. */}
            <div className="canvas-pane-body">
                {activated && (
                    <Suspense fallback={<div className="drawing-pane drawing-pane-loading">{label}</div>}>
                        {isNotebook ? (
                            <NotebookPane
                                filePath={file.path}
                                content={content}
                                onContentChange={onContentChange}
                                onConfirm={onConfirm}
                            />
                        ) : (
                            <DrawingPane
                                filePath={file.path}
                                content={content}
                                onContentChange={onContentChange}
                                theme={theme}
                            />
                        )}
                    </Suspense>
                )}
            </div>
        </div>
    );
}

// Memoized for the reason PdfPane is: EditorPane re-renders on every keystroke
// anywhere in the app and maps over every open canvas tab, so without this each
// mounted board re-ran on every character typed in an unrelated note.
//
// `content` is the exception that makes it worth saying: a canvas's own strokes
// come back through it on every save round-trip, and the panes below read it
// ONLY at mount (keyed by path), so a new string here renders this component
// and changes nothing underneath.
export default React.memo(CanvasPane);
