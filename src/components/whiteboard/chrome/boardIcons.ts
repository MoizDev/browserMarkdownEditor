import type { IconNode } from '../../../utils/entryStyle';
import type { BoardCommand } from './boardCommands';

// The top bar and the Actions grid draw Lucide's own node data (lucide-static, ISC), copied here for the icons
// they use only: the whole set would be ~90KB of the board's chunk. Stretch and stack have no Lucide glyph that
// reads as the action, so they are drawn in the same 24-unit, 2-stroke style below.

const menu: IconNode[] = [['path', { d: 'M4 5h16' }], ['path', { d: 'M4 12h16' }], ['path', { d: 'M4 19h16' }]];
const chevronDown: IconNode[] = [['path', { d: 'm6 9 6 6 6-6' }]];
const undo: IconNode[] = [['path', { d: 'M9 14 4 9l5-5' }], ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11' }]];
const redo: IconNode[] = [['path', { d: 'm15 14 5-5-5-5' }], ['path', { d: 'M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13' }]];
const trash: IconNode[] = [['path', { d: 'M10 11v6' }], ['path', { d: 'M14 11v6' }],
    ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }], ['path', { d: 'M3 6h18' }],
    ['path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }]];
const copy: IconNode[] = [['rect', { width: 14, height: 14, x: 8, y: 8, rx: 2, ry: 2 }],
    ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }]];
const ellipsisVertical: IconNode[] = [['circle', { cx: 12, cy: 12, r: 1 }], ['circle', { cx: 12, cy: 5, r: 1 }],
    ['circle', { cx: 12, cy: 19, r: 1 }]];

/** The bar's icon buttons other than the menu and the sheet name. */
export const headerIcons = { menu, chevronDown, actions: ellipsisVertical } as const;

/** The navigation panel and the helper buttons: Lucide's plus, minus, chevrons, arrow-left and x (ISC), the same
 *  24-unit, 2-stroke family as the rest of this file. */
const plus: IconNode[] = [['path', { d: 'M5 12h14' }], ['path', { d: 'M12 5v14' }]];
const minus: IconNode[] = [['path', { d: 'M5 12h14' }]];
const chevronLeft: IconNode[] = [['path', { d: 'm15 18-6-6 6-6' }]];
const chevronRight: IconNode[] = [['path', { d: 'm9 18 6-6-6-6' }]];
const arrowLeft: IconNode[] = [['path', { d: 'm12 19-7-7 7-7' }], ['path', { d: 'M19 12H5' }]];
const close: IconNode[] = [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]];

export const navigationIcons = { zoomIn: plus, zoomOut: minus, chevronLeft, chevronRight, arrowLeft, close } as const;

/** Undo, Redo, Delete and Duplicate in the bar, keyed by the command each one runs. */
export const headerCommandIcons: Readonly<Record<'undo' | 'redo' | 'delete' | 'duplicate', IconNode[]>> = {
    undo, redo, delete: trash, duplicate: copy,
};

const alignStartVertical: IconNode[] = [['rect', { width: 9, height: 6, x: 6, y: 14, rx: 2 }],
    ['rect', { width: 16, height: 6, x: 6, y: 4, rx: 2 }], ['path', { d: 'M2 2v20' }]];
const alignCenterVertical: IconNode[] = [['path', { d: 'M12 2v20' }],
    ['path', { d: 'M8 10H4a2 2 0 0 1-2-2V6c0-1.1.9-2 2-2h4' }], ['path', { d: 'M16 10h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-4' }],
    ['path', { d: 'M8 20H7a2 2 0 0 1-2-2v-2c0-1.1.9-2 2-2h1' }], ['path', { d: 'M16 14h1a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1' }]];
const alignEndVertical: IconNode[] = [['rect', { width: 16, height: 6, x: 2, y: 4, rx: 2 }],
    ['rect', { width: 9, height: 6, x: 9, y: 14, rx: 2 }], ['path', { d: 'M22 22V2' }]];
const alignStartHorizontal: IconNode[] = [['rect', { width: 6, height: 16, x: 4, y: 6, rx: 2 }],
    ['rect', { width: 6, height: 9, x: 14, y: 6, rx: 2 }], ['path', { d: 'M22 2H2' }]];
const alignCenterHorizontal: IconNode[] = [['path', { d: 'M2 12h20' }],
    ['path', { d: 'M10 16v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4' }], ['path', { d: 'M10 8V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v4' }],
    ['path', { d: 'M20 16v1a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-1' }], ['path', { d: 'M14 8V7c0-1.1.9-2 2-2h2a2 2 0 0 1 2 2v1' }]];
const alignEndHorizontal: IconNode[] = [['rect', { width: 6, height: 16, x: 4, y: 2, rx: 2 }],
    ['rect', { width: 6, height: 9, x: 14, y: 9, rx: 2 }], ['path', { d: 'M22 22H2' }]];
const spaceBetweenHorizontal: IconNode[] = [['rect', { width: 6, height: 14, x: 3, y: 5, rx: 2 }],
    ['rect', { width: 6, height: 10, x: 15, y: 7, rx: 2 }], ['path', { d: 'M3 2v20' }], ['path', { d: 'M21 2v20' }]];
const spaceBetweenVertical: IconNode[] = [['rect', { width: 14, height: 6, x: 5, y: 15, rx: 2 }],
    ['rect', { width: 10, height: 6, x: 7, y: 3, rx: 2 }], ['path', { d: 'M2 21h20' }], ['path', { d: 'M2 3h20' }]];
