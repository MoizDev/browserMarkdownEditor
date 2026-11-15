// Panes float over their layout slots so tab switches do not replace their
// document-owned runtime, input history or camera. Hidden work is explicitly gated.
import React, { Suspense, lazy, useState, useSyncExternalStore } from 'react';
import DiskBar from './DiskBar';
import { useActivated, useFloatingSlot } from './floatingSlot';
import { routeEngines } from '../utils/engineRouting';
import { BOARD_Z_MAX } from '../utils/boardZMax';
import { getSessionIdentity, subscribeSessionIdentity } from '../utils/sessionIdentity';
import type { ActiveFile, DiskAction, Theme } from '../types';
import type { DocumentRepresentation } from '../types/reading';
import type { NativeCanvasHost } from '../types/nativeCanvas';

const NativeCanvasEntry = lazy(() => import('./whiteboard/NativeCanvasEntry'));
const DRAWING_VIEW_LIMITS = Object.freeze({ min: 0.01, max: 100 });
const PAGED_VIEW_LIMITS = Object.freeze({ min: 0.4, max: 4 });
const DRAWING_VIEW_INSETS = Object.freeze({ left: 0, right: 0, top: 0, bottom: 0 });
const PAGED_VIEW_INSETS = Object.freeze({ left: 28, right: 28, top: 16, bottom: 0 });

export interface CanvasPaneProps {
    file: ActiveFile;
    documentId: string;
    nativeCanvasHost: NativeCanvasHost;
    representation: DocumentRepresentation;
    onNativeCanvasReady: import('../types/reading').NativeCanvasReady;
    attachCanvasSession?: import('../utils/canvasSessionBridge').AttachCanvasSession;
    isVisible: boolean;
    isFocused: boolean;
    slotIndex: number;
    slotLeft: number;
    slotWidth: number;
    onFocusPane: (path: string) => void;
    registerKeyboardTarget: (path: string, take: () => void) => () => void;
    theme: Theme;
    disk?: 'conflict' | 'deleted';
    onDiskAction: (path: string, action: DiskAction) => Promise<void>;
}

function CanvasPane({ file, documentId, nativeCanvasHost, representation, onNativeCanvasReady, attachCanvasSession,
    isVisible, isFocused, slotIndex, slotLeft, slotWidth, onFocusPane, registerKeyboardTarget, theme, disk, onDiskAction }: CanvasPaneProps) {
    const activated = useActivated(isVisible);
    const [routes] = useState(() => routeEngines());
    const slotStyle = useFloatingSlot(isVisible, slotIndex, slotLeft, slotWidth);
    const loadedKind = representation.status === 'ready' ? representation.loadedKind : undefined;
    const isNotebook = loadedKind === 'notebook';
    const canvas = loadedKind === 'drawing' || isNotebook;
    // Identity is published by App's layout effect; subscribe rather than waiting
    // for an unrelated UI update before the first native acquisition can start.
    const session = useSyncExternalStore(subscribeSessionIdentity, () => getSessionIdentity(documentId), () => undefined);
    const identity = canvas && session ? nativeCanvasHost.identity(documentId) : undefined;
    const route = routes.canvas[isNotebook ? 'notebook' : 'drawing'];
    const label = isNotebook ? 'Loading notebook…' : 'Loading whiteboard…';
    return <div className={`canvas-pane${isVisible ? '' : ' canvas-pane-hidden'}`} style={slotStyle}
        onPointerDownCapture={() => { if (isVisible) onFocusPane(file.path); }}>
        {disk && <DiskBar name={file.name} state={disk} path={file.path} onAction={onDiskAction} />}
        <div className="canvas-pane-body">
            {activated && identity && attachCanvasSession ? <Suspense fallback={<div role="status">{label}</div>}>
                <NativeCanvasEntry file={file} documentId={documentId} identity={identity} nativeCanvasHost={nativeCanvasHost}
                    attachCanvasSession={attachCanvasSession} onNativeCanvasReady={onNativeCanvasReady}
                    isVisible={isVisible} isFocused={isFocused} theme={theme} emergencyReadOnly={route.emergencyReadOnly}
                    zoomLimits={isNotebook ? PAGED_VIEW_LIMITS : DRAWING_VIEW_LIMITS}
                    insets={isNotebook ? PAGED_VIEW_INSETS : DRAWING_VIEW_INSETS}
                    zMax={BOARD_Z_MAX} deadlineMs={30_000} registerKeyboardTarget={registerKeyboardTarget} onFocusPane={onFocusPane} />
            </Suspense> : activated && <div role="status">Preparing canvas document…</div>}
        </div>
    </div>;
}

export default React.memo(CanvasPane);
