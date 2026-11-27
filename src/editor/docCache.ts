import type { Text } from '@codemirror/state';

const cache = new WeakMap<Text, string>();

export function docString(doc: Text): string {
    let s = cache.get(doc);
    if (s === undefined) {
        s = doc.toString();
        cache.set(doc, s);
    }
    return s;
}
