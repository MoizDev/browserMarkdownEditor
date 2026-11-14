import { EMPHASIS_ALGORITHM, EMPHASIS_MAX_PROBE_PIXELS, EMPHASIS_PROBE_PROFILE, EMPHASIS_REVISION, EMPHASIS_STROKE_EM } from '../emphasis/profile';
import type { PageProbeArgs, PageProbeResult, ProbeReason } from '../emphasis/types';
import { RENDER_ENGINE_LIMITS, WRITER_ENGINE_LIMITS } from '../engine/types';
import type { BackendInfo } from '../engine/types';
import type { EngineInitArgs, PdfResult, PdfWorkerStats } from '../worker/protocol';
import { boolean, finite, integer, invalidPdfReply, record, text } from './validationCommon';

const PDFIUM_VERSION = '6688c576fd851f4159c6fae39396da50939de110';
const FEATURES: readonly BackendInfo['features'][number][] = ['forms', 'emphasis', 'structTree', 'outline', 'attachments', 'write'];

export function validatePdfEngineInit(value: unknown, expected: EngineInitArgs): PdfResult<'engine.init'> {
    const o = record(value, ['engine', 'version', 'artifactSha256', 'buildId', 'features', 'initMs', 'heapBytes']);
    if (o.engine !== 'pdfium' || o.version !== PDFIUM_VERSION || o.artifactSha256 !== expected.artifactSha256 || o.buildId !== expected.buildId ||
        !/^[a-f0-9]{64}$/.test(expected.artifactSha256) || !/^(?:dev-)?[a-f0-9]{64}$/.test(expected.buildId)) invalidPdfReply();
    if (!Array.isArray(o.features) || o.features.length > FEATURES.length) invalidPdfReply();
    const seen = new Set<string>(), features: BackendInfo['features'] = [];
    for (const item of o.features) {
        if (typeof item !== 'string' || !FEATURES.includes(item as BackendInfo['features'][number]) ||
            seen.has(item) || expected.role === 'render' && item === 'write') invalidPdfReply();
        seen.add(item); features.push(item as BackendInfo['features'][number]);
    }
    const roleLimit = expected.role === 'writer' ? WRITER_ENGINE_LIMITS.maxHeapBytes : RENDER_ENGINE_LIMITS.maxHeapBytes;
    const maxHeap = integer(expected.limits.maxHeapBytes, 1, roleLimit);
    return { engine: 'pdfium', version: PDFIUM_VERSION, artifactSha256: expected.artifactSha256, buildId: expected.buildId,
        features, initMs: finite(o.initMs, 0, 120_000), heapBytes: integer(o.heapBytes, 0, maxHeap) };
}

export function validatePdfWorkerStats(value: unknown, role: 'render' | 'writer' = 'render'): PdfWorkerStats {
    const o = record(value, ['heapBytes', 'docs', 'pagesLoaded', 'blockCacheBytes']);
    if (role !== 'render' && role !== 'writer') invalidPdfReply();
    const docs = integer(o.docs, 0, 64), pagesLoaded = integer(o.pagesLoaded, 0, 100_000 * docs);
    const blockCacheBytes = integer(o.blockCacheBytes, 0, docs * 8 * 1024 * 1024);
    return { heapBytes: integer(o.heapBytes, 0, role === 'render' ? RENDER_ENGINE_LIMITS.maxHeapBytes : WRITER_ENGINE_LIMITS.maxHeapBytes),
        docs, pagesLoaded, blockCacheBytes };
}

export function validatePdfProbe(value: unknown, args: PageProbeArgs): PageProbeResult {
    if (args.algorithm !== EMPHASIS_ALGORITHM || args.revision !== EMPHASIS_REVISION || args.strokeEm !== EMPHASIS_STROKE_EM ||
        typeof args.profileKey !== 'string' || !args.profileKey || args.profileKey.length > 1024) invalidPdfReply();
    const budget = Math.min(integer(args.maxPixels, 1, EMPHASIS_MAX_PROBE_PIXELS), 1_000_000);
    const o = record(value, ['complete', 'candidates', 'eligibleGlyphs', 'changedPixels', 'capability', 'reason', 'probe']);
    if (o.complete !== true) invalidPdfReply();
    const p = record(o.probe, ['profile', 'scale', 'w', 'h', 'rendered']);
    if (p.profile !== EMPHASIS_PROBE_PROFILE) invalidPdfReply();
    const scale = finite(p.scale, Number.MIN_VALUE, 1.5), w = integer(p.w, 1, RENDER_ENGINE_LIMITS.maxTileEdge - 2),
        h = integer(p.h, 1, RENDER_ENGINE_LIMITS.maxTileEdge - 2), rendered = boolean(p.rendered);
    const pixels = w * h;
    if (!Number.isSafeInteger(pixels) || pixels > budget) invalidPdfReply();
    const candidates = integer(o.candidates, 0, RENDER_ENGINE_LIMITS.maxChars),
        eligibleGlyphs = integer(o.eligibleGlyphs, 0, RENDER_ENGINE_LIMITS.maxChars), changedPixels = integer(o.changedPixels, 0, pixels);
    const capability = o.capability;
    if (capability !== 'supported' && capability !== 'unavailable') invalidPdfReply();
    const reason = o.reason === undefined ? undefined : text(o.reason, 64);
    if (reason !== undefined && reason !== 'no-text' && reason !== 'no-eligible-prefixes' && reason !== 'ambiguous-glyphs' && reason !== 'no-visible-change') invalidPdfReply();
    if (eligibleGlyphs > 0 && candidates === 0 || rendered !== (eligibleGlyphs > 0) ||
        capability === 'supported' && (!changedPixels || !rendered || reason !== undefined) ||
        capability === 'unavailable' && (changedPixels !== 0 || reason === undefined) ||
        reason === 'no-text' && (candidates !== 0 || eligibleGlyphs !== 0) ||
        (reason === 'no-eligible-prefixes' || reason === 'ambiguous-glyphs') && eligibleGlyphs !== 0 ||
        reason === 'no-visible-change' && !rendered || rendered && reason !== undefined && reason !== 'no-visible-change' ||
        !rendered && reason === 'no-visible-change') invalidPdfReply();
    return { complete: true, candidates, eligibleGlyphs, changedPixels, capability,
        ...(reason !== undefined ? { reason: reason as ProbeReason } : {}), probe: { profile: EMPHASIS_PROBE_PROFILE, scale, w, h, rendered } };
}
