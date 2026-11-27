export interface CameraNumbers { readonly x: number; readonly y: number; readonly z: number }

export function cameraChanged(cache: Float64Array, camera: CameraNumbers): boolean {
    if (cache[0] === camera.x && cache[1] === camera.y && cache[2] === camera.z) return false;
    cache[0] = camera.x; cache[1] = camera.y; cache[2] = camera.z;
    return true;
}

export function forgetCamera(cache: Float64Array): void {
    cache.fill(Number.NaN);
}
