export const ASSETS_DIR = '.Assets';
export const TRASH_DIR = '.Garbage';

export function embedPattern(): RegExp {
    return /!\[\[([^\]|]+)(?:\s*\|\s*(\d+))?\]\]/g;
}

export function embedText(name: string, width: number | null): string {
    return width ? `![[${name}|${width}]]` : `![[${name}]]`;
}

export function assetEmbeds(text: string): Set<string> {
    const names = new Set<string>();
    if (!text) return names;
    const embedRegex = embedPattern();
    let m: RegExpExecArray | null;
    while ((m = embedRegex.exec(text)) !== null) {
        const name = m[1].trim();
        if (isAssetName(name)) names.add(name);
    }
    return names;
}

export function assetReferences(text: string): Set<string> {
    const names = new Set<string>();
    const wikiRegex = /!?\[\[([^\]\n]+?)\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = wikiRegex.exec(text)) !== null) {
        const name = match[1].split('|')[0].split('#')[0].trim();
        if (isAssetName(name)) names.add(name);
    }
    return names;
}

export function referencesAsset(text: string, name: string): boolean {
    if (!text || !name) return false;
    const wanted = name.toLowerCase();
    const wikiRegex = /!?\[\[([^\]\n]+?)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = wikiRegex.exec(text)) !== null) {
        const target = m[1].split('|')[0].split('#')[0].trim().toLowerCase();
        if (target === wanted) return true;
    }
    return false;
}

/**
 * Note text is untrusted input that reaches getFileHandle/removeEntry here, and
 * `![[../../notes/thesis.md]]` must never be one of them. The File System
 * Access API rejects a separator itself, but a document-driven DELETE is not
 * something to leave resting on someone else's argument validation.
 */
export function isAssetName(name: string): boolean {
    return !!name && name !== '.' && name !== '..' && !/[/\\]/.test(name);
}
