import type { CameraController } from '../../platform/render/camera';
import type { RenderToken } from '../../platform/render/types';
import { getBoardRuntime } from '../host/runtime';
import type { BoardInputMode, BoardInputView } from '../input/attach';
import type { InputToken } from '../input/tool';
import type { BoardSession } from '../session/BoardSession';
import { createBoardInputHost, type BoardInputHostOptions } from './inputHost';
import { createBoardToolServices, type BoardToolServicesOptions } from './toolServices';
import type { ViewerEngine } from './types';
import { NO_SENSITIVE_IDS } from './sensitiveTargets';

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
    readonly presented?: BoardInputHostOptions['presented'];
}

export function createNativeEditingInput(options: NativeEditingOptions) {
    const runtime = getBoardRuntime(options.session);
    if (!runtime || runtime.session !== options.session) throw new Error('Native editing requires the App-owned board runtime');
    let active: ReturnType<typeof createBoardToolServices> | null = null;
    const release = () => { const tools = active; active = null; tools?.dispose(); };
    const host = createBoardInputHost({ session: options.session, runtime, engine: options.engine, token: options.token,
        inputToken: options.inputToken, camera: options.camera, viewport: options.viewport, current: options.current,
        visible: options.visible, focused: options.focused, mode: options.mode, a11y: options.a11y, paged: options.paged,
        invalidate: options.invalidate, onError: options.onError,
        presented(revision, token, frame, context) { options.presented?.(revision, token, frame, context); active?.presented(revision, token, frame); },
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
            sensitiveNodeIds: () => active?.sensitiveNodeIds() ?? NO_SENSITIVE_IDS,
        } });
    const { dispose: disposeHost, ...input } = host;
    return {
        ...input,
        tools: () => active,
        dispose() { disposeHost(); release(); },
    };
}
