import type { Node, NodeBase, NodeKind } from './nodes';
import type { ViewFlags } from './doc';
import type { UiBlock } from './styles';
import type { MediaEntry } from './media';

// document-model.md §§3.1–3.2, R-W13: constructor defaults and native-format
// omission/fill share this table. An unlisted property has no implied default.
export const COMMON_NODE_DEFAULTS = {
    rotation: 0,
    locked: false,
    opacity: 1,
} as const satisfies Partial<NodeBase>;

export const NODE_DEFAULTS = {
    stroke: {
        closed: false,
        sx: 1,
        sy: 1,
        color: 'black',
        fill: 'none',
        dash: 'solid',
        complete: true,
    },
    figure: { labelScale: 1 },
    text: { autoSize: true },
    sticky: { color: 'yellow', labelColor: 'black' },
    connector: {
        elbowMid: 0.5,
        headStart: 'none',
        headEnd: 'arrow',
        labelAt: 0.5,
        labelScale: 1,
    },
    polyline: {},
    frame: {},
    group: {},
    picture: {},
    clip: {},
    linkcard: {},
    embed: {},
    opaque: {},
} as const satisfies {
    readonly [K in NodeKind]: Partial<Omit<Extract<Node, { readonly kind: K }>, keyof NodeBase>>;
};

// R-W28: document-model §7; spec/styles F-STYLE-010 and lines 23–26/176.
// Width 3 = 3 × DEFAULT_PEN_SCALE 1 (utils/penStyle.ts:41). An unseeded
// file's last-width override is host-owned, never a reader-side global lookup.
export const UI_DEFAULTS = {
    tool: 'pen', // Pending M1 parity capture (R-W28).
    next: {
        color: NODE_DEFAULTS.stroke.color,
        fill: NODE_DEFAULTS.stroke.fill,
        dash: NODE_DEFAULTS.stroke.dash,
        size: 's',
        font: 'draw',
        align: 'middle',
        textAlign: 'start',
        valign: 'middle',
        headStart: NODE_DEFAULTS.connector.headStart,
        headEnd: NODE_DEFAULTS.connector.headEnd,
        route: 'arc',
        spline: 'line',
        highlighterColor: 'yellow', // Pending M1 parity capture (R-W28).
    },
    penWidth: 3,
    ext: null,
} as const satisfies UiBlock;

// R-W28: native-format §3.2 view record; transparent=false means solid export.
export const VIEW_DEFAULTS = {
    grid: false,
    focusMode: false,
    toolLock: false,
    transparent: false,
    debugMode: false,
    ext: null,
} as const satisfies ViewFlags;

// R-W35: fields omitted by an older/native media record, shared with its reader.
export const MEDIA_DEFAULTS = { name: '', animated: false, file: null } as const satisfies Partial<MediaEntry>;
