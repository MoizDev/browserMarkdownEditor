import type { CameraController } from '../../platform/render/camera';
import type { RenderToken } from '../../platform/render/types';
import { getBoardRuntime } from '../host/runtime';
import type { BoardInputMode, BoardInputView } from '../input/attach';
import type { InputToken } from '../input/tool';
import type { BoardSession } from '../session/BoardSession';
import { createBoardInputHost } from './inputHost';
import { createBoardToolServices, type BoardToolServicesOptions } from './toolServices';
import type { ViewerEngine } from './types';

// Provenance: the view-owned composition of the input host and tool services,
// written against this repository's own viewer contracts; no third-party source.

/** Caller-supplied ports: Core owns React, App owns commands, imports and UI state. Nothing here is synthesised. */
export interface NativeEditingOptions extends Pick<BoardToolServicesOptions, 'view' | 'viewport' | 'images' | 'spelling'
    | 'platform' | 'ui' | 'commands' | 'imports'> {
    readonly session: BoardSession;
    readonly engine: ViewerEngine;
    readonly token: RenderToken;
    readonly inputToken: InputToken;
    readonly camera: CameraController;
    readonly mode: BoardInputMode;
    readonly paged: boolean;
    readonly a11y: BoardInputView['a11y'];
    readonly current: (token: RenderToken) => boolean;
    readonly visible: () => boolean;
    readonly focused: () => boolean;
    readonly editable: () => boolean;
    readonly invalidate: () => void;
    readonly cameraChanged: () => void;
    readonly onError: (error: unknown) => void;
}

/**
 * One live tool set per attachment: the host creates services for each surface it
 * binds and releases them when that binding ends, so no paste listener or pending
 * gesture outlives the surface it was made for.
 */
export function createNativeEditingInput(options: NativeEditingOptions) {
    const runtime = getBoardRuntime(options.session);
    if (!runtime || runtime.session !== options.session) throw new Error('Native editing requires the App-owned board runtime');
    let active: ReturnType<typeof createBoardToolServices> | null = null;
    const release = () => { const tools = active; active = null; tools?.dispose(); };
    const host = createBoardInputHost({ session: options.session, runtime, engine: options.engine, token: options.token,
        inputToken: options.inputToken, camera: options.camera, viewport: options.viewport, current: options.current,
        visible: options.visible, focused: options.focused, mode: options.mode, a11y: options.a11y, paged: options.paged,
        invalidate: options.invalidate, onError: options.onError,
        services(surface, overlay, _wet, ports) {
            release();
            const tools = createBoardToolServices({ runtime, engine: options.engine, spelling: options.spelling, images: options.images,
                camera: options.camera, view: options.view, viewport: options.viewport, surface, overlay, token: options.token,
                inputToken: options.inputToken, current: options.current, editable: options.editable, visible: options.visible,
                focused: options.focused, inputFrames: { schedule: ports.schedule }, mappings: ports.mappings,
                sampleToSurface: ports.sampleToSurface, clientToSurface: ports.clientToSurface,
                interaction: { invalidate: options.invalidate, cameraChanged: options.cameraChanged },
                platform: options.platform, ui: options.ui, commands: options.commands, imports: options.imports });
            active = tools;
            return tools.services;
        },
        released: release,
        overlays: {
            write(frame, overlay) { void overlay; active?.writeOverlays(frame); },
            finishComposition: () => active?.finishComposition(),
            captureText: () => active?.captureText(),
            restoreText: value => active?.restoreText(value),
            beforeHistoryReplay: (step, direction) => active?.beforeHistoryReplay(step, direction) ?? true,
        } });
    const { dispose: disposeHost, ...input } = host;
    return {
        ...input,
        /** The tool set bound to the current attachment, or null when detached. */
        tools: () => active,
        dispose() { disposeHost(); release(); },
    };
}
