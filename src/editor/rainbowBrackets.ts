// Brackets coloured by how deep they are nested.
//
// In a Lisp this is not decoration: `(define (f x) (cond [(p? x) (g (h x))]))`
// is eight brackets of five depths, and matching them by eye is the single
// hardest thing about reading the language. Every editor the user works in
// colours them (Zed's `colorize_brackets`), so a code pane here does too.
//
// HOW DEEP A BRACKET IS CANNOT BE READ OFF THE VIEWPORT. Depth at line 400
// depends on every bracket before it, so the scan starts at the top of the
// document — but only the brackets actually ON SCREEN become decorations.
// Measured on a 2,402-line (47,283-character) Racket file: the whole-document
// scan is 0.2ms, and typing a 22-character form into it produced no long task
// at all. It runs on a document change, a scroll, or the parse arriving.
//
// BRACKETS INSIDE STRINGS AND COMMENTS DO NOT COUNT — `";)"` would otherwise
// throw the colour of everything after it. Those ranges come from the syntax
// tree rather than from a hand-rolled lexer: the grammar already knows exactly
// where a string ends, including Python's triple quotes and Racket's `#|…|#`,
// and a second guess at it would be wrong in a different way per language.
// Where the tree has not been built that far yet (a huge file, mid-parse), the
// brackets past that point simply wait for the next update.

import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

/** Past this the colouring switches off: a generated file is not read by eye,
 *  and a full scan per keystroke is the one cost worth refusing. */
const MAX_DOC = 300_000;

/** How many colours before the cycle repeats. Six is what every editor settles
 *  on — enough that two nearby levels never share, few enough to stay telling. */
export const BRACKET_COLOURS = 6;

const OPEN = '([{';
const CLOSE = ')]}';
const PAIR: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

const marks = Array.from({ length: BRACKET_COLOURS }, (_, i) =>
    Decoration.mark({ class: `cm-bracket-depth-${i}` }));
/** A closer with nothing to close, or the wrong kind: the one bracket state
 *  worth shouting about, since it is always a mistake. */
const badMark = Decoration.mark({ class: 'cm-bracket-bad' });

/** Ranges whose brackets are text, not structure. */
function quotedRanges(view: EditorView, to: number): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    syntaxTree(view.state).iterate({
        from: 0,
        to,
        enter(node) {
            // Node names come from the grammar, so they differ per language:
            // "LineComment", "BlockComment", "String", "TemplateString",
            // "comment", "string" (a stream language's own names).
            if (/comment|string|quoted/i.test(node.name)) {
                ranges.push([node.from, node.to]);
                return false;
            }
            return undefined;
        },
    });
    return ranges;
}

function build(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const doc = view.state.doc;
    if (doc.length > MAX_DOC) return builder.finish();

    const text = doc.toString();
    const quoted = quotedRanges(view, doc.length);
    let qi = 0;
    // Only what is on screen is decorated; the scan itself still starts at 0.
    const visible = view.visibleRanges;
    let vi = 0;
    const stack: string[] = [];

    for (let pos = 0; pos < text.length; pos++) {
        // Skip a whole string or comment in one step.
        while (qi < quoted.length && quoted[qi][1] <= pos) qi++;
        if (qi < quoted.length && quoted[qi][0] <= pos) {
            pos = quoted[qi][1] - 1;
            continue;
        }

        const ch = text[pos];
        const isOpen = OPEN.includes(ch);
        const isClose = !isOpen && CLOSE.includes(ch);
        if (!isOpen && !isClose) continue;

        let mark: Decoration;
        if (isOpen) {
            mark = marks[stack.length % BRACKET_COLOURS];
            stack.push(ch);
        } else if (stack.length && stack[stack.length - 1] === PAIR[ch]) {
            stack.pop();
            mark = marks[stack.length % BRACKET_COLOURS];
        } else {
            mark = badMark;
        }

        while (vi < visible.length && visible[vi].to < pos) vi++;
        if (vi >= visible.length) break;         // past the last visible line
        if (visible[vi].from > pos) continue;    // before this visible range
        builder.add(pos, pos + 1, mark);
    }
    return builder.finish();
}

/**
 * Only for code panes: a note's brackets are prose, and `[[a wikilink]]` or a
 * markdown link would be painted as nesting.
 */
export const rainbowBrackets = ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
        this.decorations = build(view);
    }

    update(update: ViewUpdate) {
        // A scroll changes which brackets are on screen and an edit changes the
        // depths — but so does the PARSE ARRIVING. The tree is empty when a
        // pane first mounts (parsing is scheduled, not synchronous), so the
        // first build has no idea where the strings and comments are, and
        // without this check it is also the last: measured, every bracket in a
        // comment stayed coloured until the file was touched.
        if (update.docChanged || update.viewportChanged
            || syntaxTree(update.startState) !== syntaxTree(update.state)) {
            this.decorations = build(update.view);
        }
    }
}, { decorations: plugin => plugin.decorations });
