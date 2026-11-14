/** Installed native callbacks live until the owning PDFium library is destroyed. */
export interface PdfiumFontBridge { close(): void }
