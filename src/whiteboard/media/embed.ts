import { isEmbedContainmentApproved } from '../../platform/embedContainment';
import type { EmbedContainment, EmbedContainmentFactory, EmbedFrameManifest } from '../../platform/embedContainment.types';
import { checkContentUrl, type UrlEnvironment } from '../security/urlPolicy';
import { validBoardIdentity, type BoardJobIdentity } from '../workers/protocol';

// Provenance: SEC-6 exact-provider consent; the platform alone owns the opaque bootstrap and its private capability.
const ORIGINS = Object.freeze(['https://www.youtube-nocookie.com', 'https://player.vimeo.com'] as const);
export type EmbedManifest = EmbedFrameManifest;
export interface EmbedCandidate { readonly provider: 'youtube' | 'vimeo'; readonly url: string }
function enabledOrigins(manifest: EmbedManifest | undefined): readonly string[] | null {
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.origins) || !manifest.origins.length
        || manifest.origins.length > ORIGINS.length || new Set(manifest.origins).size !== manifest.origins.length
        || manifest.origins.some(origin => !ORIGINS.some(allowed => allowed === origin))) return null;
    return Object.freeze([...manifest.origins]);
}
export function resolveEmbedCandidate(input: string, environment: UrlEnvironment, manifest?: EmbedManifest): EmbedCandidate | null {
    const origins = enabledOrigins(manifest); if (!origins) return null;
    const allowed = checkContentUrl(input, 'embed', environment); if (!allowed.ok) return null;
    const source = new URL(allowed.url); let provider: EmbedCandidate['provider'], resource: string | null = null;
    if (source.origin === 'https://www.youtube.com' || source.origin === 'https://youtube.com') {
        provider = 'youtube';
        if (source.pathname === '/watch') resource = source.searchParams.get('v');
        else { const match = /^\/embed\/([A-Za-z0-9_-]{11})$/.exec(source.pathname); resource = match?.[1] ?? null; }
    } else if (source.origin === 'https://youtu.be') {
        provider = 'youtube'; resource = /^\/([A-Za-z0-9_-]{11})$/.exec(source.pathname)?.[1] ?? null;
    } else if (source.origin === ORIGINS[0] && !source.search && !source.hash) {
        provider = 'youtube'; resource = /^\/embed\/([A-Za-z0-9_-]{11})$/.exec(source.pathname)?.[1] ?? null;
    } else if (source.origin === 'https://vimeo.com' || source.origin === 'https://www.vimeo.com') {
        provider = 'vimeo'; resource = /^\/([0-9]{1,20})$/.exec(source.pathname)?.[1] ?? null;
    } else if (source.origin === ORIGINS[1] && !source.search && !source.hash) {
        provider = 'vimeo'; resource = /^\/video\/([0-9]{1,20})$/.exec(source.pathname)?.[1] ?? null;
    } else return null;
    if (!resource || (provider === 'youtube' && !/^[A-Za-z0-9_-]{11}$/.test(resource))) return null;
    const origin = provider === 'youtube' ? ORIGINS[0] : ORIGINS[1];
    if (!origins.includes(origin)) return null;
    const url = provider === 'youtube' ? `${origin}/embed/${resource}` : `${origin}/video/${resource}`;
    return Object.freeze({ provider, url });
}
export interface EmbedLease {
    readonly element: HTMLIFrameElement;
    readonly containment: EmbedContainment;
    update(visible: boolean, input: string): void;
    dispose(): void;
}
/** Only a semantic per-node Load calls this. Restoration, painting and URL recognition never do. */
export async function activateEmbed(options: {
    readonly input: string; readonly environment: UrlEnvironment; readonly manifest: EmbedManifest; readonly container: HTMLElement;
    readonly identity: BoardJobIdentity; readonly signal?: AbortSignal;
    readonly containment: EmbedContainmentFactory;
    current(identity: BoardJobIdentity): boolean;
    onFailure?(error: Error): void;
}): Promise<EmbedLease> {
    options.signal?.throwIfAborted();
    if (!validBoardIdentity(options.identity)) throw new TypeError('Invalid embed owner identity');
    const origins = enabledOrigins(options.manifest), candidate = resolveEmbedCandidate(options.input, options.environment, options.manifest);
    if (!origins || !candidate || !checkContentUrl(candidate.url, 'embed', options.environment).ok) throw new Error('This embed provider is unsupported');
    const identity = Object.freeze({ ...options.identity }), lifetime = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
    let value: EmbedContainment | undefined, closed = false, failure: Error | undefined;
    const dispose = () => { if (closed) return; closed = true; signal.removeEventListener('abort', dispose); lifetime.abort(); value?.dispose(); };
    const check = () => {
        signal.throwIfAborted();
        if (closed || failure || !options.current(identity) || enabledOrigins(options.manifest)?.join(' ') !== origins.join(' ')) {
            throw failure ?? new DOMException('Embed became stale', 'AbortError');
        }
    };
    signal.addEventListener('abort', dispose, { once: true });
    try {
        check();
        // Full consent lifetime, not a five-second setup signal. The platform owns handshake deadlines.
        value = await options.containment({ container: options.container, url: candidate.url, manifest: options.manifest, signal,
            onFailure(reason) {
                failure = new Error(`Embed containment failed: ${reason}`); dispose();
                try { options.onFailure?.(failure); } catch { /* Failure reporting cannot keep foreign content alive. */ }
            } });
        check();
        if (!isEmbedContainmentApproved(value) || value.url !== candidate.url || value.element.parentElement !== options.container) {
            throw new Error('The platform did not admit this exact embed containment');
        }
        await value.load(); check();
        const admitted = value;
        return Object.freeze({ element: admitted.element, containment: admitted,
            update(visible: boolean, input: string) {
                if (closed) return;
                if (!visible || input !== options.input) { dispose(); return; }
                try { check(); } catch { dispose(); }
            }, dispose });
    } catch (error) {
        // A constructor may ignore cancellation and fulfil late: its actual foreign frame must still close.
        dispose(); value?.dispose(); throw error;
    }
}
