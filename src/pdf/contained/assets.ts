import sourceManifest from '../engine/dev/source-manifest.json';
import { PdfEngineError } from '../engine/types';

interface AssetPin { path: string; sha256: string; bytes: number }
interface EngineManifest {
    schemaVersion: number;
    qualification: string;
    shippingAllowed: boolean;
    buildId: string;
    artifactSha256: string;
    servedBase: string;
    factory: { roleVersion: number; format: string };
    files: { glue: AssetPin; wasm: AssetPin };
    abi: AssetPin;
}
export interface TrustedPdfAssets {
    buildId: string;
    artifactSha256: string;
    assetBase: string;
    wasm: Blob;
    wasmBytes: number;
    glueSource: string;
    abi: unknown;
}
const manifest = sourceManifest as unknown as EngineManifest;
const broken = () => new PdfEngineError('EngineBroken', 'PDF engine assets are unavailable or failed integrity validation');

function pinUrl(base: URL, pin: AssetPin): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(pin.path) || pin.path === '.' || pin.path === '..' ||
        !/^[a-f0-9]{64}$/.test(pin.sha256) || !Number.isSafeInteger(pin.bytes) || pin.bytes < 1 || pin.bytes > 64 * 1024 * 1024) throw broken();
    const url = new URL(pin.path, base);
    if (url.origin !== location.origin || !['http:', 'https:'].includes(url.protocol) || url.search || url.hash ||
        url.username || url.password || !url.pathname.startsWith(base.pathname)) throw broken();
    return url.href;
}

/** Bytes are authenticated on the trusted side before becoming immutable Blobs.
 * No compiled Module crosses C5 or an agent-cluster boundary. */
async function verifiedBytes(url: string, pin: AssetPin, signal?: AbortSignal): Promise<ArrayBuffer> {
    const response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'force-cache' });
    if (!response.ok || !response.body) throw broken();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            signal?.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > pin.bytes) throw broken();
            chunks.push(value);
        }
    } catch (error) {
        void reader.cancel().catch(() => {});
        throw error;
    } finally { reader.releaseLock(); }
    if (length !== pin.bytes) throw broken();
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (hex !== pin.sha256) throw broken();
    return bytes.buffer;
}

/** The pin is app-owned, never taken from a PDF, pane, message, URL parameter or vault file. */
export async function loadTrustedPdfAssets(signal?: AbortSignal): Promise<TrustedPdfAssets> {
    try {
        signal?.throwIfAborted();
        if (manifest.schemaVersion !== 1 || manifest.factory.roleVersion !== 1 || manifest.factory.format !== 'es-module' ||
            !/^(?:dev-)?[a-f0-9]{64}$/.test(manifest.buildId) || !/^[a-f0-9]{64}$/.test(manifest.artifactSha256) ||
            manifest.artifactSha256 !== manifest.files.wasm.sha256) throw broken();
        // Development engines are not shipping artefacts, even when a persisted developer switch is on.
        if (!(import.meta.env.DEV || __BME_BENCH__) &&
            (!manifest.shippingAllowed || manifest.qualification === 'development' || manifest.buildId.startsWith('dev-'))) {
            throw new PdfEngineError('EngineBroken', 'A development PDF engine cannot run in a production build');
        }
        const basePath = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/${manifest.servedBase.replace(/^\/+/, '')}`;
        const base = new URL(basePath, location.origin);
        if (base.origin !== location.origin || !base.pathname.endsWith('/') || base.search || base.hash) throw broken();
        const glueUrl = pinUrl(base, manifest.files.glue), abiUrl = pinUrl(base, manifest.abi);
        const wasmUrl = pinUrl(base, manifest.files.wasm);
        const glue = await verifiedBytes(glueUrl, manifest.files.glue, signal);
        const abi = await verifiedBytes(abiUrl, manifest.abi, signal);
        const wasm = await verifiedBytes(wasmUrl, manifest.files.wasm, signal);
        const decoder = new TextDecoder('utf-8', { fatal: true });
        return { buildId: manifest.buildId, artifactSha256: manifest.artifactSha256, assetBase: base.href,
            wasm: new Blob([wasm], { type: 'application/wasm' }), wasmBytes: manifest.files.wasm.bytes,
            glueSource: decoder.decode(glue), abi: JSON.parse(decoder.decode(abi)) as unknown };
    } catch (error) {
        if (signal?.aborted) throw signal.reason ?? new DOMException('PDF engine load cancelled', 'AbortError');
        if (error instanceof PdfEngineError) throw error;
        throw broken();
    }
}
