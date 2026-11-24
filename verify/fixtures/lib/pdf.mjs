import { PDFDocument, PDFHexString } from 'pdf-lib';
import { sha256 } from './output.mjs';
export const PDF_EPOCH = '2000-01-01T00:00:00.000Z';
export function pinPdfMetadata(document, { id, version = 1, seed }) {
    if (!id || !Number.isInteger(version) || !Number.isInteger(seed))
        throw new Error('PDF identity requires id, version and seed');
    const digest = sha256(`${id}\n${version}\n${seed}\n`).slice(0, 32);
    document.setCreationDate(new Date(PDF_EPOCH));
    document.setModificationDate(new Date(PDF_EPOCH));
    document.setProducer('Browser fixture writer v1 / pdf-lib 1.17.1');
    document.setCreator('Reproducible browser inputs');
    document.setTitle(id);
    document.context.trailerInfo.ID = document.context.obj([
        PDFHexString.of(digest), PDFHexString.of(digest),
    ]);
    // Embedded font/image resource names use this PRNG, separate from fixture content randomness.
    document.context.rng.seed = seed;
    return document;
}
export async function createDeterministicPdf(identity) {
    return pinPdfMetadata(await PDFDocument.create({ updateMetadata: false }), identity);
}
export async function loadDeterministicPdf(bytes, identity) {
    const document = await PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: Infinity });
    return pinPdfMetadata(document, identity);
}
export async function saveDeterministicPdf(document, identity) {
    pinPdfMetadata(document, identity);
    return document.save({ useObjectStreams: false, objectsPerTick: Infinity, addDefaultPage: false });
}
