import { autocompletion } from '@codemirror/autocomplete';
import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

export interface WikiLinkTarget {
    name: string;
    unresolved: boolean;
}

function applyWikiLink(view: EditorView, completion: Completion, from: number, to: number) {
    const alreadyClosed = view.state.sliceDoc(to, to + 2) === ']]';
    view.dispatch({
        changes: { from, to, insert: completion.label + (alreadyClosed ? '' : ']]') },
        selection: { anchor: from + completion.label.length + 2 },
        userEvent: 'input.complete',
    });
}

export function wikiLinkAutocomplete(getTargets: () => WikiLinkTarget[]): Extension {
    const source = (context: CompletionContext): CompletionResult | null => {
        const line = context.state.doc.lineAt(context.pos);
        const before = line.text.slice(0, context.pos - line.from);

        const open = before.lastIndexOf('[[');
        if (open < 0) return null;
        const typed = before.slice(open + 2);
        if (/[\][|]/.test(typed)) return null;

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
