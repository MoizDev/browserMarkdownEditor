import { surfaceToWorld } from '../../platform/render/camera';
import type { ZoomBrushContext, ZoomCamera, ZoomPoint } from './zoomBrush';

/** The overview fits the viewport and the sheet's content together, then steps out a little more for breathing room
 * (catalogue T§4: the target zoom times 0.85, ZoomQuick.ts:34-59). */
const OVERVIEW_FACTOR = 0.85;

interface OverviewState {
  readonly entry: { readonly camera: ZoomCamera; readonly width: number; readonly height: number };
  readonly overview: ZoomCamera;
  readonly ratio: number;
  pointer: ZoomPoint;
}

/** F-TOOL-009 quick overview: Shift pressed while Z is held zooms out and shows the rectangle the entering view
 * covers at the pointer. The overview camera stays fixed while that rectangle follows the pointer. Leaving (Shift
 * or Z released, pointer pressed, focus lost) lands the entering zoom on the rectangle; Escape returns to the
 * entering view. Only the camera moves here: an overview never writes content, so it adds no undo step. */
export class QuickOverview {
  private state: OverviewState | null = null;
  private pointer: ZoomPoint | null = null;

  constructor(private readonly zoom: () => ZoomBrushContext) {}

  get active(): boolean { return this.state !== null; }

  /** Every pointer move: remembers the spot a later entry starts from, and moves the destination while overviewing. */
  track(point: ZoomPoint | null): void {
    this.pointer = point;
    if (this.state && point) { this.state.pointer = point; this.draw(); }
  }

  enter(): void {
    if (this.state) return;
    const ctx = this.zoom();
    const { camera, viewport } = ctx.view();
    if (!(viewport.width > 0 && viewport.height > 0)) return;
    // The union of what is on screen and the sheet's content (read ahead on Z's press, so this stays synchronous).
    const topLeft = surfaceToWorld({ x: 0, y: 0 }, camera), bottomRight = surfaceToWorld({ x: viewport.width, y: viewport.height }, camera);
    let x0 = topLeft.x, y0 = topLeft.y, x1 = bottomRight.x, y1 = bottomRight.y;
    const content = ctx.overviewBox?.() ?? null;
    if (content) { x0 = Math.min(x0, content.x); y0 = Math.min(y0, content.y); x1 = Math.max(x1, content.x + content.width); y1 = Math.max(y1, content.y + content.height); }
    const fit = Math.min(viewport.width / (x1 - x0), viewport.height / (y1 - y0));
    if (!(fit > 0 && Number.isFinite(fit))) return;
    const z = ctx.clampZoom(fit * OVERVIEW_FACTOR);
    // The zoom is cursor-anchored (catalogue T§4, ZoomQuick): the world point under the pointer on entry stays under it, so the
    // overview zooms about the pointer rather than about the content's centre.
    const pointer = this.pointer ?? { x: viewport.width / 2, y: viewport.height / 2 };
    const anchor = surfaceToWorld(pointer, camera);
    const overview = { x: anchor.x - pointer.x / z, y: anchor.y - pointer.y / z, z };
    this.state = {
      entry: { camera: { ...camera }, width: viewport.width, height: viewport.height },
      overview, ratio: z / camera.z, pointer,
    };
    ctx.setCamera(overview);
    this.draw();
  }

  /** Lands the entering zoom on the previewed destination; the overview ends and the zoom state stays with the caller. */
  leave(): void {
    const state = this.state;
    if (!state) return;
    this.state = null;
    const ctx = this.zoom();
    ctx.clearPreview();
    const world = surfaceToWorld(state.pointer, state.overview);
    const z = state.entry.camera.z;
    ctx.setCamera({ x: world.x - state.entry.width / 2 / z, y: world.y - state.entry.height / 2 / z, z });
  }

  /** Escape: back to the entering view exactly. */
  escape(): void {
    const state = this.state;
    if (!state) return;
    this.state = null;
    const ctx = this.zoom();
    ctx.clearPreview();
    ctx.setCamera({ ...state.entry.camera });
  }

  private draw(): void {
    const state = this.state;
    if (!state) return;
    const width = state.entry.width * state.ratio, height = state.entry.height * state.ratio;
    this.zoom().preview({ x: state.pointer.x - width / 2, y: state.pointer.y - height / 2, width, height });
  }
}
