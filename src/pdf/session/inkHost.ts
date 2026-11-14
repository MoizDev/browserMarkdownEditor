import type { PageGeometry } from '../../platform/types';
import { parseJson } from '../../whiteboard/format/jsonRead';
import type { JsonSpan } from '../../whiteboard/format/jsonRead';
import type { HostBlock } from '../../whiteboard/model/doc';
import type { RawJson } from '../../whiteboard/model/json';
import { newPdfWriteId } from '../writing/writeIdentity';
import { acquirePdfInkSource } from './inkAcquisition';
import type { PdfEditableInkSource, PdfInkAcquisition, PdfInkAcquisitionOptions } from './inkAcquisition.types';
import type { PdfLegacyConversionReady, PdfRuntimeInkSource } from './legacyInkAcquisition.types';
import { isPreparedPdfLegacyConversion } from './legacyInkAcquisition';
import { isConvertedPdfInkSource } from './convertedInkBrand';

type PdfHost = Extract<HostBlock, { kind: 'pdf-ink' }>;
const HASH = /^[0-9a-f]{64}$/;
const WRITE_ID = /^[0-9a-f]{32}$/;
const conversionHosts = new WeakMap<PdfLegacyConversionReady, WeakSet<object>>();
type SourceBasis = PdfRuntimeInkSource | PdfLegacyConversionReady;
type Migration = { version: 1; legacyOuterFingerprint: string; previousFrames: Array<{ width: number; height: number }> };

