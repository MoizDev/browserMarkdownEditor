const BYTE_LIMIT = 256 * 1024 * 1024;
const DEPTH_LIMIT = 128;

// SEC-W1: bound the expanded UTF-8 input and nesting before JSON.parse or record allocation.
export function preflightLegacyJson(text: string): void {
    let bytes = 0, depth = 0, inString = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x80) bytes++;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length
            && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
        else bytes += 3;
        if (bytes > BYTE_LIMIT) throw new RangeError('Drawing exceeds the import size limit');
        if (inString) {
            if (escaped) escaped = false;
            else if (code === 92) escaped = true;
            else if (code === 34) inString = false;
        } else if (code === 34) inString = true;
        else if (code === 123 || code === 91) {
            if (++depth > DEPTH_LIMIT) throw new RangeError('Drawing nesting exceeds the import limit');
        } else if (code === 125 || code === 93) depth--;
    }
}
