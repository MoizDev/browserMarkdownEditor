import type { Camera, Viewport } from '../../platform/types';

export interface AgentDrawingCamera {
    readonly camera: { readonly x: number; readonly y: number; readonly z: number };
    readonly viewport: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

// C8: the agent camera translates world coordinates before zoom; the platform
// camera is the world point under surface (0,0). The viewport itself stays in
// world coordinates, not device pixels or camera translation coordinates.
export function agentDrawingCamera(camera: Camera, viewport: Viewport): AgentDrawingCamera {
    if (!Number.isFinite(camera.x) || !Number.isFinite(camera.y) || !Number.isFinite(camera.z) || camera.z <= 0
        || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width < 0 || viewport.height < 0) {
        throw new RangeError('Invalid board camera or viewport');
    }
    const w = viewport.width / camera.z, h = viewport.height / camera.z;
    if (!Number.isFinite(w) || !Number.isFinite(h)) throw new RangeError('Board viewport exceeds finite world coordinates');
    return { camera: { x: -camera.x, y: -camera.y, z: camera.z },
        viewport: { x: camera.x, y: camera.y, w, h } };
}