function fields(span: JsonSpan, names: readonly string[], optional: readonly string[] = []): ReadonlyMap<string, JsonSpan> {
    const result = new Map<string, JsonSpan>();
    for (const [name, value] of span.fields()) {
        if ((!names.includes(name) && !optional.includes(name)) || result.has(name)) throw new Error('Unsupported PDF ink metadata');
        result.set(name, value);
    }
    if (names.some(name => !result.has(name))) throw new Error('Unsupported PDF ink metadata');
    return result;
}
function items(span: JsonSpan, count: number): JsonSpan[] {
    const result: JsonSpan[] = [];
    for (const value of span.items()) {
        if (result.length >= count) throw new Error('Invalid PDF ink geometry');
        result.push(value);
    }
    if (result.length !== count) throw new Error('Invalid PDF ink geometry');
    return result;
}
function pageMatches(span: JsonSpan, page: Readonly<PageGeometry>, index: number): boolean {
    const f = fields(span, ['index', 'width', 'height', 'rotate', 'userUnit', 'toUserSpace']);
    const affine = items(f.get('toUserSpace')!, 6);
    return page.index === index && f.get('index')!.number() === index && f.get('width')!.number() === page.width &&
        f.get('height')!.number() === page.height && f.get('rotate')!.number() === page.rotate &&
        f.get('userUnit')!.number() === page.userUnit && page.toUserSpace.length === 6 &&
        affine.every((value, i) => value.number() === page.toUserSpace[i]);
}
function migrationValue(span: JsonSpan, pages: readonly Readonly<PageGeometry>[]): Migration {
    const value = fields(span, ['version', 'legacyOuterFingerprint', 'previousFrames']);
    const fingerprint = value.get('legacyOuterFingerprint')!.string(64);
    if (value.get('version')!.number() !== 1 || !HASH.test(fingerprint)) throw new Error('Invalid PDF migration metadata');
    const previousFrames = items(value.get('previousFrames')!, pages.length).map((frame, index) => {
        const pair = fields(frame, ['width', 'height']), width = pair.get('width')!.number(), height = pair.get('height')!.number();
        const page = pages[index];
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
            !Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0 ||
            Math.abs((width / height) / (page.width / page.height) - 1) > 0.005) throw new Error('PDF migration frames do not match');
        return { width, height };
    });
    return { version: 1, legacyOuterFingerprint: fingerprint, previousFrames };
}
function validHost(acq: SourceBasis, host: HostBlock, loaded: boolean): host is PdfHost {
    try {
        if (!acq.isCurrent() || (acq.kind === 'legacy-conversion' && !isPreparedPdfLegacyConversion(acq)) ||
            (acq.kind === 'legacy-converted' && !isConvertedPdfInkSource(acq)) ||
            host.kind !== 'pdf-ink' || !HASH.test(acq.source.pristineFingerprint) ||
            !acq.pages.length || acq.pages.length > 65_536 || host.pages.length !== acq.pages.length ||
            host.ext?.raw.has('pdf') || host.ext?.raw.has('pages')) return false;
        const metadata = fields(parseJson(host.pdf), ['schema', 'sourceFingerprint', 'geometryEngine', 'pages', 'writeId'], ['migration']);
        const migration = metadata.has('migration') ? migrationValue(metadata.get('migration')!, acq.pages) : undefined;
        const writeId = metadata.get('writeId')!.string(32);
        if ((acq.kind === 'legacy-conversion' || acq.kind === 'legacy-converted') &&
            (!migration || migration.legacyOuterFingerprint !== acq.legacyOriginalSha256 || acq.source.outerFingerprint !== acq.legacyOriginalSha256)) return false;
        if (acq.kind === 'legacy-converted' && (!migration || writeId !== acq.legacyMigration.writeId ||
            migration.previousFrames.length !== acq.legacyMigration.previousFrames.length ||
            migration.previousFrames.some((frame, i) => frame.width !== acq.legacyMigration.previousFrames[i].width ||
                frame.height !== acq.legacyMigration.previousFrames[i].height))) return false;
        if (metadata.get('schema')!.number() !== 1 || metadata.get('sourceFingerprint')!.string(64) !== acq.source.pristineFingerprint) return false;
        const engine = fields(metadata.get('geometryEngine')!, ['id', 'build', 'generation']), expected = acq.source.geometryEngine;
        if (engine.get('id')!.string(128) !== expected.id || engine.get('build')!.string(256) !== expected.build ||
            engine.get('generation')!.number() !== expected.generation) return false;
        if (!WRITE_ID.test(writeId) || (loaded && acq.kind === 'native' && writeId !== acq.writeId)) return false;
        const pages = items(metadata.get('pages')!, acq.pages.length);
        return pages.every((value, index) => {
            const page = acq.pages[index], size = host.pages[index];
            return size.length === 2 && Number.isFinite(page.width) && page.width > 0 && page.width <= 14_400 &&
                Number.isFinite(page.height) && page.height > 0 && page.height <= 14_400 &&
                size[0] === page.width && size[1] === page.height && pageMatches(value, page, index);
        });
    } catch { return false; }
}
function metadata(acq: SourceBasis, writeId: string, migration?: Migration): RawJson {
    const engine = acq.source.geometryEngine;
    const json = JSON.stringify({ schema: 1, sourceFingerprint: acq.source.pristineFingerprint,
        geometryEngine: { id: engine.id, build: engine.build, generation: engine.generation },
        pages: acq.pages.map(page => ({ index: page.index, width: page.width, height: page.height, rotate: page.rotate,
            userUnit: page.userUnit, toUserSpace: [...page.toUserSpace] })), writeId, ...(migration ? { migration } : {}) });
    return parseJson(json).raw();
}

/** Historical metadata is not permission to convert or overwrite the original. */
export function readPdfInkLegacyDigest(acq: PdfEditableInkSource, host: HostBlock): string | null {
    if (acq.kind !== 'native' || !validHost(acq, host, true)) throw new Error('A current, validated native PDF ink host is required');
    const value = fields(parseJson(host.pdf), ['schema', 'sourceFingerprint', 'geometryEngine', 'pages', 'writeId'], ['migration']);
    const migration = value.get('migration');
    return migration ? migrationValue(migration, acq.pages).legacyOuterFingerprint : null;
}

