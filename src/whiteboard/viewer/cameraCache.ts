/** The camera fields an overlay compares frame to frame. */
export interface CameraNumbers { readonly x: number; readonly y: number; readonly z: number }

/**
 * Whether `camera` differs from the one last written into `cache` (three floats, NaN until written), and writes it.
 * The comparison is on numbers: a string key built per frame was the only per-frame allocation in these overlays.
 */
export function cameraChanged(cache: Float64Array, camera: CameraNumbers): boolean {
    if (cache[0] === camera.x && cache[1] === camera.y && cache[2] === camera.z) return false;
    cache[0] = camera.x; cache[1] = camera.y; cache[2] = camera.z;
    return true;
}

/** Forgets the cached camera, so the next frame rebuilds. */
export function forgetCamera(cache: Float64Array): void {
    cache.fill(Number.NaN);
}
