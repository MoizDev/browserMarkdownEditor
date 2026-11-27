/** SHA-256, lowercase hex. Text is hashed as UTF-8 — `vault_read` hands this
 *  back as `hash` and `vault_write` compares against it, so both sides must
 *  hash the very same string (the \n-normalized buffer). */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    let hex = '';
    for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
    return hex;
}

export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

export async function blobBytes(blob: Blob): Promise<Uint8Array> {
    return new Uint8Array(await blob.arrayBuffer());
}

export const AGENT_IMAGE_MAX_SIDE = 1568;

export const TOOL_IMAGE_MAX_BYTES = 1_400_000;

const MIME_BY_EXT: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
};

const PASSTHROUGH = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function imageMimeFor(name: string): string | null {
    const dot = name.lastIndexOf('.');
    return dot === -1 ? null : MIME_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null;
}

export interface AgentImage {
    data: string;
    mimeType: string;
    width: number;
    height: number;
    converted: boolean;
}

async function decode(blob: Blob): Promise<CanvasImageSource & { width: number; height: number }> {
    if (blob.type !== 'image/svg+xml') return createImageBitmap(blob);
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        if (!img.naturalWidth || !img.naturalHeight) { img.width = 1024; img.height = 768; }
        else { img.width = img.naturalWidth; img.height = img.naturalHeight; }
        return img;
    } finally {
        URL.revokeObjectURL(url);
    }
}

export async function prepareImageForAgent(
    bytes: Uint8Array,
    mimeType: string,
    maxSide = AGENT_IMAGE_MAX_SIDE,
    maxBytes = TOOL_IMAGE_MAX_BYTES,
): Promise<AgentImage> {
    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType });
    const source = await decode(blob);
    const { width, height } = source;
    try {
        if (PASSTHROUGH.has(mimeType) && bytes.length <= maxBytes && Math.max(width, height) <= maxSide) {
            return { data: bytesToBase64(bytes), mimeType, width, height, converted: false };
        }
        let scale = Math.min(1, maxSide / Math.max(width, height, 1));
        for (let attempt = 0; attempt < 6; attempt++) {
            const w = Math.max(1, Math.round(width * scale));
            const h = Math.max(1, Math.round(height * scale));
            const canvas = new OffscreenCanvas(w, h);
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('no 2D canvas context');
            const jpeg = attempt > 0;
            if (jpeg) {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, w, h);
            }
            ctx.drawImage(source, 0, 0, w, h);
            const out = await canvas.convertToBlob(jpeg ? { type: 'image/jpeg', quality: 0.85 } : { type: 'image/png' });
            if (out.size <= maxBytes) {
                return { data: bytesToBase64(await blobBytes(out)), mimeType: out.type, width: w, height: h, converted: true };
            }
            if (attempt > 0) scale *= 0.75;
        }
        throw new Error('the image is too large to send even after scaling it down');
    } finally {
        if ('close' in source && typeof source.close === 'function') source.close();
    }
}