const stretchHorizontal: IconNode[] = [['path', { d: 'M2 4v16' }], ['path', { d: 'M22 4v16' }], ['path', { d: 'M6 12h12' }]];
const stretchVertical: IconNode[] = [['path', { d: 'M4 2h16' }], ['path', { d: 'M4 22h16' }], ['path', { d: 'M12 6v12' }]];
const stackHorizontal: IconNode[] = [['path', { d: 'M4 4v16' }], ['path', { d: 'M9.3 4v16' }], ['path', { d: 'M14.7 4v16' }], ['path', { d: 'M20 4v16' }]];
const stackVertical: IconNode[] = [['path', { d: 'M4 4h16' }], ['path', { d: 'M4 9.3h16' }], ['path', { d: 'M4 14.7h16' }], ['path', { d: 'M4 20h16' }]];
const sendToBack: IconNode[] = [['path', { d: 'M12 17V3' }], ['path', { d: 'm6 11 6 6 6-6' }], ['path', { d: 'M19 21H5' }]];
const sendBackward: IconNode[] = [['path', { d: 'M12 5v14' }], ['path', { d: 'm19 12-7 7-7-7' }]];
const bringForward: IconNode[] = [['path', { d: 'm5 12 7-7 7 7' }], ['path', { d: 'M12 19V5' }]];
const bringToFront: IconNode[] = [['path', { d: 'M5 3h14' }], ['path', { d: 'm18 13-6-6-6 6' }], ['path', { d: 'M12 7v14' }]];
const rotateCounterclockwise: IconNode[] = [['path', { d: 'M20 9V7a2 2 0 0 0-2-2h-6' }], ['path', { d: 'm15 2-3 3 3 3' }],
    ['path', { d: 'M20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2' }]];
const rotateClockwise: IconNode[] = [['path', { d: 'M12 5H6a2 2 0 0 0-2 2v3' }], ['path', { d: 'm9 8 3-3-3-3' }],
    ['path', { d: 'M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2' }]];
const link: IconNode[] = [['path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }],
    ['path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }]];
const selectGroup: IconNode[] = [['path', { d: 'M5 3a2 2 0 0 0-2 2' }], ['path', { d: 'M19 3a2 2 0 0 1 2 2' }],
    ['path', { d: 'M21 19a2 2 0 0 1-2 2' }], ['path', { d: 'M5 21a2 2 0 0 1-2-2' }], ['path', { d: 'M9 3h1' }],
    ['path', { d: 'M9 21h1' }], ['path', { d: 'M14 3h1' }], ['path', { d: 'M14 21h1' }], ['path', { d: 'M3 9v1' }],
    ['path', { d: 'M21 9v1' }], ['path', { d: 'M3 14v1' }], ['path', { d: 'M21 14v1' }]];
const ungroup: IconNode[] = [['rect', { x: 11, y: 14, width: 10, height: 7, rx: 2 }], ['rect', { x: 3, y: 3, width: 10, height: 7, rx: 2 }]];

/** The picture toolbar and the crop bar. Drawn in the same 24-unit, 2-stroke style as the icons above. */
const pictureReplace: IconNode[] = [['rect', { width: 18, height: 18, x: 3, y: 3, rx: 2 }], ['circle', { cx: 9, cy: 9, r: 2 }],
    ['path', { d: 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21' }]];
const pictureCrop: IconNode[] = [['path', { d: 'M6 2v14a2 2 0 0 0 2 2h14' }], ['path', { d: 'M18 22V8a2 2 0 0 0-2-2H2' }]];
const pictureDownload: IconNode[] = [['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }], ['path', { d: 'm7 10 5 5 5-5' }],
    ['path', { d: 'M12 15V3' }]];
const pictureFit: IconNode[] = [['path', { d: 'M8 3H5a2 2 0 0 0-2 2v3' }], ['path', { d: 'M21 8V5a2 2 0 0 0-2-2h-3' }],
    ['path', { d: 'M3 16v3a2 2 0 0 0 2 2h3' }], ['path', { d: 'M16 21h3a2 2 0 0 0 2-2v-3' }]];
const pictureCheck: IconNode[] = [['path', { d: 'M20 6 9 17l-5-5' }]];

/** The picture toolbar's and the crop bar's icons, keyed by what each button does. */
export const pictureIcons = { replace: pictureReplace, crop: pictureCrop, download: pictureDownload, fit: pictureFit, check: pictureCheck } as const;

/** The Actions grid, keyed by the command each button runs; the group slot carries ungroup for a group. */
export const actionIcons: Partial<Record<BoardCommand, IconNode[]>> = {
    alignLeft: alignStartVertical, alignHorizontal: alignCenterVertical, alignRight: alignEndVertical,
    stretchHorizontal, alignTop: alignStartHorizontal, alignVertical: alignCenterHorizontal, alignBottom: alignEndHorizontal,
    stretchVertical, distributeHorizontal: spaceBetweenHorizontal, distributeVertical: spaceBetweenVertical,
    stackHorizontal, stackVertical, sendBack: sendToBack, sendBackward, bringForward, bringFront: bringToFront,
    rotateCounterclockwise, rotateClockwise, editLink: link, group: selectGroup, ungroup,
};
