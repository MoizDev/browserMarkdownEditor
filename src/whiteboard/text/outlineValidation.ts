import type { OutlineWorkerRequest } from './outlineTypes';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const color = (value: unknown): boolean => Array.isArray(value) && value.length === 4
    && [0, 1, 2, 3].every(index => finite(value[index]) && value[index] >= 0 && value[index] <= 1);
const rectangle = (value: unknown): boolean => object(value) && finite(value.x) && finite(value.y)
    && finite(value.w) && value.w >= 0 && finite(value.h) && value.h >= 0;

/** The worker never treats a malformed display list or a different face generation as drawable text. */
export function validOutlineRequest(value: unknown): value is OutlineWorkerRequest {
    if (!object(value) || !object(value.paint) || !object(value.faces) || !object(value.material)
        || !finite(value.pageScale) || value.pageScale <= 0 || !Array.isArray(value.localToWorld)
        || value.localToWorld.length !== 6 || ![0, 1, 2, 3, 4, 5].every(index => finite((value.localToWorld as unknown[])[index]))) return false;
    const paint = value.paint, faces = value.faces, material = value.material;
    if (!Array.isArray(faces.faces) || !object(paint.faceTable) || paint.faceTable !== faces
        || !Array.isArray(paint.backgrounds) || !Array.isArray(paint.decorations) || !Array.isArray(paint.lines)
        || !Array.isArray(material.backgrounds) || !Array.isArray(material.decorations) || !Array.isArray(material.glyphs)
        || (material.blend !== 'normal' && material.blend !== 'multiply')
        || material.backgrounds.length !== paint.backgrounds.length || material.decorations.length !== paint.decorations.length) return false;
    for (let i = 0; i < paint.backgrounds.length; i++) if (!rectangle(paint.backgrounds[i]) || !color(material.backgrounds[i])) return false;
    for (let i = 0; i < paint.decorations.length; i++) if (!rectangle(paint.decorations[i]) || !color(material.decorations[i])) return false;
    let glyphs = 0, textLength = 0;
    for (const line of paint.lines) {
        if (!object(line) || !finite(line.top) || !finite(line.bottom) || line.bottom < line.top || !finite(line.baseline) || !Array.isArray(line.fragments)) return false;
        for (const fragment of line.fragments) {
            if (!object(fragment) || typeof fragment.text !== 'string' || !finite(fragment.x) || !finite(fragment.width) || fragment.width < 0
                || typeof fragment.rtl !== 'boolean' || typeof fragment.systemFallback !== 'boolean' || !Number.isSafeInteger(fragment.face)
                || (fragment.face as number) < 0 || (fragment.face as number) >= faces.faces.length || !color(material.glyphs[glyphs])) return false;
            const face = faces.faces[fragment.face as number];
            if (!object(face) || !object(face.key) || typeof face.loaded !== 'boolean' || typeof face.css !== 'string'
                || !finite(face.size) || face.size <= 0 || !finite(face.ascent) || !finite(face.descent)
                || typeof face.key.bold !== 'boolean' || typeof face.key.italic !== 'boolean'
                || !['draw', 'sans', 'serif', 'mono'].includes(face.key.family as string)) return false;
            glyphs++; textLength += fragment.text.length;
            if (textLength > 8_000_000) return false;
        }
    }
    return glyphs === material.glyphs.length;
}
