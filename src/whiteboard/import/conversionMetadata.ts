import { parseJson } from '../format/jsonRead';
import type { PreservedBlock } from '../model/doc';

const KEY = 'legacyOriginalSha256';
const HASH = /^[0-9a-f]{64}$/;

// The digest, rather than a path, survives both a vault-folder move and a file rename.
export function withConversionDigest(preserved: PreservedBlock, sha256: string): PreservedBlock {
    if (!HASH.test(sha256)) throw new TypeError('Invalid conversion backup digest');
    const fields = new Map(preserved.fields);
    fields.set(KEY, parseJson(JSON.stringify(sha256)).raw());
    return { ...preserved, fields };
}
export function conversionDigest(preserved: PreservedBlock): string | null {
    const raw = preserved.fields.get(KEY);
    if (raw === undefined) return null;
    try {
        const value: unknown = JSON.parse(raw);
        return typeof value === 'string' && HASH.test(value) ? value : null;
    } catch { return null; }
}
