import { fitWidthZ, type CameraController, type ViewportInsets } from '../../platform/render/camera';
import { NOTEBOOK_INSETS, PDF_INK_INSETS } from '../host/pagedView';
import type { BoardDoc } from '../model/doc';
import { boardPageStack } from '../model/pages';

const STEPS = [.05, .1, .25, .5, 1, 2, 4, 8] as const;
export function boardCameraInsets(doc: BoardDoc): Readonly<ViewportInsets> {
    return doc.kind === 'notebook' ? NOTEBOOK_INSETS : doc.kind === 'pdf-ink' ? PDF_INK_INSETS
        : { left: 0, right: 0, top: 0, bottom: 0 };
}
export function boardZoomBase(doc: BoardDoc, camera: CameraController): number {
    const stack = boardPageStack(doc.host);
    if (!stack) return 1;
    const value = fitWidthZ(camera.viewport, stack, boardCameraInsets(doc));
    return Number.isFinite(value) && value > 0 ? value : 1;
}
export function stepBoardZoom(doc: BoardDoc, camera: CameraController, direction: -1 | 1): number {
    const unit = boardZoomBase(doc, camera), relative = camera.camera.z / unit;
    let nearest = 0;
    for (let i = 1; i < STEPS.length; i++) {
        if (relative >= (STEPS[i - 1] + STEPS[i]) / 2) nearest = i;
        else break;
    }
    const rung = STEPS[Math.max(0, Math.min(STEPS.length - 1, nearest + direction))] * unit;
    return direction > 0 ? Math.max(rung, camera.camera.z) : Math.min(rung, camera.camera.z);
}
export function resetBoardZoom(doc: BoardDoc, camera: CameraController): number {
    const unit = boardZoomBase(doc, camera);
    return doc.kind === 'whiteboard' || Math.abs(camera.camera.z - unit) <= Math.max(1e-6, unit * .001) ? 1 : unit;
}
