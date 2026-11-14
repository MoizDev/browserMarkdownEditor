import type { PlatformPaneOptions } from '../../platform/render/attachPlatformPane.types';
import type { CameraController } from '../../platform/render/camera';
import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import type { BoardSession } from '../../whiteboard/session/BoardSession';
import type { ViewerEngine } from '../../whiteboard/viewer/types';

type Services = Omit<PlatformPaneOptions<object>, 'documentToken' | 'initialVisible' | 'initialFocused' | 'layers'>;
type NativeViewPorts = Pick<Services, 'consumeInput' | 'isInteracting' | 'setInputEnabled' | 'cancelViewWork'
    | 'writeOverlays' | 'onPresentation' | 'onError' | 'onNotice'>;

/** Construct once per view lease; callbacks read the live viewer and the one shared camera. */
export function createNativeViewPlatform(options: {
    host: NativeCanvasHost;
    identity: NativeCanvasIdentity;
    board: BoardSession;
    viewer: ViewerEngine;
    camera: CameraController;
    paneId: string;
    viewLease: number;
    readSheetId(): string;
    captureRegion?: NonNullable<Services['session']['captureRegion']>;
    captureBlob?: NonNullable<Services['session']['captureBlob']>;
    ports: NativeViewPorts;
}): Services {
    const { host, identity, board, viewer, camera, paneId, viewLease, ports } = options;
    if (viewer.session !== board || board.owner.documentId !== identity.documentId || board.owner.session !== identity.session) {
        throw new Error('Native view session does not match its owner');
    }
    const token = Object.freeze({ documentId: identity.documentId, session: identity.session,
        vaultEpoch: identity.vaultActivation, bytesGeneration: identity.bytesGeneration });
    return {
        paneId, viewLease, camera, backendPreference: viewer.getSnapshot().backendPreference,
        session: { mirrors: null, checkpoint: () => { if (board.hasPendingEdits()) board.checkpoint(); },
            ...(options.captureRegion ? { captureRegion: options.captureRegion } : {}),
            ...(options.captureBlob ? { captureBlob: options.captureBlob } : {}) },
        layout: viewer.getSnapshot().layout,
        readLayout: () => viewer.getSnapshot().layout,
        readAppearance: () => viewer.getSnapshot().appearance,
        currentToken: () => host.isCurrent(identity) ? token : null,
        readCamera: () => camera.camera,
        revision: () => JSON.stringify([viewer.getSnapshot().sceneRevision, options.readSheetId()]),
        consumeInput: timestamp => ports.consumeInput(timestamp),
        isInteracting: () => ports.isInteracting(),
        setInputEnabled: enabled => ports.setInputEnabled(enabled),
        cancelViewWork: reason => ports.cancelViewWork(reason),
        writeOverlays: frame => ports.writeOverlays(frame),
        onPresentation: presentation => ports.onPresentation(presentation),
        onError: error => ports.onError(error),
        onNotice: message => ports.onNotice(message),
    };
}
