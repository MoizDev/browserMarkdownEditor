import type { PaintItem, PaintTextItem } from './paintStream';

const contributionsOf = new WeakMap<PaintItem, readonly PaintItem[]>();
export function paintContributions(item: PaintItem): readonly PaintItem[] {
    const known = contributionsOf.get(item);
    if (known) return known;
    const parts = expandContributions(item);
    contributionsOf.set(item, parts);
    return parts;
}
function expandContributions(item: PaintItem): readonly PaintItem[] {
    const blend = item.kind === 'image' ? item.blend : item.material.blend;
    if (blend === 'normal') return [item];
    if (item.kind === 'image') return [{ ...item, blend: 'normal' }];
    if (item.kind === 'ink') return [{ ...item, material: { ...item.material, blend: 'normal' } }];
    if (item.kind === 'path') {
        const parts: PaintItem[] = [];
        if (item.material.fill) parts.push({ ...item, material: { fill: item.material.fill, blend: 'normal' } });
        if (item.material.stroke) parts.push({ ...item, material: { stroke: item.material.stroke, blend: 'normal' } });
        return parts;
    }
    const parts: PaintItem[] = [];
    const empty = { ...item.paint, backgrounds: [], lines: [], decorations: [] };
    const base: PaintTextItem = { ...item, paint: empty,
        material: { backgrounds: [], glyphs: [], decorations: [], blend: 'normal' } };
    for (let i = 0; i < item.paint.backgrounds.length; i++) parts.push({ ...base,
        paint: { ...empty, backgrounds: [item.paint.backgrounds[i]] },
        material: { ...base.material, backgrounds: [item.material.backgrounds[i]] } });
    let colour = 0;
    for (const line of item.paint.lines) for (const fragment of line.fragments) parts.push({ ...base,
        paint: { ...empty, lines: [{ ...line, fragments: [fragment] }] },
        material: { ...base.material, glyphs: [item.material.glyphs[colour++]] } });
    for (let i = 0; i < item.paint.decorations.length; i++) parts.push({ ...base,
        paint: { ...empty, decorations: [item.paint.decorations[i]] },
        material: { ...base.material, decorations: [item.material.decorations[i]] } });
    return parts;
}
