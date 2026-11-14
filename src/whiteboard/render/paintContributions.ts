import type { PaintItem, PaintTextItem } from './paintStream';

/** Multiply is applied per native paint operation, not once to an invented isolated node.
 * Ordinary grouping/opacity remains inherited. The caller composites each yielded source
 * against the real destination at its original position in the stream. */
export function* paintContributions(item: PaintItem): Generator<PaintItem> {
    const blend = item.kind === 'image' ? item.blend : item.material.blend;
    if (blend === 'normal') { yield item; return; }
    if (item.kind === 'image') { yield { ...item, blend: 'normal' }; return; }
    if (item.kind === 'ink') { yield { ...item, material: { ...item.material, blend: 'normal' } }; return; }
    if (item.kind === 'path') {
        if (item.material.fill) yield { ...item, material: { fill: item.material.fill, blend: 'normal' } };
        if (item.material.stroke) yield { ...item, material: { stroke: item.material.stroke, blend: 'normal' } };
        return;
    }
    const empty = { ...item.paint, backgrounds: [], lines: [], decorations: [] };
    const base: PaintTextItem = { ...item, paint: empty,
        material: { backgrounds: [], glyphs: [], decorations: [], blend: 'normal' } };
    for (let i = 0; i < item.paint.backgrounds.length; i++) yield { ...base,
        paint: { ...empty, backgrounds: [item.paint.backgrounds[i]] },
        material: { ...base.material, backgrounds: [item.material.backgrounds[i]] } };
    let colour = 0;
    for (const line of item.paint.lines) for (const fragment of line.fragments) yield { ...base,
        paint: { ...empty, lines: [{ ...line, fragments: [fragment] }] },
        material: { ...base.material, glyphs: [item.material.glyphs[colour++]] } };
    for (let i = 0; i < item.paint.decorations.length; i++) yield { ...base,
        paint: { ...empty, decorations: [item.paint.decorations[i]] },
        material: { ...base.material, decorations: [item.material.decorations[i]] } };
}
