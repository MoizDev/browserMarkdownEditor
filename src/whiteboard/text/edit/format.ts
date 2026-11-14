// WB-D26 / SEC-5: normalise the link before handing it to rich-text editing.
export function linkUrl(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed || trimmed.length > 2048) return null;
    const value = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
    if (value.length > 2048) return null;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? value : null;
    } catch { return null; }
}

export type ToggleMark = 'b' | 'i' | 'u' | 's' | 'code' | 'hl';
