import fontMetrics from './fontMetrics.json';
import fontCoverage from './fontCoverage.json';

export type FontFamily = 'draw' | 'sans' | 'serif' | 'mono';
export interface FontKey { readonly family: FontFamily; readonly bold: boolean; readonly italic: boolean }
export interface FontMetrics {
    readonly unitsPerEm: number; readonly ascent: number; readonly descent: number; readonly xHeight: number;
    readonly underlinePosition: number; readonly underlineThickness: number; readonly strikePosition: number; readonly strikeThickness: number;
}
export interface FontDescriptor { readonly key: FontKey; readonly familyName: string; readonly fallback: string; readonly weight: number; readonly style: 'normal' | 'italic'; readonly file: string; readonly url: string; readonly metrics: FontMetrics }

// Vite resolves each literal to a same-origin asset URL; constructing a URL does not fetch it.
const urls: Record<string, string> = {
    'Shantell_Sans-Informal_Regular.woff2': new URL('./fonts/Shantell_Sans-Informal_Regular.woff2', import.meta.url).href,
    'Shantell_Sans-Informal_Bold.woff2': new URL('./fonts/Shantell_Sans-Informal_Bold.woff2', import.meta.url).href,
    'Shantell_Sans-Informal_Regular_Italic.woff2': new URL('./fonts/Shantell_Sans-Informal_Regular_Italic.woff2', import.meta.url).href,
    'Shantell_Sans-Informal_Bold_Italic.woff2': new URL('./fonts/Shantell_Sans-Informal_Bold_Italic.woff2', import.meta.url).href,
    'IBMPlexSans-Medium.woff2': new URL('./fonts/IBMPlexSans-Medium.woff2', import.meta.url).href,
    'IBMPlexSans-Bold.woff2': new URL('./fonts/IBMPlexSans-Bold.woff2', import.meta.url).href,
    'IBMPlexSans-MediumItalic.woff2': new URL('./fonts/IBMPlexSans-MediumItalic.woff2', import.meta.url).href,
    'IBMPlexSans-BoldItalic.woff2': new URL('./fonts/IBMPlexSans-BoldItalic.woff2', import.meta.url).href,
    'IBMPlexSerif-Medium.woff2': new URL('./fonts/IBMPlexSerif-Medium.woff2', import.meta.url).href,
    'IBMPlexSerif-Bold.woff2': new URL('./fonts/IBMPlexSerif-Bold.woff2', import.meta.url).href,
    'IBMPlexSerif-MediumItalic.woff2': new URL('./fonts/IBMPlexSerif-MediumItalic.woff2', import.meta.url).href,
    'IBMPlexSerif-BoldItalic.woff2': new URL('./fonts/IBMPlexSerif-BoldItalic.woff2', import.meta.url).href,
    'IBMPlexMono-Medium.woff2': new URL('./fonts/IBMPlexMono-Medium.woff2', import.meta.url).href,
    'IBMPlexMono-Bold.woff2': new URL('./fonts/IBMPlexMono-Bold.woff2', import.meta.url).href,
    'IBMPlexMono-MediumItalic.woff2': new URL('./fonts/IBMPlexMono-MediumItalic.woff2', import.meta.url).href,
    'IBMPlexMono-BoldItalic.woff2': new URL('./fonts/IBMPlexMono-BoldItalic.woff2', import.meta.url).href,
};
const families: Record<FontFamily, { name: string; fallback: string; prefix: string }> = {
    draw: { name: 'WB Draw', fallback: 'system-ui', prefix: 'Shantell_Sans-Informal_' },
    sans: { name: 'WB Plex Sans', fallback: 'system-ui', prefix: 'IBMPlexSans-' },
    serif: { name: 'WB Plex Serif', fallback: 'ui-serif', prefix: 'IBMPlexSerif-' },
    mono: { name: 'WB Plex Mono', fallback: 'ui-monospace', prefix: 'IBMPlexMono-' },
};

export function fontDescriptor(key: FontKey): FontDescriptor {
    const family = families[key.family];
    const weight = key.bold ? 700 : key.family === 'draw' ? 400 : 500;
    const style = key.italic ? 'italic' : 'normal';
    const name = key.family === 'draw'
        ? `${family.prefix}${key.bold ? 'Bold' : 'Regular'}${key.italic ? '_Italic' : ''}.woff2`
        : `${family.prefix}${key.bold ? 'Bold' : 'Medium'}${key.italic ? 'Italic' : ''}.woff2`;
    return { key, familyName: family.name, fallback: family.fallback, weight, style, file: name, url: urls[name], metrics: (fontMetrics as Record<string, FontMetrics>)[name] };
}

/** Unicode cmap coverage; presentation sequences remain conservative because cmap alone cannot prove shaping. */
export function fontSupports(key: FontKey, text: string): boolean {
    const ranges = (fontCoverage as Record<string, number[]>)[fontDescriptor(key).file];
    for (const character of text) {
        const cp = character.codePointAt(0)!;
        if (cp === 0x200d || cp === 0xfe0f || cp >= 0xe0100 && cp <= 0xe01ef) return false;
        if (/^[\p{Control}\p{Default_Ignorable_Code_Point}]$/u.test(character)) continue;
        let lo = 0, hi = ranges.length / 2;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (ranges[mid * 2 + 1] < cp) lo = mid + 1;
            else hi = mid;
        }
        if (lo * 2 >= ranges.length || ranges[lo * 2] > cp) return false;
    }
    return true;
}

/** A fallback paint must remain fallback even if the alias subsequently loads. */
export function fontCss(face: FontDescriptor, loaded = true): string {
    return `${face.style} ${face.weight} 64px ${loaded ? `"${face.familyName}", ` : ''}${face.fallback}`;
}

type Listener = (epoch: number, key: FontKey) => void;
/** One instance per document or worker FontFaceSet. Loading starts only on ensure(). */
export class BoardFonts {
    private readonly loads = new Map<string, Promise<boolean>>();
    private readonly loaded = new Set<string>();
    private readonly listeners = new Set<Listener>();
    private currentEpoch = 0;
    constructor(private readonly fontSet: FontFaceSet) {}
    get epoch(): number { return this.currentEpoch; }
    isLoaded(key: FontKey): boolean { return this.loaded.has(fontDescriptor(key).url); }
    subscribe(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    /** Wait for the actual face; export workers must not substitute a timeout stand-in. */
    load(key: FontKey): Promise<boolean> {
        const descriptor = fontDescriptor(key);
        let load = this.loads.get(descriptor.url);
        if (!load) {
            const face = new FontFace(descriptor.familyName, `url("${descriptor.url}")`, { weight: String(descriptor.weight), style: descriptor.style });
            load = face.load().then(loaded => {
                this.fontSet.add(loaded);
                this.loaded.add(descriptor.url);
                this.currentEpoch++;
                for (const listener of this.listeners) listener(this.currentEpoch, descriptor.key);
                return true;
            }, () => false);
            this.loads.set(descriptor.url, load);
        }
        return load;
    }
    async ensure(key: FontKey, waitMs = 100): Promise<boolean> {
        const load = this.load(key);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, waitMs)); });
        try { return await Promise.race([load, timeout]); }
        finally { clearTimeout(timer); }
    }
}
