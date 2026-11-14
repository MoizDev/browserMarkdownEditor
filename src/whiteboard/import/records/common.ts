import { isValidId, nodeId, type ParentId } from '../../model/ids';
import type { NodeBase } from '../../model/nodes';
import type { ReportBuilder } from '../report';
import { preserveMetadata } from './sheets';
import { object, type LegacyObject } from './envelope';

export interface LegacyShape {
    readonly id: string;
    readonly type: string;
    readonly parentId: string;
    readonly index: string;
    readonly x: number;
    readonly y: number;
    readonly rotation: number;
    readonly locked: boolean;
    readonly opacity: number;
    readonly meta: LegacyObject;
    readonly props: LegacyObject;
}
export function readShape(record: LegacyObject, report: ReportBuilder): LegacyShape {
    const { id, type, parentId, index, x, y, rotation, isLocked, opacity } = record;
    const meta = object(record.meta), props = object(record.props);
    if (record.typeName !== 'shape' || typeof id !== 'string' || !isValidId(id)
        || typeof type !== 'string' || typeof parentId !== 'string' || !isValidId(parentId)
        || typeof index !== 'string' || typeof x !== 'number' || typeof y !== 'number'
        || typeof rotation !== 'number' || typeof isLocked !== 'boolean' || typeof opacity !== 'number'
        || !meta || !props) throw new Error('Invalid shape record');
    const positionValid = Number.isFinite(x) && Number.isFinite(y);
    if (!positionValid) report.repair(id, 'Non-finite position reset to the origin');
    if (!Number.isFinite(rotation)) report.repair(id, 'Non-finite rotation reset');
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) report.repair(id, 'Opacity clamped');
    return { id, type, parentId, index, x: positionValid ? x : 0, y: positionValid ? y : 0,
        rotation: Number.isFinite(rotation) ? rotation : 0, locked: isLocked,
        opacity: Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1, meta, props };
}

export function shapeBase(shape: LegacyShape, page: number): NodeBase {
    const angle = ((shape.rotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return { id: nodeId(shape.id), kind: 'opaque', parent: shape.parentId as ParentId, order: shape.index,
        page, x: shape.x, y: shape.y, rotation: angle, locked: shape.locked, opacity: shape.opacity,
        ext: preserveMetadata(shape.meta, shape.type === 'image' ? new Set(['inverted']) : new Set()) };
}

export type BackdropResult = 'backdrop' | 'ordinary' | 'ambiguous';
export function backdropRole(shape: LegacyShape, kind: 'whiteboard' | 'notebook' | 'pdf-ink'): BackdropResult {
    if (kind === 'whiteboard' || shape.type !== 'image') return 'ordinary';
    const prefix = kind === 'notebook' ? 'shape:notebook-page-' : 'shape:pdf-page-';
    const suffix = shape.id.startsWith(prefix) ? shape.id.slice(prefix.length) : '';
    const index = /^\d+$/.test(suffix) ? Number(suffix) : -1;
    const metadata = kind === 'notebook' ? shape.meta.notebookPage : shape.meta.pdfPage;
    const asset = kind === 'notebook' ? 'asset:notebook-paper' : `asset:pdf-page-${index}`;
    const named = index >= 0 && Number.isSafeInteger(index);
    const correctAsset = named && shape.props.assetId === asset;
    if (named && correctAsset && shape.locked) return 'backdrop';
    return named || metadata !== undefined || (kind === 'notebook' && shape.props.assetId === asset)
        ? 'ambiguous' : 'ordinary';
}
