/** Every build carries the engine; this asks only whether this browser can run it. Runtime integrity/containment
 * failures remain EngineBroken, never permission to fall back to a different parser automatically. */
export function pdfEngineAvailableInBuild(): boolean {
    return typeof Worker !== 'undefined' && typeof MessageChannel !== 'undefined' &&
        typeof WebAssembly !== 'undefined' && typeof WebAssembly.compileStreaming === 'function' &&
        typeof crypto !== 'undefined' && !!crypto.subtle;
}
