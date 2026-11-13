import type { Node, NodeBase, NodeKind } from './nodes';

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
