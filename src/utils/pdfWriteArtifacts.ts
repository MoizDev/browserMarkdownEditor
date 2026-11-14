// Worker-local immutable payloads, never PDFRefs or mutable document graphs.
// Idle expiry also covers hidden panes; a failed build is never cached.
const LIMIT = 128 * 1024 * 1024;
const IDLE_MS = 30_000;
const cache = new Map<string, Uint8Array>();
const inFlight = new Map<string, Promise<Uint8Array>>();
let size = 0;
let idle: ReturnType<typeof setTimeout> | undefined;
function touch(): void {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { cache.clear(); size = 0; idle = undefined; }, IDLE_MS);
}
export async function artifactHash(bytes: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function immutableArtifact(key: string, create: () => Promise<Uint8Array> | Uint8Array): Promise<Uint8Array> {
    touch();
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
    const existing = inFlight.get(key);
    if (existing) return existing;
    const task = Promise.resolve().then(create).then(bytes => {
        if (bytes.length <= LIMIT) {
            while (size + bytes.length > LIMIT && cache.size) {
                const oldest = cache.keys().next().value!;
                size -= cache.get(oldest)!.length;
                cache.delete(oldest);
            }
            cache.set(key, bytes);
            size += bytes.length;
            touch();
        }
        return bytes;
    }).finally(() => { if (inFlight.get(key) === task) inFlight.delete(key); });
    inFlight.set(key, task);
    return task;
}
