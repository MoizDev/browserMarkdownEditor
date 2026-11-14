import type { BoardCommand, ContextSection } from './boardCommands';
import type { ToolLabel } from './toolChoices';

export const englishTools: Readonly<Record<ToolLabel, string>> = {
    select: 'Select', hand: 'Hand', draw: 'Draw', eraser: 'Eraser', arrow: 'Arrow',
    text: 'Text', note: 'Note', media: 'Media', rectangle: 'Rectangle', ellipse: 'Ellipse',
    triangle: 'Triangle', diamond: 'Diamond', hexagon: 'Hexagon', oval: 'Oval', rhombus: 'Rhombus',
    star: 'Star', cloud: 'Cloud', heart: 'Heart', xBox: 'X box', checkBox: 'Check box',
    arrowLeft: 'Arrow left', arrowUp: 'Arrow up', arrowDown: 'Arrow down', arrowRight: 'Arrow right',
    line: 'Line', highlight: 'Highlight', laser: 'Laser', frame: 'Frame',
};

export const englishCommands: Readonly<Record<BoardCommand, string>> = {
    undo: 'Undo', redo: 'Redo', delete: 'Delete', duplicate: 'Duplicate', cut: 'Cut',
    copy: 'Copy', paste: 'Paste', selectAll: 'Select all', group: 'Group', ungroup: 'Ungroup',
    flatten: 'Flatten', editLink: 'Edit link…', frameSelection: 'Frame selection', toggleLocked: 'Toggle locked',
    alignLeft: 'Align left', alignHorizontal: 'Align horizontally', alignRight: 'Align right',
    alignTop: 'Align top', alignVertical: 'Align vertically', alignBottom: 'Align bottom',
    stretchHorizontal: 'Stretch H', stretchVertical: 'Stretch V', distributeHorizontal: 'Distribute horizontally',
    distributeVertical: 'Distribute vertically', stackHorizontal: 'Stack H', stackVertical: 'Stack V', pack: 'Pack',
    sendBack: 'Send to back', sendBackward: 'Send backward', bringForward: 'Bring forward', bringFront: 'Bring to front',
    rotateCounterclockwise: 'Rotate counterclockwise', rotateClockwise: 'Rotate clockwise',
    copyAsPng: 'PNG', copyAsSvg: 'SVG', copyAsJson: 'JSON', exportPng: 'PNG', exportSvg: 'SVG',
};

export const englishSections: Readonly<Record<ContextSection, string>> = {
    edit: 'Edit', arrange: 'Arrange', reorder: 'Reorder', moveToPage: 'Move to page',
    copyAs: 'Copy as', exportAs: 'Export as',
};
