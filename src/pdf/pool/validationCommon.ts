import { PdfEngineError } from '../engine/types';

/** Structured clone cannot prevent a hostile worker from allocating a message before inspection (security §4). */
export function invalidPdfReply(): never {
    throw new PdfEngineError('EngineBroken', 'The PDF engine returned invalid data.');
}

export function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalidPdfReply();
    const object = value as Record<string, unknown>;
    if (Object.keys(object).some(key => !allowed.includes(key))) invalidPdfReply();
    return object;
}

export function integer(value: unknown, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalidPdfReply();
    return value;
}

export function finite(value: unknown, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalidPdfReply();
    return value;
}

export function text(value: unknown, max: number): string {
    if (typeof value !== 'string' || value.length > max) invalidPdfReply();
    return value;
}

export function boolean(value: unknown): boolean {
    if (typeof value !== 'boolean') invalidPdfReply();
    return value;
}
