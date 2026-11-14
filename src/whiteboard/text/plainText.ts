import { MAX_TEXT_BLOCKS, MAX_TEXT_LENGTH } from '../model/textLimits';

/** Normalize plain ingress before it can become a rich splice; unsafe UTF-16 is refused, not truncated. */
export function normalizePlainInsertion(value: string): string {
    // CRLF can contract by at most half; reject impossible input before allocating a second string.
    if (value.length > MAX_TEXT_LENGTH * 2) throw new RangeError('Rich text exceeds limits');
    const normalized = value.replace(/\r\n?/g, '\n');
    if (normalized.length > MAX_TEXT_LENGTH) throw new RangeError('Rich text exceeds limits');
    let blocks = 1;
    for (let index = 0; index < normalized.length; index++) {
        const code = normalized.charCodeAt(index);
        if (code === 10) {
            if (++blocks > MAX_TEXT_BLOCKS) throw new RangeError('Rich text exceeds limits');
        } else if (code < 32 && code !== 9) throw new RangeError('Text contains an unsupported control character');
        else if (code >= 0xd800 && code <= 0xdbff) {
            const next = normalized.charCodeAt(index + 1);
            if (next < 0xdc00 || next > 0xdfff || Number.isNaN(next)) throw new RangeError('Text contains an unpaired surrogate');
            index++;
        } else if (code >= 0xdc00 && code <= 0xdfff) throw new RangeError('Text contains an unpaired surrogate');
    }
    return normalized;
}
