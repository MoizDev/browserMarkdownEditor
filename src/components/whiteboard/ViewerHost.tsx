import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { usePlatformPane, type UsePlatformPaneOptions } from '../platformPane/usePlatformPane';
import BoardAccessibility, { type BoardAccessibilitySource } from './BoardAccessibility';
import type { PlatformPane } from '../../platform/render/attachPlatformPane.types';
import type { RenderToken } from '../../platform/render/types';
import BoardPaintStatus, { type BoardPaintProgress, type BoardReadiness } from './BoardPaintStatus';
import { getContextMenu } from '../../utils/contextMenu';
import './viewerHost.css';

/** The owner keeps the document/session alive across graph view, hidden tabs
 * and pane moves; this host owns only the attached view. */
export interface ViewerViewHandle {
    readonly accessibility: BoardAccessibilitySource;
    readonly sourceToken?: RenderToken;
    /** `'paint'` is a paint-progress change, which does not change the picture and must not invalidate the pane. */
    subscribe(listener: (change?: 'state' | 'paint') => void): () => void;
    setView(view: { visible: boolean; focused: boolean; theme: 'light' | 'dark'; inverted: boolean }): void;
    /** The view installs mode-appropriate input on the interaction root. */
    attachInput(interaction: HTMLElement, overlay: HTMLElement): () => void;
    attachPlatform?(pane: PlatformPane | null): void;
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
    /** The renderer's readiness and progress: loading before complete pixels, pending keeps the last coherent pixels. */
    readonly readiness?: BoardReadiness;
    readonly paint?: BoardPaintProgress;
    /** A writable view must enforce the same authority in its session and input. */
    readonly readOnly?: boolean;
    /** Read-only only until editing is admitted: the authority holds, but the notice about it is not shown for a passing state. */
    readonly admitting?: boolean;
    /** The editing input installs the same engine's accessible mirror itself. */
    readonly externalAccessibility?: boolean;
    readonly view: ViewerViewHandle;
    /** Session-owned definitions and services are stable for this view lease. */
    readonly layers: UsePlatformPaneOptions<T>['layers'];
    readonly platform: UsePlatformPaneOptions<T>['services'];
    readonly registerKeyboardTarget: (focus: () => void) => () => void;
    readonly onFocus: () => void;
    readonly chrome?: ReactNode;
}

/** Below this host width the zoom controls stack above the tool bar instead of beside it. Measured: the bar is 446px
 *  at its natural width and the zoom pill 132px (100%, Minimap), inside an 8px overlay inset with 8px gaps, so
 *  side by side needs 742px; the margin is for a longer zoom label. Five panes of 307px pushed the pill past the
 *  pane's edge. The CSS keyed on `data-chrome-stacked` (chrome.css, viewerHost.css, nativeMinimap.css, index.css's
 *  lifted status pill) lifts everything that stood on the bottom row by the zoom row's height. */
const CHROME_STACK_BELOW_PX = 780;

/** No engine import: the lazy route supplies the real session and view. */
export default function ViewerHost<T extends object>({
    name, documentId, vaultEpoch, isVisible, isFocused, theme, inverted, reason, readOnlyNotice, readOnly = true, admitting = false, externalAccessibility = false,
    view, layers, platform, registerKeyboardTarget, onFocus, chrome, readiness, paint,
}: ViewerHostProps<T>) {
    const [surface, setSurface] = useState<HTMLDivElement | null>(null);
    const hostRef = useRef<HTMLDivElement | null>(null);
    // A ResizeObserver reports after layout and before paint, so the stacked layout never shows a frame late.
    useLayoutEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const observer = new ResizeObserver(entries => {
            const width = entries[entries.length - 1]?.contentRect.width ?? host.clientWidth;
            // A hidden pane keeps its last geometry; a zero width (detached, collapsed) decides nothing.
            if (width > 0) host.toggleAttribute('data-chrome-stacked', width < CHROME_STACK_BELOW_PX);
        });
        observer.observe(host);
        return () => observer.disconnect();
    }, []);
    const [interaction, setInteraction] = useState<HTMLDivElement | null>(null);
    const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
    const interactionRef = useRef<HTMLDivElement | null>(null);
    const viewState = useRef({ visible: isVisible, focused: isFocused, theme, inverted });
    const captureInteraction = useCallback((element: HTMLDivElement | null) => {
        interactionRef.current = element;
        setInteraction(element);
    }, []);
    const onPane = useCallback((attached: PlatformPane | null) => view.attachPlatform?.(attached), [view]);
    const pane = usePlatformPane({ host: surface, isVisible, isFocused, vaultEpoch, documentId, layers, services: platform, onPane, sourceToken: view.sourceToken });

    useLayoutEffect(() => {
        viewState.current = { visible: isVisible, focused: isFocused, theme, inverted };
        view.setView(viewState.current);
    }, [view, isVisible, isFocused, theme, inverted]);
    useLayoutEffect(() => () => {
        view.setView({ ...viewState.current, visible: false, focused: false });
    }, [view]);
    useLayoutEffect(() => view.subscribe(change => { if (change !== 'paint') pane.current?.invalidate('board-view'); }), [view, pane]);
    useLayoutEffect(() => {
        if (!isVisible || !interaction || !overlay) return;
        return view.attachInput(interaction, overlay);
    }, [view, isVisible, interaction, overlay]);
    useLayoutEffect(() => registerKeyboardTarget(() => interactionRef.current?.focus({ preventScroll: true })), [registerKeyboardTarget]);
    // A toolbar button clicked with the pointer hands the keyboard back to the board, as tldraw's toolbar does: the
    // click focused the button, outside the interaction root the shortcuts listen on, so the next tool key went
    // nowhere (measured: Select clicked, then E — still Select). Only a pointer click (`detail` 0 is Enter/Space on
    // a button someone is walking by keyboard, who keeps it), and never from a popup the click opened: a button
    // that declares one, an app menu now open, or focus already moved elsewhere. A tool picked inside More tools
    // unmounts its button, leaving the keyboard on `<body>`, which is taken too.
    const returnKeyboard = useCallback((event: MouseEvent<HTMLDivElement>) => {
        if (event.detail === 0 || !(event.target instanceof Element)) return;
        const button = event.target.closest('button');
        if (!button || button.hasAttribute('aria-haspopup') || interactionRef.current?.contains(button)) return;
        requestAnimationFrame(() => {
            const active = document.activeElement;
            if ((active !== button && active !== document.body && active !== null) || getContextMenu() !== null) return;
            interactionRef.current?.focus({ preventScroll: true });
        });
    }, []);

    return <div ref={hostRef} className="board-viewer-host" onContextMenu={event => event.preventDefault()} onPointerDownCapture={() => { if (isVisible) onFocus(); }} onClick={returnKeyboard}>
        <BoardAccessibility name={name} source={view.accessibility} isVisible={isVisible} readOnly={readOnly}
            mirrorEnabled={!externalAccessibility} interactionRef={captureInteraction}>
            <div className="board-viewer-surface" ref={setSurface} aria-hidden="true" />
            <div className="board-viewer-overlay" ref={setOverlay} />
        </BoardAccessibility>
        <BoardPaintStatus readiness={readiness} paint={paint} isVisible={isVisible} reason={reason} />
        {readOnly && !admitting && <div className="board-viewer-notice" role="status">{reason ?? readOnlyNotice}</div>}
        {chrome}
    </div>;
}
