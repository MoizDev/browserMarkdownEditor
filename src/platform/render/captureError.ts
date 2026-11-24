export type CaptureErrorCode = 'invalid-input' | 'too-large' | 'aborted' | 'disposed' |
    'timeout' | 'incomplete' | 'out-of-budget' | 'not-origin-clean' | 'render-failed' | 'superseded';

const messages: Record<CaptureErrorCode, string> = {
    'invalid-input': 'Capture bounds, layer selection or options are invalid.',
    'too-large': 'Capture exceeds 4096 pixels per side or 16 megapixels; use a banded export.',
    'aborted': 'Capture was aborted.',
    'disposed': 'Capture document or vault is no longer available.',
    'timeout': 'Capture deadline expired, including queue wait.',
    'incomplete': 'Exact resources for the captured revision are unavailable.',
    'out-of-budget': 'Capture cannot fit within the memory grant.',
    'not-origin-clean': 'Capture contains a resource that is not origin-clean.',
    'render-failed': 'Capture rendering failed.',
    'superseded': 'A newer queued thumbnail replaced this capture.',
};

/** Stable caller-facing codes, never an engine-controlled error string in a UI. */
export class CaptureError extends Error {
    constructor(readonly code: CaptureErrorCode, options?: ErrorOptions) {
        super(messages[code], options);
        this.name = 'CaptureError';
    }
}

export function captureAbort(signal: AbortSignal): CaptureError {
    return signal.reason instanceof CaptureError ? signal.reason : new CaptureError('aborted');
}
