import type { FontSpec } from '../types';

/** Only one native operation may own the synchronous callback scope at a time. */
export interface PdfiumFontBridge {
    begin(): void;
    end(): { missing: FontSpec[]; failure?: Error };
    close(): void;
}
