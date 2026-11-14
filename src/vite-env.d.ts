/// <reference types="vite/client" />

/** True only in `vite build --mode benchmark` (vite.config.ts). Measurement hooks
 *  (contracts C9) live behind it, so the production build carries none of them. */
declare const __BME_BENCH__: boolean
declare const __BME_BUILD_ID__: string
/** Whether this build may load its pinned PDF engine; host support is checked separately. */
declare const __BME_PDF_ENGINE_AVAILABLE__: boolean
