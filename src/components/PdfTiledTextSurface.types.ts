import type { PdfTiledSource } from './PdfTiledView';
import type { PdfReadingBinding } from '../types/reading';
import type { PdfFindMemory } from '../utils/pdfFindHighlight';
import type { PdfTextAnchor, PdfTextReader } from '../utils/pdfReadingText';
import type { PdfViewPos } from '../utils/pdfViewState';
import type { PdfReadingTextProps } from './PdfReadingText';

export interface PdfTiledTextSurfaceProps extends Pick<PdfReadingTextProps,
    'isVisible' | 'isFocused' | 'expectedPageDigest' | 'sameSchema' | 'restorationNotice' |
    'onShowOriginalPage' | 'onShowOriginal' | 'onLocation' | 'onTextQuality'> {
    source: PdfTiledSource;
    reading?: PdfReadingBinding;
    filePath: string;
    findMemory: PdfFindMemory;
    checkpoint: PdfViewPos;
    /** Omit for a fresh Original-to-Text mapping; provide for restoration. */
    anchor?: PdfTextAnchor;
    /** Lets the pane map back from Text without taking ownership of the reader. */
    onReader?(reader: PdfTextReader | undefined): void;
}
