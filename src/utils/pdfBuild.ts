import { FileEmbedder, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, ParseSpeeds, degrees, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix, setLineJoin, LineJoinStyle } from 'pdf-lib';
import type { PDFPage, PDFImage } from 'pdf-lib';
import { NOTEBOOK_SOURCE_ATTACHMENT, type NotebookSource } from './pdfFormat';
import { columnOffsets, marginX, paperPageSize, ruleOffsets, type NotebookPaper } from './paper';
import { isEmptyOverlay, type PageOverlay } from './pdfOverlay';
import type { VectorOp } from './pdfVector';
import { PDF_WRITE_MARK_PLACEHOLDER, sealPdfWriteMark } from './pdfWriteMark';
import { PdfBuildRefused, pdfSnapshotRefusal } from './pdfBuildRefusal';
import { rebuildAttachmentTree, verifyAttachmentTree } from './pdfAttachmentTree';
import { artifactHash, immutableArtifact } from './pdfWriteArtifacts';
import { inspectPdfBytesWriteSafety } from './pdfWriteSafety';

export const LOAD_WITHOUT_TICKS = { parseSpeed: ParseSpeeds.Fastest } as const;
export const SAVE_WITHOUT_TICKS = { objectsPerTick: Infinity } as const;

function displaySpace(page: PDFPage) {
    const { width: mW, height: mH } = page.getSize();
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    const quarterTurned = angle === 90 || angle === 270;
    const width = quarterTurned ? mH : mW;
    const height = quarterTurned ? mW : mH;

    const ctm: [number, number, number, number, number, number] =
        angle === 90 ? [0, 1, -1, 0, mW, 0]
            : angle === 180 ? [-1, 0, 0, -1, mW, mH]
                : angle === 270 ? [0, -1, 1, 0, 0, mH]
                    : [1, 0, 0, 1, 0, 0];

    return { angle, width, height, ctm };
}

function stampRaster(page: PDFPage, png: PDFImage): void {
    const { angle, width, height } = displaySpace(page);
    const { width: mW, height: mH } = page.getSize();
    const x = angle === 90 || angle === 180 ? mW : 0;
    const y = angle === 180 || angle === 270 ? mH : 0;
    page.drawImage(png, { x, y, width, height, rotate: degrees(angle) });
}

function stampVector(page: PDFPage, ops: VectorOp[]): void {
    if (!ops.length) return;
    const { height, ctm } = displaySpace(page);

    page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(...ctm),
        setLineJoin(LineJoinStyle.Round),
    );

    for (const op of ops) {
        page.drawSvgPath(op.d, {
            x: op.x,
            y: height - op.y,
            scale: op.scale,
            rotate: degrees(op.rotate),
            // Both keys are always present, even as undefined: pdf-lib tests
            // them with `in`, and adds a black border when NEITHER appears.
            color: op.fill ? rgb(op.fill.r, op.fill.g, op.fill.b) : undefined,
            borderColor: op.stroke ? rgb(op.stroke.r, op.stroke.g, op.stroke.b) : undefined,
            opacity: op.fill && op.fillOpacity < 1 ? op.fillOpacity : undefined,
            borderOpacity: op.stroke && op.strokeOpacity < 1 ? op.strokeOpacity : undefined,
            borderWidth: op.stroke ? op.strokeWidth : 0,
            borderDashArray: op.dash,
            borderLineCap: op.lineCap,
        });
    }

    page.pushOperators(popGraphicsState());
}

