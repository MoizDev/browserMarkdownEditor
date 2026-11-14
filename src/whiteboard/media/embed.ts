import { createContainedFrame } from '../../platform/containedFrame';
import { checkContentUrl, type UrlEnvironment } from '../security/urlPolicy';
import { matchingIdentity, validBoardIdentity, type BoardJobIdentity } from '../workers/protocol';

// Provenance: SEC-6/§8 exact-provider containment and per-embed consent;
// independent URL grammar and fixed bootstrap, no upstream engine source.
const ORIGINS = Object.freeze(['https://www.youtube-nocookie.com', 'https://player.vimeo.com'] as const);
const BOOTSTRAP = String.raw`(()=>{const init=e=>{if(e.source!==parent||e.ports.length!==1)return;const d=e.data;if(!d||d.v!==1||typeof d.token!=='string'||!/^[0-9a-f]{32}$/.test(d.token)||!d.identity)return;removeEventListener('message',init);const p=e.ports[0],t=d.token,i=d.identity;let f=null;const send=type=>p.postMessage({v:1,token:t,identity:i,type});p.onmessage=m=>{const q=m.data;if(!q||q.v!==1||q.token!==t||!q.identity||q.identity.session!==i.session||q.identity.epoch!==i.epoch||q.identity.revision!==i.revision)return;if(q.type==='unload'){if(f)f.remove();f=null;return}if(q.type!=='load'||f||typeof q.url!=='string')return;let u;try{u=new URL(q.url)}catch{return}if(u.username||u.password||u.search||u.hash)return;if(!(u.origin==='https://www.youtube-nocookie.com'&&/^\/embed\/[A-Za-z0-9_-]{11}$/.test(u.pathname))&&!(u.origin==='https://player.vimeo.com'&&/^\/video\/[0-9]{1,20}$/.test(u.pathname)))return;f=document.createElement('iframe');f.setAttribute('sandbox','allow-scripts');f.setAttribute('credentialless','');f.setAttribute('referrerpolicy','no-referrer');f.setAttribute('allow',"camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; payment 'none'; usb 'none'; serial 'none'; bluetooth 'none'; hid 'none'; midi 'none'; display-capture 'none'; screen-wake-lock 'none'; web-share 'none'; xr-spatial-tracking 'none'; autoplay 'none'; encrypted-media 'none'; accelerometer 'none'; gyroscope 'none'; magnetometer 'none'");f.width='100%';f.height='100%';f.frameBorder='0';f.src=u.href;document.body.append(f);send('loaded')};p.start();send('ready')};addEventListener('message',init)})();`;
export interface EmbedManifest { readonly version: 1; readonly origins: readonly string[] }
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
    } else if (source.origin === 'https://vimeo.com' || source.origin === 'https://www.vimeo.com') {
        provider = 'vimeo'; resource = /^\/([0-9]{1,20})$/.exec(source.pathname)?.[1] ?? null;
    } else return null;
    if (!resource || (provider === 'youtube' && !/^[A-Za-z0-9_-]{11}$/.test(resource))) return null;
    const origin = provider === 'youtube' ? ORIGINS[0] : ORIGINS[1];
    if (!origins.includes(origin)) return null;
    const url = provider === 'youtube' ? `${origin}/embed/${resource}` : `${origin}/video/${resource}`;
    return Object.freeze({ provider, url });
}
export interface EmbedLease {
    readonly element: HTMLIFrameElement;
    /** Hide, URL change, close or reload must dispose; showing again requires fresh consent. */
    dispose(): void;
}
/** Invoke only after this embed's explicit Load action. */
export async function activateEmbed(options: {
    readonly input: string; readonly environment: UrlEnvironment; readonly manifest: EmbedManifest; readonly container: HTMLElement;
    readonly identity: BoardJobIdentity; readonly signal?: AbortSignal;
    /** Platform must explicitly admit its tested credentialless containment profile. */
    containmentApproved(): boolean;
    current(identity: BoardJobIdentity): boolean;
}): Promise<EmbedLease> {
    options.signal?.throwIfAborted();
    if (!('credentialless' in HTMLIFrameElement.prototype) || !validBoardIdentity(options.identity) || !options.containmentApproved()) throw new Error('Credentialless embed containment is unavailable');
    const origins = enabledOrigins(options.manifest), candidate = resolveEmbedCandidate(options.input, options.environment, options.manifest);
    if (!origins || !candidate || !checkContentUrl(candidate.url, 'embed', options.environment).ok) throw new Error('This embed provider is unsupported');
    const identity = Object.freeze({ ...options.identity }), signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
    const check = () => {
        signal.throwIfAborted();
        const currentOrigins = enabledOrigins(options.manifest);
        if (!currentOrigins || currentOrigins.join(' ') !== origins.join(' ') || !options.containmentApproved() || !options.current(identity)) {
            throw new DOMException('Embed became stale', 'AbortError');
        }
    };
    check();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(BOOTSTRAP))); check();
    const hash = btoa(String.fromCharCode(...digest));
    const csp = `default-src 'none'; script-src 'sha256-${hash}'; script-src-attr 'none'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; style-src 'none'; frame-src ${origins.join(' ')}; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script>${BOOTSTRAP}</script></body></html>`;
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
    const lifetime = new AbortController();
    let closed = false, pending: ((type: string) => void) | undefined, rejectPending: ((reason: unknown) => void) | undefined, failure: unknown;
    const fail = (error: unknown) => { failure = error; rejectPending?.(error); pending = undefined; rejectPending = undefined; };
    const abort = () => fail(signal.reason ?? new DOMException('Embed cancelled', 'AbortError'));
    const frame = createContainedFrame({ html, init: { v: 1, token, identity }, signal: lifetime.signal, credentialless: true,
        onFailure: reason => fail(new Error(`Embed containment failed: ${reason}`)),
        onMessage(event) {
            const data = event.data as { v?: unknown; token?: unknown; identity?: unknown; type?: unknown } | null;
            if (!data || data.v !== 1 || data.token !== token || !validBoardIdentity(data.identity) || !matchingIdentity(data.identity, identity)
                || (data.type !== 'ready' && data.type !== 'loaded') || !pending) { fail(new Error('Invalid embed containment reply')); return; }
            const resolve = pending; pending = undefined; rejectPending = undefined; resolve(data.type);
        },
    });
    const wait = () => new Promise<string>((resolve, reject) => { if (failure) { reject(failure); return; } pending = resolve; rejectPending = reject; });
    const dispose = () => {
        if (closed) return;
        closed = true; signal.removeEventListener('abort', abort); options.signal?.removeEventListener('abort', dispose);
        fail(new DOMException('Embed closed', 'AbortError')); lifetime.abort(); frame.dispose();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
        check();
        const ready = wait();
        try { frame.mount(options.container); } catch (error) { fail(error); }
        if (await ready !== 'ready') throw new Error('Invalid embed initialization'); check();
        const loaded = wait();
        try { frame.port.postMessage({ v: 1, token, identity, type: 'load', url: candidate.url }); } catch (error) { fail(error); }
        if (await loaded !== 'loaded') throw new Error('Invalid embed load response'); check();
        // The consent lease is bound to the caller's lifetime, not the short initialization timeout.
        signal.removeEventListener('abort', abort);
        options.signal?.addEventListener('abort', dispose, { once: true });
        if (options.signal?.aborted) { dispose(); throw options.signal.reason; }
        return { element: frame.frame, dispose };
    } catch (error) { dispose(); throw error; }
}
