import { SECURITY_LIMITS } from '../security/limits';

export function svgParseBudget(bytes: number): number {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > SECURITY_LIMITS.svgBytes) throw new RangeError('Invalid SVG byte count');
    const elements = Math.min(SECURITY_LIMITS.svgElements, Math.floor(bytes / 3));
    return 1024 * 1024 + bytes * 16 + elements * 1024;
}
