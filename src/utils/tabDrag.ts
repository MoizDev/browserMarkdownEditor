// Marking a drag as "a tab is being carried".
//
// The payload itself doesn't travel in the DataTransfer — the tab bar and the
// editor's drop zone are both inside EditorPane, so which tab is moving is
// ordinary React state (unlike utils/treeDrag.ts, whose two ends are in
// different subtrees). What has to travel is the FACT that this is a tab drag,
// because the file explorer is a drop target for everything and reads the drag
// long before any drop: `dataTransfer.types` is the only thing readable during
// dragover, so a bespoke type is how a folder row knows not to light up for a
// tab it could never accept.

/** Present on the DataTransfer of a tab drag, and on nothing else. */
export const TAB_DRAG_TYPE = 'application/x-md-tab';

/** True when this drag is carrying an editor tab. */
export function isTabDrag(dataTransfer: DataTransfer | null): boolean {
    return !!dataTransfer && Array.from(dataTransfer.types).includes(TAB_DRAG_TYPE);
}
