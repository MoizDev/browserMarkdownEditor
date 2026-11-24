import { autocompletion } from '@codemirror/autocomplete';
import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

/** A note the picker can offer: its wikilink name (basename, no .md) and
 *  whether it exists yet — unresolved targets are still valid links, they
 *  just haven't been created, so they're offered too (like Obsidian). */
export interface WikiLinkTarget {
    name: string;
    unresolved: boolean;
}

/** Accepting a suggestion replaces the typed fragment with the note name and
 *  parks the caret AFTER the closing ]] — supplying that ]] only when
 *  closeBrackets hasn't already (it usually has, from typing the [[). */
function applyWikiLink(view: EditorView, completion: Completion, from: number, to: number) {
    const alreadyClosed = view.state.sliceDoc(to, to + 2) === ']]';
    view.dispatch({
        changes: { from, to, insert: completion.label + (alreadyClosed ? '' : ']]') },
        selection: { anchor: from + completion.label.length + 2 },
        userEvent: 'input.complete',
    });
}

/**
 * IntelliSense for [[wikilinks]]: typing `[[` pops a dropdown of every note in
 * the vault, filtered as you type; Enter/Tab/click inserts the pick.
 *
 * `getTargets` is called per keystroke so the list always reflects the current
 * vault — pass a closure over a ref, not a snapshot.
 */
export function wikiLinkAutocomplete(getTargets: () => WikiLinkTarget[]): Extension {
    const source = (context: CompletionContext): CompletionResult | null => {
        const line = context.state.doc.lineAt(context.pos);
        const before = line.text.slice(0, context.pos - line.from);

        const open = before.lastIndexOf('[[');
        if (open < 0) return null;
        // Anything that ends the link target between [[ and the caret — a
        // closing bracket or an |alias pipe — means we're not naming a note.
        const typed = before.slice(open + 2);
        if (/[\][|]/.test(typed)) return null;

        // [[ inside inline or fenced code is literal text, not a link.
        for (let n: SyntaxNode | null = syntaxTree(context.state).resolveInner(context.pos, -1); n; n = n.parent) {
            if (n.name.includes('Code')) return null;
        }

        return {
            from: line.from + open + 2,
            options: getTargets().map((t): Completion => ({
                label: t.name,
                detail: t.unresolved ? 'not created yet' : undefined,
                boost: t.unresolved ? -1 : 0,
                apply: applyWikiLink,
            })),
            validFor: /^[^\][|]*$/,
        };
    };

    return autocompletion({ override: [source], icons: false });
}
