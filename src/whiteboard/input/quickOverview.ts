import { surfaceToWorld } from '../../platform/render/camera';
import type { ZoomBrushContext, ZoomCamera, ZoomPoint } from './zoomBrush';

/** The overview zooms out by the same step as the brush's Alt-click, so both zoom-outs feel alike. */
const OVERVIEW_FACTOR = 0.5;

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
    const z = ctx.clampZoom(camera.z * OVERVIEW_FACTOR);
    const centre = surfaceToWorld({ x: viewport.width / 2, y: viewport.height / 2 }, camera);
    const overview = { x: centre.x - viewport.width / 2 / z, y: centre.y - viewport.height / 2 / z, z };
    this.state = {
      entry: { camera: { ...camera }, width: viewport.width, height: viewport.height },
      overview, ratio: z / camera.z,
      pointer: this.pointer ?? { x: viewport.width / 2, y: viewport.height / 2 },
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