export async function buildAnnotatedPdf(
    original: Uint8Array,
    snapshot: string,
    overlays: Array<PageOverlay | undefined> = [],
    outer?: Uint8Array,
): Promise<{ bytes: Uint8Array; aliases: string[] }> {
    const refusal = pdfSnapshotRefusal(snapshot);
    if (refusal) throw new PdfBuildRefused(refusal);
    const originalSafety = await inspectPdfBytesWriteSafety(original);
    if (originalSafety.kind !== 'safe') throw new PdfBuildRefused({ reason: 'unsafe-pdf', safety: originalSafety.kind });
    if (outer) {
        const outerSafety = await inspectPdfBytesWriteSafety(outer);
        if (outerSafety.kind !== 'safe') throw new PdfBuildRefused({ reason: 'unsafe-pdf', safety: outerSafety.kind });
    }
    const doc = await PDFDocument.load(original, LOAD_WITHOUT_TICKS);
    const outerDoc = outer ? await PDFDocument.load(outer, LOAD_WITHOUT_TICKS) : undefined;
    const pages = doc.getPages();

    for (let i = 0; i < pages.length; i++) {
        const overlay = overlays[i];
        if (isEmptyOverlay(overlay)) continue;
        if (!overlay) continue;
        const geometry = overlay.geometry;
        if (!geometry || geometry.pageIndex !== i || !geometry.engine.startsWith('pdfjs/') ||
            ![geometry.width, geometry.height, ...geometry.toUserSpace].every(Number.isFinite) ||
            geometry.width <= 0 || geometry.height <= 0) {
            throw new Error(`Missing or invalid display geometry for PDF page ${i + 1}.`);
        }
        const [a, b, c, d, e, f] = geometry.toUserSpace;
        if (a * d - b * c === 0) throw new Error(`Singular display geometry for PDF page ${i + 1}.`);

        const layers = overlay.layers ?? [overlay];
        const identity: unknown[] = [];
        for (const layer of layers) identity.push([layer.raster?.length ? await artifactHash(layer.raster) : '', layer.vector ?? []]);
        const inkKey = await artifactHash(new TextEncoder().encode(JSON.stringify([
            'ink-form-v2', geometry.width, geometry.height, identity,
        ])));
        const inkBytes = await immutableArtifact(`page:${inkKey}`, async () => {
            const ink = await PDFDocument.create();
            const inkPage = ink.addPage([geometry.width, geometry.height]);
            for (const layer of layers) {
                if (layer.raster?.length) stampRaster(inkPage, await ink.embedPng(layer.raster));
                if (layer.vector?.length) stampVector(inkPage, layer.vector);
            }
            return ink.save(SAVE_WITHOUT_TICKS);
        });
        const [embedded] = await doc.embedPdf(inkBytes, [0]);
        const page = pages[i];
        // pdf-lib normalizes inherited resources in place. Fork both the outer
        // dictionary and its mutable subdictionaries before adding the Form.
        const resources = page.node.Resources()?.clone() ?? doc.context.obj({});
        for (const name of ['Font', 'XObject', 'ExtGState']) {
            const key = PDFName.of(name);
            const entry = resources.lookup(key);
            if (entry instanceof PDFDict) resources.set(key, entry.clone());
        }
        page.node.set(PDFName.of('Resources'), resources);
        page.pushOperators(pushGraphicsState(), concatTransformationMatrix(a, b, -c, -d,
            c * geometry.height + e, d * geometry.height + f));
        page.drawPage(embedded, { x: 0, y: 0, width: geometry.width, height: geometry.height });
        page.pushOperators(popGraphicsState());
    }

    const expected = await rebuildAttachmentTree(doc, outerDoc, original, new TextEncoder().encode(snapshot));

    // Flush deferred attachments/images BEFORE allocating the mark: pdf-lib
    // writes raw streams by object number, so our newest stream follows any
    // earlier literal marker text in the pristine source. Keep other apps'
    // PieceInfo entries; this private stream is not an editable-format marker.
    await doc.flush();
    const existing = doc.catalog.lookup(PDFName.of('PieceInfo'));
    if (existing !== undefined && !(existing instanceof PDFDict)) throw new Error('The PDF PieceInfo dictionary could not be preserved. Nothing was saved.');
    const pieces = existing ? existing.clone() : doc.context.obj({});
    const mark = doc.context.register(doc.context.stream(PDF_WRITE_MARK_PLACEHOLDER));
    pieces.set(PDFName.of('VaultWriteMark'), doc.context.obj({
        LastModified: PDFString.fromDate(new Date()), Private: mark,
    }));
    doc.catalog.set(PDFName.of('PieceInfo'), pieces);
    const result = await sealPdfWriteMark(await doc.save(SAVE_WITHOUT_TICKS));
    await verifyAttachmentTree(result, expected);
    return { bytes: result, aliases: expected.aliases };
}

const RULE_RGB = rgb(0.765, 0.827, 0.910);
const MARGIN_RGB = rgb(0.914, 0.722, 0.741);
const RULE_WIDTH = 0.75;

export async function buildNotebookPdf(
    paper: NotebookPaper,
    overlays: Array<PageOverlay | undefined> = [],
    source?: NotebookSource,
): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const { width, height } = paperPageSize(paper);
    const rules = paper.ruling === 'lined' || paper.ruling === 'grid' ? ruleOffsets(paper) : [];
    const columns = paper.ruling === 'grid' || paper.ruling === 'dotted' ? columnOffsets(paper) : [];
    const dots = paper.ruling === 'dotted' ? ruleOffsets(paper) : [];
    const margin = marginX(paper);

    for (let i = 0; i < paper.pageCount; i++) {
        const page = doc.addPage([width, height]);

        for (const y of rules) {
            page.drawLine({ start: { x: 0, y: height - y }, end: { x: width, y: height - y }, thickness: RULE_WIDTH, color: RULE_RGB });
        }
        if (paper.ruling === 'grid') {
            for (const x of columns) {
                page.drawLine({ start: { x, y: 0 }, end: { x, y: height }, thickness: RULE_WIDTH, color: RULE_RGB });
            }
        }
        for (const y of dots) {
            for (const x of columns) {
                page.drawCircle({ x, y: height - y, size: 1.1, color: RULE_RGB });
            }
        }
        if (margin !== null) {
            page.drawLine({ start: { x: margin, y: 0 }, end: { x: margin, y: height }, thickness: 1, color: MARGIN_RGB });
        }

        const overlay = overlays[i];
        if (!overlay) continue;
        for (const layer of overlay.layers ?? [overlay]) {
            if (layer.raster?.length) stampRaster(page, await doc.embedPng(layer.raster.slice()));
            if (layer.vector?.length) stampVector(page, layer.vector);
        }
    }

    if (source) {
        const marker = 'local-vault-pdf/v1;role=notebook-source;format=notebook-source';
        const ref = await FileEmbedder.for(new TextEncoder().encode(JSON.stringify(source)), NOTEBOOK_SOURCE_ATTACHMENT, {
            mimeType: 'application/json',
            description: `${marker}\nThe notebook this PDF was exported from. Edit that, then export again.`,
        }).embedIntoContext(doc.context);
        doc.catalog.set(PDFName.of('Names'), doc.context.obj({ EmbeddedFiles: { Names: [PDFHexString.fromText(NOTEBOOK_SOURCE_ATTACHMENT), ref] } }));
        doc.catalog.set(PDFName.of('AF'), doc.context.obj([ref]));
        doc.setProducer(`Exported from ${source.path}`);
    }

    return doc.save(SAVE_WITHOUT_TICKS);
}
