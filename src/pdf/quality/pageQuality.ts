import type { PdfiumJbig2Regions } from '../engine/pdfium/imageRegions.types';
import type { PageTileResult } from '../worker/protocol';
import { Jbig2ImageSampler } from './jbig2';
import type { Jbig2ImageRegion } from './jbig2.types';

export interface PdfPageQualitySnapshot {
    state: 'unknown' | 'clean' | 'degraded';
    complete: boolean;
    reason?: string;
}
export interface PdfPageQuality {
    setRegions(docKey: string, page: number, regions: PdfiumJbig2Regions): void;
    observeTile(docKey: string, page: number, tile: PageTileResult): void;
    snapshot(docKey: string, page: number): PdfPageQualitySnapshot;
    clear(docKey?: string): void;
}

const MAX_PAGES = 256, MAX_REGIONS = 128, MAX_SAMPLERS = 2048;
const GRID_POINTS = 32 * 32;
const WARNING = 'A JBIG2 image may be missing from this page.';
interface PageRecord {
    regions: Jbig2ImageRegion[];
    partial: boolean;
    degraded: boolean;
    profile?: string;
    samplers: Jbig2ImageSampler[];
}

/** Sampling uses only delivered tile interiors; no pixel buffer is retained. */
export function createPdfPageQuality(): PdfPageQuality {
    const pages = new Map<string, Map<number, PageRecord>>();
    let pageCount = 0, samplerCount = 0;
    const validateKey = (docKey: string, page: number) => {
        if (typeof docKey !== 'string' || !docKey || docKey.length > 2048 || !Number.isSafeInteger(page) || page < 0 || page >= 100_000) {
            throw new RangeError('Invalid PDF quality identity');
        }
    };
    const release = (entry: PageRecord) => { samplerCount -= entry.samplers.length; entry.samplers = []; entry.profile = undefined; };
    const lookup = (docKey: string, page: number) => pages.get(docKey)?.get(page);
    return {
        setRegions(docKey, page, value) {
            validateKey(docKey, page);
            if (!value || typeof value.partial !== 'boolean' || !Array.isArray(value.regions) || value.regions.length > 20_000) throw new RangeError('Invalid PDF image regions');
            let group = pages.get(docKey), entry = group?.get(page);
            if (!entry && pageCount >= MAX_PAGES) return;
            const ids = new Set<number>(), regions: Jbig2ImageRegion[] = [];
            for (const candidate of value.regions) {
                if (!candidate || !Number.isSafeInteger(candidate.id) || candidate.id < 0 || ids.has(candidate.id) ||
                    !Array.isArray(candidate.box) || candidate.box.length !== 4 ||
                    candidate.box.some((n: unknown) => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 14_400) ||
                    candidate.box[2] <= candidate.box[0] || candidate.box[3] <= candidate.box[1]) throw new RangeError('Invalid PDF image region');
                ids.add(candidate.id);
                if (regions.length < MAX_REGIONS) regions.push({ id: candidate.id, box: [candidate.box[0], candidate.box[1], candidate.box[2], candidate.box[3]] });
            }
            if (!group) { group = new Map(); pages.set(docKey, group); }
            if (!entry) { entry = { regions: [], partial: false, degraded: false, samplers: [] }; group.set(page, entry); pageCount++; }
            release(entry);
            entry.regions = regions;
            entry.partial = value.partial || value.regions.length > MAX_REGIONS;
        },
        observeTile(docKey, page, tile) {
            validateKey(docKey, page);
            const entry = lookup(docKey, page);
            if (!entry || !entry.regions.length) return;
            if (!tile || tile.docKey !== docKey || tile.page !== page || !Number.isFinite(tile.scale) || tile.scale <= 0 ||
                (tile.variant !== 'plain' && tile.variant !== 'emphasis') || typeof tile.profileKey !== 'string' || tile.profileKey.length > 2048) {
                throw new RangeError('Invalid PDF quality tile');
            }
            const profile = JSON.stringify([tile.variant, tile.profileKey, tile.scale, tile.annotations, tile.forms,
                tile.variant === 'emphasis' ? [tile.emphasis.algorithm, tile.emphasis.revision, tile.emphasis.strokeEm, tile.emphasis.locale ?? null] : null]);
            if (entry.profile !== profile) {
                release(entry);
                if (samplerCount + entry.regions.length > MAX_SAMPLERS) return;
                entry.samplers = entry.regions.map(region => new Jbig2ImageSampler(`page:${page}:region:${region.id}`, region, tile.scale));
                samplerCount += entry.samplers.length;
                entry.profile = profile;
            }
            for (const sampler of entry.samplers) {
                sampler.add(tile);
                const visible: [number, number, number, number] = [tile.rect.x / tile.scale, tile.rect.y / tile.scale,
                    (tile.rect.x + tile.rect.w) / tile.scale, (tile.rect.y + tile.rect.h) / tile.scale];
                if (sampler.status(visible).state === 'suspect' || sampler.status(sampler.region.box).state === 'suspect') entry.degraded = true;
            }
        },
        snapshot(docKey, page) {
            validateKey(docKey, page);
            const entry = lookup(docKey, page);
            if (!entry) return { state: 'unknown', complete: false };
            const complete = !entry.partial && (entry.regions.length === 0 ||
                entry.samplers.length === entry.regions.length && entry.samplers.every(sampler => sampler.status(sampler.region.box).covered === GRID_POINTS));
            if (entry.degraded) return { state: 'degraded', complete, reason: WARNING };
            return complete ? { state: 'clean', complete: true } : { state: 'unknown', complete: false };
        },
        clear(docKey) {
            if (docKey === undefined) { pages.clear(); pageCount = 0; samplerCount = 0; return; }
            const group = pages.get(docKey);
            if (!group) return;
            for (const entry of group.values()) release(entry);
            pageCount -= group.size;
            pages.delete(docKey);
        },
    };
}
