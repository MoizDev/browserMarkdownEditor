import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { usePlatformPane, type UsePlatformPaneOptions } from '../platformPane/usePlatformPane';
import BoardAccessibility, { type BoardAccessibilitySource } from './BoardAccessibility';
import './viewerHost.css';

/** View-only seam. The owner keeps the document/session alive across graph view,
 * hidden tabs and pane moves; this host owns only the attached view. */
export interface ViewerViewHandle {
    readonly accessibility: BoardAccessibilitySource;
    subscribe(listener: () => void): () => void;
    setView(view: { visible: boolean; focused: boolean; theme: 'light' | 'dark'; inverted: boolean }): void;
    /** Installs the engine's navigation-only input on the interaction root. */
    attachInput(interaction: HTMLElement, overlay: HTMLElement): () => void;
}
export interface ViewerHostProps<T extends object> {
    readonly name: string;
    readonly documentId: string;
    readonly vaultEpoch: number;
    readonly isVisible: boolean;
    readonly isFocused: boolean;
    readonly theme: 'light' | 'dark';
    readonly inverted: boolean;
    readonly reason: string | null;
    readonly readOnlyNotice: string;
    readonly view: ViewerViewHandle;
    /** Session-owned definitions and services are stable for this view lease. */
    readonly layers: UsePlatformPaneOptions<T>['layers'];
    readonly platform: UsePlatformPaneOptions<T>['services'];
    readonly registerKeyboardTarget: (focus: () => void) => () => void;
    readonly onFocus: () => void;
    readonly chrome?: ReactNode;
}

/** No engine import: the lazy route supplies the real session and view. */
export default function ViewerHost<T extends object>({
    name, documentId, vaultEpoch, isVisible, isFocused, theme, inverted, reason, readOnlyNotice,
    view, layers, platform, registerKeyboardTarget, onFocus, chrome,
}: ViewerHostProps<T>) {
    const [surface, setSurface] = useState<HTMLDivElement | null>(null);
    const [interaction, setInteraction] = useState<HTMLDivElement | null>(null);
    const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
    const interactionRef = useRef<HTMLDivElement | null>(null);
    const viewState = useRef({ visible: isVisible, focused: isFocused, theme, inverted });
    const captureInteraction = useCallback((element: HTMLDivElement | null) => {
        interactionRef.current = element;
        setInteraction(element);
    }, []);
    const pane = usePlatformPane({ host: surface, isVisible, isFocused, vaultEpoch, documentId, layers, services: platform });

    useLayoutEffect(() => {
        viewState.current = { visible: isVisible, focused: isFocused, theme, inverted };
        view.setView(viewState.current);
    }, [view, isVisible, isFocused, theme, inverted]);
    useLayoutEffect(() => () => {
        view.setView({ ...viewState.current, visible: false, focused: false });
    }, [view]);
    useLayoutEffect(() => view.subscribe(() => pane.current?.invalidate('board-view')), [view, pane]);
    useLayoutEffect(() => {
        if (!isVisible || !interaction || !overlay) return;
        return view.attachInput(interaction, overlay);
    }, [view, isVisible, interaction, overlay]);
    useLayoutEffect(() => registerKeyboardTarget(() => interactionRef.current?.focus()), [registerKeyboardTarget]);

    return <div className="board-viewer-host" onContextMenu={event => event.preventDefault()} onPointerDownCapture={() => { if (isVisible) onFocus(); }}>
        <BoardAccessibility name={name} source={view.accessibility} isVisible={isVisible} readOnly interactionRef={captureInteraction}>
            <div className="board-viewer-surface" ref={setSurface} aria-hidden="true" />
            <div className="board-viewer-overlay" ref={setOverlay} />
        </BoardAccessibility>
        <div className="board-viewer-notice" role="status">{reason ?? readOnlyNotice}</div>
        {chrome}
    </div>;
}
