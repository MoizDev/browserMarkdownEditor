import { isEmbedContainmentApproved } from '../../platform/embedContainment';
import { EMBED_PROVIDER_ORIGINS } from '../../platform/embedPolicy';
import type { EmbedContainment, EmbedContainmentFactory, EmbedFrameManifest } from '../../platform/embedContainment.types';
import { checkContentUrl, type UrlEnvironment } from '../security/urlPolicy';
import { validBoardIdentity, type BoardJobIdentity } from '../workers/protocol';

// Provenance: SEC-6 exact-provider consent; the platform alone owns the opaque bootstrap and its private capability.
// Each provider maps a link a person can paste to that provider's own embeddable page. Each rule matches its path with
// identifier-only segments, so a link cannot smuggle a second address into the frame.
const ORIGINS: readonly string[] = EMBED_PROVIDER_ORIGINS;
const YOUTUBE_ORIGIN = 'https://www.youtube-nocookie.com', VIMEO_ORIGIN = 'https://player.vimeo.com';
export type EmbedManifest = EmbedFrameManifest;
export type EmbedProvider = 'youtube' | 'vimeo' | 'figma' | 'canva' | 'google-maps' | 'val-town' | 'codesandbox' | 'codepen'
    | 'scratch' | 'google-calendar' | 'google-slides' | 'replit' | 'felt' | 'spotify' | 'observable' | 'desmos' | 'tldraw';
export interface EmbedCandidate { readonly provider: EmbedProvider; readonly url: string }
/** The providers the Insert embed dialog lists (catalogue c.7's provider table), in its order, by the name each one goes by. */
export const EMBED_PROVIDER_NAMES: readonly string[] = Object.freeze(['YouTube', 'Vimeo', 'Figma', 'Canva', 'Google Maps', 'Val Town',
    'CodeSandbox', 'CodePen', 'Scratch', 'Google Calendar', 'Google Slides', 'Replit', 'Felt', 'Spotify', 'Observable', 'Desmos', 'tldraw']);
/** The size a pasted embed opens at, in world units. Most provider pages are 16:9; Spotify's player is a fixed-height strip,
 * which at 16:9 would leave most of the card empty. */
// Default size of a new embed per provider, in world units (the catalogue's per-provider table); Spotify opens at its
// player strip's height, and an unlisted provider uses the common size.
const EMBED_SIZES: Readonly<Partial<Record<EmbedProvider, { readonly w: number; readonly h: number }>>> = Object.freeze({
    youtube: { w: 800, h: 450 }, vimeo: { w: 640, h: 360 }, codepen: { w: 520, h: 400 }, scratch: { w: 520, h: 400 },
    desmos: { w: 700, h: 450 }, spotify: { w: 800, h: 352 },
});
const EMBED_SIZE_DEFAULT = Object.freeze({ w: 720, h: 500 });
export function embedCardSize(provider: EmbedProvider): { readonly w: number; readonly h: number } {
    return EMBED_SIZES[provider] ?? EMBED_SIZE_DEFAULT;
}
/** Every size the app gives an embed (and 800×450, the size every embed had before), so a card still at one of them takes
 * the size of its new kind on conversion. */
