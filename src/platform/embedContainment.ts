import { runtime, scriptHash } from 'virtual:contained-embed';
import { createContainedFrame } from './containedFrame';
import { EMBED_PERMISSIONS, EMBED_PROFILE, embedFrameHtml, validateEmbedManifest, validateEmbedUrl } from './embedPolicy';
import type { EmbedContainment, EmbedContainmentFailure, EmbedContainmentOptions } from './embedContainment.types';

export type { EmbedContainment, EmbedContainmentFactory, EmbedContainmentOptions, EmbedFrameManifest } from './embedContainment.types';

type CredentiallessFrame = HTMLIFrameElement & { readonly credentialless: boolean };
interface ProfileState {
    readonly frame: HTMLIFrameElement;
    readonly html: string;
    window: Window | null;
    ready: boolean;
    closed: boolean;
}
const profiles = new WeakMap<object, ProfileState>();
const available = () => typeof HTMLIFrameElement !== 'undefined' && 'credentialless' in HTMLIFrameElement.prototype;

function configured(state: ProfileState): boolean {
    const frame = state.frame;
    return available() && frame.isConnected && frame.contentWindow === state.window
        && (frame as CredentiallessFrame).credentialless === true && frame.hasAttribute('credentialless')
        && frame.getAttribute('sandbox') === 'allow-scripts' && frame.referrerPolicy === 'no-referrer'
        && frame.getAttribute('allow') === EMBED_PERMISSIONS && !frame.hasAttribute('src') && frame.getAttribute('srcdoc') === state.html;
}

/** An object with matching fields is not a capability. Only a live wrapper whose own private
 * bootstrap completed the native/configured credentialless handshake enters this registry. */
export function isEmbedContainmentApproved(value: unknown): value is EmbedContainment {
    if (!value || typeof value !== 'object') return false;
    const state = profiles.get(value);
    return !!state && !state.closed && state.ready && configured(state);
}

export async function createEmbedContainment(options: EmbedContainmentOptions): Promise<EmbedContainment> {
    const { signal, container, onFailure } = options;
    signal?.throwIfAborted();
    if (!available()) throw new DOMException('Credentialless embed containment is unavailable', 'NotSupportedError');
    if (container.ownerDocument !== document || !container.isConnected) throw new Error('Embed container is not mounted');
    const manifest = validateEmbedManifest(options.manifest), url = validateEmbedUrl(options.url, manifest);
    const html = embedFrameHtml(runtime, scriptHash, manifest);
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
    let observer: MutationObserver | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let waiting: { type: 'ready' | 'mounted'; resolve(): void; reject(reason: unknown): void } | undefined;
    let loading: Promise<void> | undefined;

    const command = (type: 'load' | 'unload') => ({ v: 1, profile: EMBED_PROFILE, token, type });
    function clearWait(): typeof waiting {
        if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
        const prior = waiting; waiting = undefined;
        return prior;
    }
    function close(reason: unknown): void {
        if (state.closed) return;
        state.closed = true; state.ready = false;
        signal?.removeEventListener('abort', abort);
        observer?.disconnect();
        clearWait()?.reject(reason);
        contained.dispose();
    }
    function fail(reason: EmbedContainmentFailure, error: unknown = new Error(`Embed containment failed: ${reason}`)): void {
        if (state.closed) return;
        close(error);
        onFailure?.(reason);
    }
    function abort(): void { close(signal?.reason ?? new DOMException('Embed cancelled', 'AbortError')); }
    function dispose(): void {
        if (state.closed) return;
        try { contained.port.postMessage(command('unload')); } catch { /* Removing the wrapper also destroys its child. */ }
        close(new DOMException('Embed closed', 'AbortError'));
    }
    function wait(type: 'ready' | 'mounted'): Promise<void> {
        return new Promise((resolve, reject) => {
            waiting = { type, resolve, reject };
            timer = setTimeout(() => fail('handshake'), 5000);
        });
    }
    function message(event: MessageEvent): void {
        if (state.closed) return;
        const data = event.data as { v?: unknown; profile?: unknown; token?: unknown; type?: unknown; credentialless?: unknown } | null;
        if (!data || typeof data !== 'object' || Array.isArray(data) || data.v !== 1 || data.profile !== EMBED_PROFILE || data.token !== token) {
            fail('protocol'); return;
        }
        const ready = data.type === 'ready';
        if (Object.keys(data).length !== (ready ? 5 : 4)) { fail('protocol'); return; }
        if (data.type === 'blocked') { fail('blocked'); return; }
        if (data.type === 'unavailable') { fail('unavailable'); return; }
        if (!waiting || data.type !== waiting.type || (ready && data.credentialless !== true) || !configured(state)) {
            fail('protocol'); return;
        }
        if (ready) state.ready = true;
        clearWait()?.resolve();
    }
    const contained = createContainedFrame({
        html, init: { v: 1, type: 'init', profile: EMBED_PROFILE, token, origins: manifest.origins, url },
        credentialless: true, permissionPolicy: EMBED_PERMISSIONS,
        className: options.className, ariaLabel: options.ariaLabel ?? 'Embedded provider',
        onMessage: message,
        onFailure: reason => fail(reason === 'navigation' ? 'navigation' : reason === 'handoff' ? 'handshake' : 'protocol'),
    });
    const state: ProfileState = { frame: contained.frame, html, window: null, ready: false, closed: false };
    const capability: EmbedContainment = Object.freeze({
        element: contained.frame, url,
        load(): Promise<void> {
            if (!isEmbedContainmentApproved(capability)) {
                dispose();
                return Promise.reject(new DOMException('Embed containment is no longer approved', 'InvalidStateError'));
            }
            if (loading) return loading;
            loading = wait('mounted');
            try { contained.port.postMessage(command('load')); } catch (error) { fail('protocol', error); }
            return loading;
        },
        unload: dispose, dispose,
    });
    profiles.set(capability, state);
    signal?.addEventListener('abort', abort, { once: true });
    const ready = wait('ready');
    try {
        contained.mount(container);
        state.window = contained.frame.contentWindow;
        if (!configured(state)) fail('configuration');
        if (!state.closed) {
            observer = new MutationObserver(() => { if (!state.closed && !configured(state)) fail('configuration'); });
            observer.observe(contained.frame, { attributes: true, attributeFilter: ['sandbox', 'allow', 'credentialless', 'referrerpolicy', 'src', 'srcdoc'] });
        }
    } catch (error) { fail('configuration', error); }
    await ready;
    signal?.throwIfAborted();
    if (!isEmbedContainmentApproved(capability)) { dispose(); throw new Error('Embed profile did not initialize'); }
    return capability;
}
