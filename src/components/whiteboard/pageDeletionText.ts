const KIND_KEYS: Readonly<Record<string, string>> = {
    stroke: 'stroke', figure: 'shape', text: 'text', sticky: 'sticky', connector: 'arrow',
    polyline: 'line', frame: 'frame', group: 'group', picture: 'picture', clip: 'video',
    linkcard: 'bookmark', embed: 'embed', opaque: 'unsupported',
};

/** The engine supplies actual deletion counts; no labels or note contents cross the menu boundary. */
export function pageDeletionText(
    counts: Iterable<readonly [string, number]>, locale: string, plural: (key: string, count: number) => string,
): string {
    const items: string[] = [];
    for (const [kind, count] of counts) {
        if (!Number.isSafeInteger(count) || count <= 0) continue;
        items.push(plural(`kinds.${KIND_KEYS[kind] ?? 'unsupported'}`, count));
    }
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
}
