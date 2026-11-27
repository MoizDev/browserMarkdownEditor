import type { Node, NodeBase, NodeKind } from './nodes';
import type { ViewFlags } from './doc';
import type { UiBlock } from './styles';
import type { MediaEntry } from './media';

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
    polyline: { startAttach: null, endAttach: null },
    frame: {},
    group: {},
    picture: { playing: true },
    clip: {},
    linkcard: {},
    embed: {},
    opaque: {},
} as const satisfies {
    readonly [K in NodeKind]: Partial<Omit<Extract<Node, { readonly kind: K }>, keyof NodeBase>>;
};

export const UI_DEFAULTS = {
    tool: 'pen',
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
        highlighterColor: 'yellow',
    },
    penWidth: 3,
    ext: null,
} as const satisfies UiBlock;

export const VIEW_DEFAULTS = {
    grid: false,
    focusMode: false,
    toolLock: false,
    transparent: false,
    debugMode: false,
    ext: null,
} as const satisfies ViewFlags;

export const MEDIA_DEFAULTS = { name: '', animated: false, file: null } as const satisfies Partial<MediaEntry>;
