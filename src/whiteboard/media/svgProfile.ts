import type { SvgAdmissionProfile } from './inspect';

// SEC-W2 supplies the opaque sandbox, fixed bootstrap, chunked channel and
// exact-hash CSP. Separate profiles prevent XML parsing from gaining blob loads.
export interface SvgContainedFrame {
    request(operation: 'header' | 'probe', blob: Blob, signal: AbortSignal): Promise<unknown>;
    dispose(): void;
}
export interface SvgFrameFactory {
    open(profile: 'svg-xml' | 'svg-image', signal: AbortSignal): Promise<SvgContainedFrame>;
}

export function createSvgAdmissionProfile(frames: SvgFrameFactory): SvgAdmissionProfile {
    const request = async (profile: 'svg-xml' | 'svg-image', op: 'header' | 'probe', blob: Blob, signal: AbortSignal): Promise<unknown> => {
        signal.throwIfAborted();
        const frame = await frames.open(profile, signal);
        try {
            signal.throwIfAborted();
            return await frame.request(op, blob, signal);
        } finally { frame.dispose(); }
    };
    return {
        async header(blob, signal) {
            const result = await request('svg-xml', 'header', blob, signal);
            if (!result || typeof result !== 'object') throw new Error('Invalid SVG decoder response');
            const { width, height } = result as { width?: unknown; height?: unknown };
            if (typeof width !== 'number' || typeof height !== 'number' || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
                || width < 1 || height < 1 || width > (2 ** 26) / height) throw new Error('Invalid SVG decoder response');
            return { width, height };
        },
        async probe(blob, signal) {
            const result = await request('svg-image', 'probe', blob, signal);
            if (result !== true) throw new Error('This picture could not be read');
        },
    };
}