/** Plain PDFs alone may start a new board; native boards must retain their loaded host. */
export function createPdfInkHost(acq: PdfEditableInkSource): PdfHost {
    if (acq.kind !== 'plain' || !acq.isCurrent()) throw new Error('A current plain PDF is required for a new ink board');
    const host: PdfHost = { kind: 'pdf-ink', pdf: metadata(acq, newPdfWriteId()),
        pages: acq.pages.map(page => [page.width, page.height] as const), ext: null };
    if (!validHost(acq, host, false)) throw new Error('Invalid PDF ink host geometry');
    return host;
}

export function createPdfInkConversionHost(acq: PdfLegacyConversionReady, previousFrames: readonly { width: number; height: number }[]): PdfHost {
    if (acq.kind !== 'legacy-conversion' || !isPreparedPdfLegacyConversion(acq) || !acq.isCurrent() || !HASH.test(acq.legacyOriginalSha256) ||
        acq.source.outerFingerprint !== acq.legacyOriginalSha256 ||
        !Array.isArray(previousFrames) || previousFrames.length !== acq.pages.length) throw new Error('A prepared legacy PDF conversion is required');
    const migration = migrationValue(parseJson(JSON.stringify({ version: 1, legacyOuterFingerprint: acq.legacyOriginalSha256, previousFrames })), acq.pages);
    const host: PdfHost = { kind: 'pdf-ink', pdf: metadata(acq, newPdfWriteId(), migration),
        pages: acq.pages.map(page => [page.width, page.height] as const), ext: null };
    if (!validHost(acq, host, false)) throw new Error('Invalid PDF conversion geometry');
    let hosts = conversionHosts.get(acq);
    if (!hosts) { hosts = new WeakSet(); conversionHosts.set(acq, hosts); }
    hosts.add(host);
    return Object.freeze(host);
}

/** Final conversion hosts must retain the prepared source's migration identity. */
export function validatePdfInkConversionHost(acq: PdfLegacyConversionReady, host: HostBlock): boolean {
    return !!conversionHosts.get(acq)?.has(host) && validHost(acq, host, false);
}

/** Unknown PDF-owned schema or fields cannot be preserved by this writer. */
export function validateLoadedPdfInkHost(acq: PdfRuntimeInkSource, host: HostBlock): boolean {
    return validHost(acq, host, true);
}

/** Pin once per frozen build job; neither the live host nor opaque extensions are modified. */
export function pinPdfInkHostForSave(acq: SourceBasis, host: HostBlock): { host: PdfHost; writeId: string } {
    if (!validHost(acq, host, false) || acq.kind === 'legacy-conversion' && !conversionHosts.get(acq)?.has(host)) throw new Error('PDF ink host no longer matches its source');
    const writeId = newPdfWriteId(), span = parseJson(host.pdf).fieldMap().get('migration');
    const migration = span ? migrationValue(span, acq.pages) : undefined;
    return { host: { ...host, pdf: metadata(acq, writeId, migration) }, writeId };
}

/** A committed version becomes editable only after the new outer is independently inspected. */
export async function rebindPdfInkSource(options: PdfInkAcquisitionOptions,
    expected: { pristineFingerprint: string; writeId: string }): Promise<PdfInkAcquisition> {
    if (!HASH.test(expected.pristineFingerprint) || !WRITE_ID.test(expected.writeId)) throw new Error('Invalid expected PDF ink identity');
    const result = await acquirePdfInkSource(options);
    let current = !options.signal?.aborted;
    try { current = current && options.isCurrent(); } catch { current = false; }
    if (!current || (result.kind !== 'read-only' && !result.isCurrent())) {
        await result.release();
        throw new DOMException('PDF ink source is no longer current', 'AbortError');
    }
    if (result.kind === 'read-only') return result;
    if (result.kind !== 'native' || result.writeId !== expected.writeId || result.source.pristineFingerprint !== expected.pristineFingerprint) {
        return { kind: 'read-only', reason: 'The saved PDF ink identity could not be verified.', release: result.release };
    }
    return result;
}
