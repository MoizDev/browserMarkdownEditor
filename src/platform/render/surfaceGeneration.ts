// Shared by every backend: mirror admissions cannot alias another instance or backing resize.
let nextGeneration = 1;

export function allocateSurfaceGeneration(): number {
    if (!Number.isSafeInteger(nextGeneration)) throw new RangeError('Surface generation exhausted');
    return nextGeneration++;
}
