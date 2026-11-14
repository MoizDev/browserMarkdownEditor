/** Build eligibility only. Runtime integrity/containment failures remain EngineBroken,
 * never permission to fall back to a different parser automatically. */
export function pdfEngineAvailableInBuild(): boolean {
    return __BME_PDF_ENGINE_AVAILABLE__ && typeof Worker !== 'undefined' && typeof MessageChannel !== 'undefined' &&
        typeof WebAssembly !== 'undefined' && typeof WebAssembly.compileStreaming === 'function' &&
        typeof crypto !== 'undefined' && !!crypto.subtle;
}
