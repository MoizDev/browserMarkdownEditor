import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

const MAX_DOC = 300_000;

export const BRACKET_COLOURS = 6;

const OPEN = '([{';
const CLOSE = ')]}';
const PAIR: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

const marks = Array.from({ length: BRACKET_COLOURS }, (_, i) =>
    Decoration.mark({ class: `cm-bracket-depth-${i}` }));
const badMark = Decoration.mark({ class: 'cm-bracket-bad' });

function quotedRanges(view: EditorView, to: number): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    syntaxTree(view.state).iterate({
        from: 0,
        to,
        enter(node) {
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
    const visible = view.visibleRanges;
    let vi = 0;
    const stack: string[] = [];

    for (let pos = 0; pos < text.length; pos++) {
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
        if (vi >= visible.length) break;
        if (visible[vi].from > pos) continue;
        builder.add(pos, pos + 1, mark);
    }
    return builder.finish();
}

export const rainbowBrackets = ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
        this.decorations = build(view);
    }

    update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged
            || syntaxTree(update.startState) !== syntaxTree(update.state)) {
            this.decorations = build(update.view);
        }
    }
}, { decorations: plugin => plugin.decorations });
