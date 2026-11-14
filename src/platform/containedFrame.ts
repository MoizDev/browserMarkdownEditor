/** First-party frame mechanics only. HTML must be a generated, fixed bootstrap, never user content.
 * The caller owns the profile CSP, bootstrap identity and every message/protocol validation.
 */
export type ContainedFrameFailure = 'navigation' | 'handoff' | 'messageerror';

export interface ContainedFrameOptions {
    readonly html: string;
    readonly init: unknown;
    readonly onMessage: (event: MessageEvent) => void;
    readonly onFailure: (reason: ContainedFrameFailure) => void;
    readonly signal?: AbortSignal;
    readonly className?: string;
    readonly ariaLabel?: string;
    readonly hidden?: boolean;
    readonly credentialless?: boolean;
}

export interface ContainedFrame {
    readonly frame: HTMLIFrameElement;
    readonly port: MessagePort;
    /** Installs the generated srcdoc and transfers exactly one private port on its first load. */
    mount(container: HTMLElement): void;
    dispose(): void;
}

export function createContainedFrame(options: ContainedFrameOptions): ContainedFrame {
    const frame = document.createElement('iframe');
    const channel = new MessageChannel();
    let closed = false, mounted = false, loaded = false;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; accelerometer 'none'; gyroscope 'none'; magnetometer 'none'");
    if (options.className) frame.className = options.className;
    if (options.ariaLabel) frame.setAttribute('aria-label', options.ariaLabel);
    if (options.hidden) { frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1; }
    if (options.credentialless) frame.setAttribute('credentialless', '');

    function dispose(): void {
        if (closed) return;
        closed = true;
        options.signal?.removeEventListener('abort', dispose);
        frame.removeEventListener('load', onLoad);
        channel.port1.removeEventListener('message', onMessage);
        channel.port1.removeEventListener('messageerror', onMessageError);
        channel.port1.close();
        channel.port2.close();
        frame.remove();
    }
    function fail(reason: ContainedFrameFailure): void {
        if (closed) return;
        try { options.onFailure(reason); } finally { dispose(); }
    }
    function onLoad(): void {
        if (closed) return;
        if (loaded) { fail('navigation'); return; }
        loaded = true;
        const target = frame.contentWindow;
        if (!target) { fail('handoff'); return; }
        try { target.postMessage(options.init, '*', [channel.port2]); }
        catch { fail('handoff'); }
    }
    function onMessage(event: MessageEvent): void { if (!closed) options.onMessage(event); }
    function onMessageError(): void { fail('messageerror'); }
    channel.port1.addEventListener('message', onMessage);
    channel.port1.addEventListener('messageerror', onMessageError);
    channel.port1.start();
    frame.addEventListener('load', onLoad);

    return {
        frame,
        port: channel.port1,
        mount(container) {
            if (closed || mounted) throw new Error('Contained frame is closed or already mounted');
            try {
                options.signal?.throwIfAborted();
                mounted = true;
                options.signal?.addEventListener('abort', dispose, { once: true });
                frame.srcdoc = options.html;
                container.append(frame);
            } catch (error) { dispose(); throw error; }
        },
        dispose,
    };
}
