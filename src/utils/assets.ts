// The two hidden buckets a vault folder can hold, and the note-side rules for
// what counts as a reference to an asset in one of them.
//
// Both are per FOLDER, never per vault: the images a note embeds live in the
// `.Assets` beside it and a deleted file goes to the `.Garbage` beside it. So a
// folder carries its own pictures and its own trash — move it, copy it, or hand
// it to someone else and its notes still render — and two folders may hold
// same-named files without either one shadowing the other. buildFileTree hides
// both from the explorer.

export const ASSETS_DIR = '.Assets';
export const TRASH_DIR = '.Garbage';

/**
 * One image embed: `![[diagram.png]]`, or `![[diagram.png|320]]` carrying the
 * width the reader resized it to. Capture 1 is the name, capture 2 the width.
 *
 * THE one definition of the syntax — the live-preview renderer, the widget that
 * resizes and deletes an embed, and the asset lifecycle below all scan with it.
 * What one of them treats as a picture must be exactly what the others do, or
 * an asset gets retired while it is plainly still on screen.
 *
 * Returned fresh per call rather than shared: it is a /g regex, and a caller
 * that stops early would leave its `lastIndex` in the next caller's way.
 */
export function embedPattern(): RegExp {
    return /!\[\[([^\]|]+)(?:\s*\|\s*(\d+))?\]\]/g;
}

/** The text form of an embed — what a resize writes back into the document. */
export function embedText(name: string, width: number | null): string {
    return width ? `![[${name}|${width}]]` : `![[${name}]]`;
}

/** The names embedded as images by a document. */
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

/**
 * Does this document still point at `name` in any way at all?
 *
 * Broader than assetEmbeds on purpose: this is the question asked before an
 * asset is taken away, so it counts a plain `[[picture.png]]` link as much as
 * an `![[picture.png]]` embed, and matches case-insensitively. Erring towards
 * "yes, it is still in use" costs a stale file; erring the other way costs the
 * user their picture.
 */
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
 * True for a name that can address an entry of a `.Assets` folder.
 *
 * Note text is untrusted input that reaches getFileHandle/removeEntry here, and
 * `![[../../notes/thesis.md]]` must never be one of them. The File System
 * Access API rejects a separator itself, but a document-driven DELETE is not
 * something to leave resting on someone else's argument validation.
 */
export function isAssetName(name: string): boolean {
    return !!name && name !== '.' && name !== '..' && !/[/\\]/.test(name);
}
