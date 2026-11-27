import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { usePlatformPane, type UsePlatformPaneOptions } from '../platformPane/usePlatformPane';
import BoardAccessibility, { type BoardAccessibilitySource } from './BoardAccessibility';
import type { PlatformPane } from '../../platform/render/attachPlatformPane.types';
import type { RenderToken } from '../../platform/render/types';
import BoardPaintStatus, { type BoardNoun, type BoardPaintProgress, type BoardReadiness } from './BoardPaintStatus';
import { getContextMenu } from '../../utils/contextMenu';
import { installPenDoubleClick } from './penDoubleClick';
import './viewerHost.css';

export interface ViewerViewHandle {
    readonly accessibility: BoardAccessibilitySource;
    readonly sourceToken?: RenderToken;
    subscribe(listener: (change?: 'state' | 'paint') => void): () => void;
    setView(view: { visible: boolean; focused: boolean; theme: 'light' | 'dark'; inverted: boolean }): void;
    attachInput(interaction: HTMLElement, overlay: HTMLElement): () => void;
    attachPlatform?(pane: PlatformPane | null): void;
}
export interface ViewerHostProps<T extends object> {
    readonly name: string;
    readonly noun: BoardNoun;
    readonly documentId: string;
    readonly vaultEpoch: number;
    readonly isVisible: boolean;
    readonly isFocused: boolean;
    readonly theme: 'light' | 'dark';
    readonly inverted: boolean;
    readonly reason: string | null;
    readonly readOnlyNotice: string;
    readonly readiness?: BoardReadiness;
    readonly paint?: BoardPaintProgress;
    readonly readOnly?: boolean;
    readonly admitting?: boolean;
    readonly externalAccessibility?: boolean;
    readonly view: ViewerViewHandle;
    readonly layers: UsePlatformPaneOptions<T>['layers'];
    readonly platform: UsePlatformPaneOptions<T>['services'];
    readonly registerKeyboardTarget: (focus: () => void) => () => void;
    readonly onFocus: () => void;
    readonly chrome?: ReactNode;
}

const CHROME_STACK_BELOW_PX = 780;

export default function ViewerHost<T extends object>({
    name, noun, documentId, vaultEpoch, isVisible, isFocused, theme, inverted, reason, readOnlyNotice, readOnly = true, admitting = false, externalAccessibility = false,
    view, layers, platform, registerKeyboardTarget, onFocus, chrome, readiness, paint,
}: ViewerHostProps<T>) {
    const [surface, setSurface] = useState<HTMLDivElement | null>(null);
    const hostRef = useRef<HTMLDivElement | null>(null);
    useLayoutEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const observer = new ResizeObserver(entries => {
            const width = entries[entries.length - 1]?.contentRect.width ?? host.clientWidth;
            if (width > 0) host.toggleAttribute('data-chrome-stacked', width < CHROME_STACK_BELOW_PX);
        });
        observer.observe(host);
        return () => observer.disconnect();
    }, []);
    useLayoutEffect(() => { const host = hostRef.current; return host ? installPenDoubleClick(host) : undefined; }, []);
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
        <BoardPaintStatus readiness={readiness} paint={paint} isVisible={isVisible} reason={reason} noun={noun} />
        {readOnly && !admitting && (reason ?? readOnlyNotice) && <div className="board-viewer-notice" role="status">{reason ?? readOnlyNotice}</div>}
        {chrome}
    </div>;
}