export const EMBED_CARD_SIZES: readonly { readonly w: number; readonly h: number }[] = [
    { w: 800, h: 450 }, EMBED_SIZE_DEFAULT, ...Object.values(EMBED_SIZES).filter(size => size !== undefined),
];
function enabledOrigins(manifest: EmbedManifest | undefined): readonly string[] | null {
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.origins) || !manifest.origins.length
        || manifest.origins.length > ORIGINS.length || new Set(manifest.origins).size !== manifest.origins.length
        || manifest.origins.some(origin => !ORIGINS.some(allowed => allowed === origin))) return null;
    return Object.freeze([...manifest.origins]);
}
/** One rule per provider: the hosts a link may come from, and the embeddable address its path names. */
interface ProviderRule { readonly provider: EmbedProvider; readonly hosts: readonly string[]; readonly embed: (source: URL) => string | null }
const PROVIDERS: readonly ProviderRule[] = [
    { provider: 'figma', hosts: ['www.figma.com', 'figma.com'], embed: source => {
        const match = /^\/(?:file|design|proto)\/([A-Za-z0-9]{1,128})(?:\/[^/]{0,200})?\/?$/.exec(source.pathname);
        if (!match) return null;
        return `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(`https://www.figma.com${source.pathname}`)}`;
    } },
    { provider: 'canva', hosts: ['www.canva.com'], embed: source => {
        const match = /^\/design\/([A-Za-z0-9_-]{1,128})(?:\/([A-Za-z0-9_-]{1,128}))?\/view\/?$/.exec(source.pathname);
        if (!match) return null;
        return `https://www.canva.com/design/${match[1]}${match[2] ? `/${match[2]}` : ''}/view?embed`;
    } },
    { provider: 'google-maps', hosts: ['www.google.com', 'maps.google.com'], embed: source => {
        if (!source.pathname.startsWith('/maps')) return null;
        let query = source.searchParams.get('q');
        if (!query) {
            const place = /^\/maps\/place\/([^/]{1,300})/.exec(source.pathname);
            if (place) { try { query = decodeURIComponent(place[1]); } catch { return null; } }
        }
        if (!query || query.length > 300) return null;
        return `https://www.google.com/maps?output=embed&q=${encodeURIComponent(query)}`;
    } },
    { provider: 'val-town', hosts: ['www.val.town'], embed: source => {
        const match = /^\/v\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})\/?$/.exec(source.pathname);
        return match ? `https://www.val.town/embed/${match[1]}/${match[2]}` : null;
    } },
    { provider: 'codesandbox', hosts: ['codesandbox.io'], embed: source => {
        const id = /^\/(?:s|p\/sandbox)\/([A-Za-z0-9_-]{1,128})\/?$/.exec(source.pathname)?.[1];
        return id ? `https://codesandbox.io/embed/${id}` : null;
    } },
    { provider: 'codepen', hosts: ['codepen.io'], embed: source => {
        const match = /^\/([A-Za-z0-9_-]{1,64})\/pen\/([A-Za-z0-9_-]{1,64})\/?$/.exec(source.pathname);
        return match ? `https://codepen.io/${match[1]}/embed/${match[2]}?default-tab=result` : null;
    } },
    { provider: 'scratch', hosts: ['scratch.mit.edu'], embed: source => {
        const id = /^\/projects\/([0-9]{1,20})\/?$/.exec(source.pathname)?.[1];
        return id ? `https://scratch.mit.edu/projects/${id}/embed` : null;
    } },
    { provider: 'google-calendar', hosts: ['calendar.google.com'], embed: source =>
        /^\/calendar\/(?:u\/[0-9]{1,3}\/)?embed\/?$/.test(source.pathname) ? `https://calendar.google.com${source.pathname}${source.search}` : null },
    { provider: 'google-slides', hosts: ['docs.google.com'], embed: source => {
        const id = /^\/presentation\/d\/([A-Za-z0-9_-]{1,128})(?:\/(?:edit|embed|pub))?\/?$/.exec(source.pathname)?.[1];
        return id ? `https://docs.google.com/presentation/d/${id}/embed` : null;
    } },
    { provider: 'replit', hosts: ['replit.com'], embed: source => {
        const match = /^\/@([A-Za-z0-9_.-]{1,64})\/([A-Za-z0-9_.-]{1,64})\/?$/.exec(source.pathname);
        return match ? `https://replit.com/@${match[1]}/${match[2]}?embed=true` : null;
    } },
    { provider: 'felt', hosts: ['felt.com'], embed: source => {
        const slug = /^\/map\/([A-Za-z0-9_.-]{1,200})\/?$/.exec(source.pathname)?.[1];
        return slug ? `https://felt.com/embed/map/${slug}` : null;
    } },
    { provider: 'spotify', hosts: ['open.spotify.com'], embed: source => {
        const match = /^\/(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{1,64})\/?$/.exec(source.pathname);
        return match ? `https://open.spotify.com/embed/${match[1]}/${match[2]}` : null;
    } },
    { provider: 'observable', hosts: ['observablehq.com'], embed: source => {
        const match = /^\/@([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,128})\/?$/.exec(source.pathname);
        return match ? `https://observablehq.com/embed/@${match[1]}/${match[2]}` : null;
    } },
    { provider: 'desmos', hosts: ['www.desmos.com'], embed: source => {
        const id = /^\/calculator\/([A-Za-z0-9_-]{1,64})\/?$/.exec(source.pathname)?.[1];
        return id ? `https://www.desmos.com/calculator/${id}?embed` : null;
    } },
    { provider: 'tldraw', hosts: ['www.tldraw.com'], embed: source => {
        const id = /^\/r\/([A-Za-z0-9_-]{1,128})\/?$/.exec(source.pathname)?.[1];
        return id ? `https://www.tldraw.com/r/${id}?embed=true` : null;
    } },
];
export function resolveEmbedCandidate(input: string, environment: UrlEnvironment, manifest?: EmbedManifest): EmbedCandidate | null {
    const origins = enabledOrigins(manifest); if (!origins) return null;
    const allowed = checkContentUrl(input, 'embed', environment); if (!allowed.ok) return null;
    const source = new URL(allowed.url); let provider: EmbedProvider, url: string;
    if (source.origin === 'https://www.youtube.com' || source.origin === 'https://youtube.com') {
        provider = 'youtube';
        let resource: string | null = null;
        if (source.pathname === '/watch') resource = source.searchParams.get('v');
        else resource = /^\/embed\/([A-Za-z0-9_-]{11})$/.exec(source.pathname)?.[1] ?? null;
        if (!resource || !/^[A-Za-z0-9_-]{11}$/.test(resource)) return null;
        url = `${YOUTUBE_ORIGIN}/embed/${resource}`;
    } else if (source.origin === 'https://youtu.be') {
        provider = 'youtube';
        const resource = /^\/([A-Za-z0-9_-]{11})$/.exec(source.pathname)?.[1];
        if (!resource) return null;
        url = `${YOUTUBE_ORIGIN}/embed/${resource}`;
    } else if (source.origin === YOUTUBE_ORIGIN && !source.search && !source.hash) {
        provider = 'youtube';
        const resource = /^\/embed\/([A-Za-z0-9_-]{11})$/.exec(source.pathname)?.[1];
        if (!resource) return null;
        url = `${YOUTUBE_ORIGIN}/embed/${resource}`;
    } else if (source.origin === 'https://vimeo.com' || source.origin === 'https://www.vimeo.com') {
        provider = 'vimeo';
        const resource = /^\/([0-9]{1,20})$/.exec(source.pathname)?.[1];
        if (!resource) return null;
        url = `${VIMEO_ORIGIN}/video/${resource}`;
    } else if (source.origin === VIMEO_ORIGIN && !source.search && !source.hash) {
        provider = 'vimeo';
        const resource = /^\/video\/([0-9]{1,20})$/.exec(source.pathname)?.[1];
        if (!resource) return null;
        url = `${VIMEO_ORIGIN}/video/${resource}`;
    } else {
        const rule = PROVIDERS.find(candidate => candidate.hosts.includes(source.hostname));
        const embedded = rule ? rule.embed(source) : null;
        if (!rule || !embedded) return null;
        provider = rule.provider; url = embedded;
    }
    // The address the frame loads must sit on an origin this manifest enables, or the provider is not offered.
    if (!origins.includes(new URL(url).origin)) return null;
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
