// WB-D26 / SEC-5: normalise the link before handing it to rich-text editing.
export function linkUrl(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed || trimmed.length > 2048) return null;
    for (const char of trimmed) {
        const code = char.codePointAt(0)!;
        if (code < 32 || (code >= 127 && code <= 159)) return null;
    }
    const value = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
    if (value.length > 2048) return null;
    try {
        const url = new URL(value);
        return !url.username && !url.password && (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') ? value : null;
    } catch { return null; }
}

export type ToggleMark = 'b' | 'i' | 'u' | 's' | 'code' | 'hl';
