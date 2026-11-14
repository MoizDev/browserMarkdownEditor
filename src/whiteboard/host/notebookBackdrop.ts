import type { Rect } from '../../platform/types';
import type { NotebookPaper } from '../../utils/paper';
import type { PaintPathItem } from '../render/paintStream';
import { notebookPaperItems } from './notebookPaper';

/** Backdrop paint has no model nodes; only requested physical pages are generated. */
export function* notebookBackdrop(paper: Readonly<NotebookPaper>, page: number, box: Readonly<Rect>): Generator<PaintPathItem> {
    if (!Number.isSafeInteger(page) || page < 0 || page >= paper.pageCount) throw new RangeError('Invalid notebook page');
    const appearance = `${paper.size}/${paper.orientation}/${paper.ruling}/${paper.spacing}/${paper.margin}`;
    let part = 0;
    for (const item of notebookPaperItems(paper)) {
        if (item.kind !== 'path') throw new Error('Notebook paper must be procedural paths');
        const index = part++;
        const stroke = item.stroke;
        yield {
            kind: 'path', key: `paper/${page}/${index}`, nodeId: `paper/${page}`,
            geometryKey: `paper/${appearance}/${index}`,
            localToWorld: [1, 0, 0, 1, box.x, box.y], clips: [], d: item.d,
            fillRule: item.fillRule ?? 'nonzero', material: {
                blend: item.blend ?? 'normal', fill: item.fill,
                stroke: stroke && { color: stroke.color, width: stroke.width, cap: stroke.cap,
                    join: stroke.join, miterLimit: stroke.miterLimit ?? 10,
                    dash: stroke.dash?.length ? { array: stroke.dash, phase: stroke.dashPhase ?? 0 } : undefined },
            },
        };
    }
}
