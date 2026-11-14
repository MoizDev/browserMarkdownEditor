import { EMBED_PERMISSIONS, EMBED_PROFILE, validateEmbedManifest, validateEmbedUrl } from './embedPolicy';

/** Only the embedding app can hand this opaque frame its private command port. */
function initialize(event: MessageEvent<unknown>): void {
    if (event.source !== parent || event.ports.length !== 1 || !event.data || typeof event.data !== 'object') return;
    const init = event.data as { v?: unknown; type?: unknown; profile?: unknown; token?: unknown; origins?: unknown; url?: unknown };
    if (init.v !== 1 || init.type !== 'init' || init.profile !== EMBED_PROFILE
        || typeof init.token !== 'string' || !/^[0-9a-f]{32}$/.test(init.token)) return;
    let url: string;
    try {
        const manifest = validateEmbedManifest({ version: 1, origins: init.origins });
        url = validateEmbedUrl(init.url, manifest);
    } catch { return; }
    removeEventListener('message', initialize);
    const token = init.token, port = event.ports[0];
    let inner: HTMLIFrameElement | null = null, stopped = false;
    const send = (type: 'ready' | 'mounted' | 'blocked' | 'unavailable') => {
        port.postMessage(type === 'ready'
            ? { v: 1, profile: EMBED_PROFILE, token, type, credentialless: true }
            : { v: 1, profile: EMBED_PROFILE, token, type });
    };
    const closeInner = () => { inner?.remove(); inner = null; };
    const blocked = (violation: SecurityPolicyViolationEvent) => {
        if (stopped || !inner || violation.effectiveDirective !== 'frame-src') return;
        stopped = true; closeInner(); send('blocked');
    };
    addEventListener('securitypolicyviolation', blocked);
    port.addEventListener('messageerror', () => { stopped = true; closeInner(); port.close(); });
    port.addEventListener('message', (message: MessageEvent<unknown>) => {
        if (stopped || !message.data || typeof message.data !== 'object') return;
        const command = message.data as { v?: unknown; profile?: unknown; token?: unknown; type?: unknown };
        if (command.v !== 1 || command.profile !== EMBED_PROFILE || command.token !== token
            || (command.type !== 'load' && command.type !== 'unload') || Object.keys(command).length !== 4) return;
        if (command.type === 'unload') { stopped = true; closeInner(); return; }
        if (inner) return;
        try {
            inner = frame;
            frame.src = url;
            document.body.append(frame);
            send('mounted');
        } catch { stopped = true; closeInner(); send('unavailable'); }
    });
    port.start();
    if (!('credentialless' in HTMLIFrameElement.prototype)) { stopped = true; send('unavailable'); return; }
    const frame = document.createElement('iframe') as HTMLIFrameElement & { credentialless: boolean };
    try {
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.referrerPolicy = 'no-referrer';
        frame.setAttribute('allow', EMBED_PERMISSIONS);
        frame.credentialless = true;
        if (!frame.credentialless || !frame.hasAttribute('credentialless')) throw new Error('Credentialless frame unavailable');
        document.documentElement.style.height = '100%';
        document.body.style.height = '100%'; document.body.style.margin = '0';
        // This first-party backing keeps a fully opaque live slot opaque even if the provider clears its own background.
        document.body.style.backgroundColor = 'white';
        frame.style.width = '100%'; frame.style.height = '100%'; frame.style.border = '0'; frame.style.display = 'block';
        send('ready');
    } catch { stopped = true; send('unavailable'); }
}
addEventListener('message', initialize);
