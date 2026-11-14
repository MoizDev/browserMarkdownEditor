import { StateField, type Text } from '@codemirror/state';

function countLine(text: string): number {
    return text.match(/\S+/g)?.length ?? 0;
}

function countLines(doc: Text, ranges: Array<[number, number]>): number {
    let total = 0;
    for (const [first, last] of ranges) {
        for (let line = first; line <= last; line++) total += countLine(doc.line(line).text);
    }
    return total;
}

export const wordCountField = StateField.define<number>({
    create(state) { return countLines(state.doc, [[1, state.doc.lines]]); },
    update(total, transaction) {
        if (!transaction.docChanged) return total;
        const oldRanges: Array<[number, number]> = [];
        const newRanges: Array<[number, number]> = [];
        const add = (ranges: Array<[number, number]>, first: number, last: number) => {
            const previous = ranges[ranges.length - 1];
            if (previous && first <= previous[1]) previous[1] = Math.max(previous[1], last);
            else ranges.push([first, last]);
        };
        const oldDoc = transaction.startState.doc, newDoc = transaction.newDoc;
        transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
            add(oldRanges, oldDoc.lineAt(fromA).number, oldDoc.lineAt(toA).number);
            add(newRanges, newDoc.lineAt(fromB).number, newDoc.lineAt(toB).number);
        });
        return total - countLines(oldDoc, oldRanges) + countLines(newDoc, newRanges);
    },
});
