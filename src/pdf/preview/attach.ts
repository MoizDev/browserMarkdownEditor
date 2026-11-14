import { attachPlatformPane } from '../../platform/render/cpuEntry';
import type { Layer, PlatformLayerDefinition, PlatformPane, RenderToken } from '../../platform/render';
import { getSessionIdentity } from '../../utils/sessionIdentity';
import { PreviewBitmapLayer } from './bitmapLayer';
import type { PdfPreview, PreviewBinding, PreviewSnapshot } from '../../utils/pdfPreviewTypes';
import { PreviewScene } from './scene';

interface PreviewOptions {
    readonly root: HTMLElement;
    readonly token: PreviewBinding;
    readSnapshot(): PreviewSnapshot | null;
    onNotice(message: string): void;
}

let nextView = 0;

function sameToken(a: RenderToken, b: RenderToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId
        && a.bytesGeneration === b.bytesGeneration && a.session === b.session;
}

function background(root: HTMLElement): readonly [number, number, number, number] {
    const pane = root.closest('.pdf-pane');
    const value = pane ? getComputedStyle(pane).backgroundColor : '';
    const channels = value.match(/[\d.]+/g)?.map(Number);
    if (!channels || channels.length < 3) return [0.12, 0.12, 0.12, 1];
    return [channels[0] / 255, channels[1] / 255, channels[2] / 255, 1];
}

/** The PDF viewer is the source of truth; these copies die with this view, not the document. */
export function createPdfPreview(options: PreviewOptions): PdfPreview {
    if (nextView === Number.MAX_SAFE_INTEGER) throw new RangeError('Preview view serial exhausted');
    const viewLease = ++nextView;
    const token: RenderToken = options.token;
    const host = document.createElement('div');
    host.className = 'pdf-platform-preview-surface';
    host.setAttribute('aria-hidden', 'true');
    options.root.append(host);
    let disposed = false;
    let visible = false;
    let pressureNotified = false;
    let pane: PlatformPane | null = null;
    let scene: PreviewScene | null = null;
    let colour = background(options.root);
    let width = -1, height = -1;

    const conceal = () => options.root.classList.remove('pdf-platform-preview-live');
    const liveToken = (): RenderToken | null => {
        if (disposed) return null;
        const identity = getSessionIdentity(token.documentId);
        return identity?.serial === token.session && identity.bytesGeneration === token.bytesGeneration ? token : null;
    };
    const definition: PlatformLayerDefinition & { cpuWorkingSet(layer: Layer, viewport: Readonly<{ width: number; height: number }>): { mandatoryBytes: number; prefetchBytes: number } } = {
        id: 'classic-pdf-pages', group: 'document',
        cpuWorkingSet(_layer, viewport) {
            const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
            return { mandatoryBytes: (width + 2 * Math.ceil(width / 512) + 8) * (height + 2 * Math.ceil(height / 512) + 8) * 4,
                prefetchBytes: 0 };
        },
        create(layerHost) {
            const layer = new PreviewBitmapLayer(layerHost);
            scene = new PreviewScene(layer, () => { conceal(); pane?.invalidate('pdf-preview-scene'); }, () => {
                if (pressureNotified) return;
                pressureNotified = true;
                options.onNotice('PDF platform preview could not fit in memory; showing the classic view.');
            });
            return layer;
        },
        revision: () => scene?.revision ?? 0,
        critical: (layer, view) => layer instanceof PreviewBitmapLayer && layer.hasGpuWork(view),
        coverage: (_layer, frame, backend) => scene?.coverage(frame.view, backend !== 'canvas2d') ?? { complete: false, sharp: false },
    };
    const revision = () => String(scene?.revision ?? 0);
    try {
        pane = attachPlatformPane(host, {
            paneId: `pdf-preview-${viewLease}`, viewLease, documentToken: token,
            session: { mirrors: null, checkpoint() {} }, layers: [definition],
            initialVisible: false, initialFocused: false, layout: null,
            readAppearance: () => ({ background: colour, inverted: scene?.snapshot?.inverted ?? false }),
            currentToken: liveToken,
            readCamera: () => scene?.snapshot?.camera ?? { x: 0, y: 0, z: 1 },
            revision,
            consumeInput() {}, isInteracting: () => (scene?.snapshot?.camera.z ?? 1) !== 1,
            setInputEnabled() {}, cancelViewWork() {}, writeOverlays() {},
            onPresentation(report) {
                const current = liveToken();
                if (!visible || !report || !current || !sameToken(report.token, current)
                    || !report.complete || report.revision !== revision()) {
                    conceal();
                    return;
                }
                pressureNotified = false;
                options.root.classList.add('pdf-platform-preview-live');
            },
            onError(error) { conceal(); console.error('PDF platform preview failed:', error); },
            onNotice(message) {
                if (message === 'memory-pressure' && !pressureNotified) {
                    pressureNotified = true;
                    options.onNotice('PDF platform preview could not fit in memory; showing the classic view.');
                }
            },
        });
    } catch (error) {
        host.remove();
        throw error;
    }

    const sync = () => {
        if (disposed || !visible) return;
        conceal();
        const snapshot = options.readSnapshot();
        colour = background(options.root);
        if (snapshot) {
            const scroll = snapshot.scroll;
            host.style.left = `${scroll.offsetLeft}px`;
            host.style.top = `${scroll.offsetTop}px`;
            if (width !== scroll.clientWidth || height !== scroll.clientHeight) {
                width = scroll.clientWidth;
                height = scroll.clientHeight;
                host.style.width = `${width}px`;
                host.style.height = `${height}px`;
                pane?.observeSize();
            }
        }
        scene?.sync(snapshot);
        pane?.invalidate('pdf-preview-view');
    };
    const themeObserver = new MutationObserver(sync);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    return {
        sync,
        setVisible(value) {
            if (disposed || value === visible) return;
            visible = value;
            if (!visible) conceal();
            scene?.setVisible(value);
            pane?.setVisible(value);
        },
        setFocused(value) { if (!disposed) pane?.setFocused(value); },
        dispose() {
            if (disposed) return;
            disposed = true;
            conceal();
            themeObserver.disconnect();
            scene?.dispose();
            pane?.dispose();
            host.remove();
        },
    };
}
