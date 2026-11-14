// Observe only: preserve the pinned renderer's responses, results and throws.
// A dependency failure taints the worker; a successful JS fallback can still
// paint a complete page. No PDF text or URL is sent on this app-owned channel.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

const CLASSIC_WORKER_API_VERSION = '6.1.200';
interface RuntimePolicy { version: string; manifestHash: string; directories: string[] }
const scope = globalThis as unknown as {
    fetch: typeof fetch;
    XMLHttpRequest: typeof XMLHttpRequest;
    postMessage(message: unknown): void;
    addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
};
const publish = (action: string, data: unknown = null) => scope.postMessage({ sourceName: 'classic-runtime', targetName: 'classic-host', action, data });
let initialized = false;
scope.addEventListener('message', ({ data }) => {
    if (initialized || data?.sourceName !== 'classic-host' || data.targetName !== 'classic-runtime' || data.action !== 'init') return;
    initialized = true;
    const policy = data.data as RuntimePolicy;
    if (policy?.version !== CLASSIC_WORKER_API_VERSION || !/^[a-f0-9]{64}$/.test(policy.manifestHash)
        || !Array.isArray(policy.directories) || policy.directories.length !== 4
        || policy.directories.some(value => {
            try { const url = new URL(value); return url.origin !== location.origin || !url.pathname.endsWith('/'); }
            catch { return true; }
        })) { publish('runtime-startup-failed'); return; }
    void boot(policy);
});

async function boot(policy: RuntimePolicy): Promise<void> {
    const runtimeAsset = (value: string) => {
        try { const url = new URL(value, import.meta.url); return url.origin === location.origin && policy.directories.some(directory => url.href.startsWith(directory)); }
        catch { return false; }
    };
    const nativeFetch = scope.fetch.bind(scope);
    scope.fetch = async (...args) => {
        const value = args[0] instanceof Request ? args[0].url : String(args[0]);
        try {
            const response = await nativeFetch(...args);
            if (runtimeAsset(value) && !response.ok) publish('asset-load-failed');
            return response;
        } catch (error) {
            if (runtimeAsset(value)) publish('asset-load-failed');
            throw error;
        }
    };
    const NativeXHR = scope.XMLHttpRequest;
    scope.XMLHttpRequest = class extends NativeXHR {
        override open(method: string, url: string | URL, async = true, username?: string | null, password?: string | null) {
            if (runtimeAsset(String(url))) {
                this.addEventListener('loadend', () => { if (this.status < 200 || this.status >= 300) publish('asset-load-failed'); }, { once: true });
                this.addEventListener('error', () => publish('asset-load-failed'), { once: true });
            }
            super.open(method, url, async, username, password);
        }
    };
    function observe<T extends (...args: never[]) => Promise<unknown>>(original: T): T {
        return new Proxy(original, {
            apply(target, receiver, argumentsList) {
                try {
                    const result = Reflect.apply(target, receiver, argumentsList) as Promise<unknown>;
                    // Observe rejection on a separate chain, returning the
                    // EXACT original Promise (and its native result/error).
                    void result.then(undefined, () => publish('asset-load-failed'));
                    return result;
                } catch (error) { publish('asset-load-failed'); throw error; }
            },
        });
    }
    WebAssembly.compile = observe(WebAssembly.compile);
    WebAssembly.compileStreaming = observe(WebAssembly.compileStreaming);
    WebAssembly.instantiate = observe(WebAssembly.instantiate);
    WebAssembly.instantiateStreaming = observe(WebAssembly.instantiateStreaming);
    try {
        // The unchanged package module installs the normal ready/test and
        // per-document handlers. This is not a copy/fork of the renderer.
        await import(/* @vite-ignore */ workerUrl);
        publish('runtime-ready', { version: CLASSIC_WORKER_API_VERSION, manifestHash: policy.manifestHash });
    } catch { publish('runtime-startup-failed'); }
}
