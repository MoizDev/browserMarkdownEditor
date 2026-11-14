import type { LegacyShape } from './common';

// A newly observed old-format field cannot be ignored just because its shape kind is known.
const PROPS: Readonly<Record<string, readonly string[]>> = {
    draw: ['segments', 'color', 'fill', 'dash', 'size', 'isComplete', 'isClosed', 'isPen', 'scale', 'scaleX', 'scaleY'],
    highlight: ['segments', 'color', 'size', 'isComplete', 'isPen', 'scale', 'scaleX', 'scaleY'],
    geo: ['geo', 'w', 'h', 'growY', 'color', 'labelColor', 'fill', 'dash', 'size', 'font', 'align', 'verticalAlign', 'richText', 'url', 'scale'],
    text: ['color', 'size', 'w', 'font', 'textAlign', 'autoSize', 'scale', 'richText'],
    note: ['color', 'labelColor', 'size', 'font', 'align', 'verticalAlign', 'richText', 'growY', 'fontSizeAdjustment', 'url', 'scale', 'textLastEditedBy'],
    arrow: ['kind', 'elbowMidPoint', 'bend', 'start', 'end', 'arrowheadStart', 'arrowheadEnd', 'color', 'labelColor', 'fill', 'dash', 'size', 'font', 'richText', 'labelPosition', 'scale'],
    line: ['spline', 'points', 'color', 'dash', 'size', 'scale'],
    frame: ['w', 'h', 'name', 'color'], group: [],
    image: ['w', 'h', 'assetId', 'playing', 'url', 'crop', 'flipX', 'flipY', 'altText'],
    video: ['w', 'h', 'assetId', 'autoplay', 'url', 'altText', 'time', 'playing'],
    bookmark: ['url', 'w', 'h', 'assetId'], embed: ['w', 'h', 'url'],
};
const COMMON = new Set(['id', 'typeName', 'type', 'x', 'y', 'rotation', 'parentId', 'index', 'isLocked', 'opacity', 'meta', 'props']);
export function unknownShapeFields(shape: LegacyShape): readonly string[] {
    return Object.keys(shape.source).filter(key => !COMMON.has(key));
}
export function unknownShapeProperties(shape: LegacyShape): readonly string[] {
    const known = PROPS[shape.type];
    return known ? Object.keys(shape.props).filter(key => !known.includes(key)) : Object.keys(shape.props);
}
