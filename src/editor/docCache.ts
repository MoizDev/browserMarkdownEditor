// One flattened copy of a document per immutable Text instance.
//
// CodeMirror does NOT memoize Text.toString() — every call walks the rope and
// allocates a fresh full-document string. The live-preview rebuild path used to
// pay for that two to three times per keystroke (buildDecorations, the update
// listener, and isInMathContext on any bracket key), which on a large note is
// hundreds of KB of identical garbage per character typed.
//
// A WeakMap keyed on the Text itself is exactly safe: Text is immutable and
// persistent, so identity is a sound cache key, and the entry dies with the
// document it belongs to — this retains nothing beyond what is already live.
//
// It also makes selection-only rebuilds allocate NO document string at all:
// tr.state.doc === tr.startState.doc whenever !tr.docChanged.

import type { Text } from '@codemirror/state';

const cache = new WeakMap<Text, string>();

/** Flatten a document to a string, once per immutable Text instance. */
export function docString(doc: Text): string {
    let s = cache.get(doc);
    if (s === undefined) {
        s = doc.toString();
        cache.set(doc, s);
    }
    return s;
}
