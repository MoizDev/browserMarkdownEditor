import { Sha256 } from './sha256';
/** Up to this size the native digest takes the whole file as one transient buffer; above it the file is hashed in 4 MiB
 * slices by the pure-JS SHA-256 so memory stays bounded. Measured: the JS hash took ~2.8 s of worker CPU for a 287 MB
 * textbook; the native digest of a 64 MiB buffer is a small fraction of that. Both give the same lowercase hex. */
const NATIVE_DIGEST_MAX_BYTES = 64 * 1024 * 1024;
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
self.onmessage = async (event: MessageEvent<Blob>) => {
    try {
        const blob = event.data;
        if (blob.size <= NATIVE_DIGEST_MAX_BYTES && self.crypto?.subtle) {
            self.postMessage({ hash: hex(await self.crypto.subtle.digest('SHA-256', await blob.arrayBuffer())) });
            return;
        }
        const hash = new Sha256();
        for (let at = 0; at < blob.size; at += 4 * 1024 * 1024) hash.update(new Uint8Array(await blob.slice(at, at + 4 * 1024 * 1024).arrayBuffer()));
        self.postMessage({ hash: hash.digest() });
    } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
